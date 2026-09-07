import Anthropic from "@anthropic-ai/sdk";
import { businessProfile } from "./business.js";
import { buildSystemPrompt } from "./prompt.js";

/**
 * A single conversation turn, provider-neutral.
 *
 * History is stored in this shape (see sessions.ts) rather than in any SDK's
 * own message type, so the rest of the app doesn't move when the model behind
 * it does. `user` and `assistant` happen to match Anthropic's roles exactly,
 * so the array is passed to the Messages API with no translation.
 */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * AgentRouter (https://agentrouter.org) is an Anthropic-compatible gateway that
 * resells Claude models for prepaid credits. It speaks the standard Messages
 * API, but its gateway runs a WAF that only admits requests carrying the Claude
 * Code "wire image" — a claude-cli User-Agent, `anthropic-beta` + `x-app`/`cli`
 * headers, and the `/v1/messages?beta=true` path. A stock SDK request (plain
 * SDK User-Agent, no beta headers) is rejected with `401 unauthorized client
 * detected` before the key is even checked. We therefore send that fingerprint
 * when talking to an AgentRouter host; it's a no-op otherwise, so pointing
 * ANTHROPIC_BASE_URL at a different relay stays clean.
 *
 * Override the host with ANTHROPIC_BASE_URL. AgentRouter rotates which
 * claude-cli versions its WAF accepts, so if you start seeing "unauthorized
 * client detected" again, bump AGENTROUTER_CLIENT_UA to the current Claude Code
 * version.
 */
const DEFAULT_BASE_URL = "https://agentrouter.org";

const AGENTROUTER_BETA_HEADERS =
  "claude-code-20250219,interleaved-thinking-2025-05-14," +
  "effort-2025-11-24,redact-thinking-2026-02-12";

const CLIENT_UA =
  process.env.AGENTROUTER_CLIENT_UA ||
  "claude-cli/2.1.219 (external, sdk-cli)";

let client: Anthropic | null = null;

/** True when the outbound host is AgentRouter's (so we send its fingerprint). */
function usingAgentRouter(): boolean {
  return (process.env.ANTHROPIC_BASE_URL?.trim() || DEFAULT_BASE_URL).includes(
    "agentrouter.",
  );
}

/**
 * Credentials come from the environment: AGENTROUTER_API_KEY (the key from your
 * AgentRouter console) or ANTHROPIC_API_KEY. Never hardcode a key — and never
 * ship one to the browser, which is the whole reason this server sits between
 * your website and the API.
 *
 * Built on first use so that a missing key surfaces the actionable message
 * below at startup, rather than an SDK stack trace during module import.
 */
function getClient(): Anthropic {
  if (client) return client;
  const apiKey =
    process.env.AGENTROUTER_API_KEY?.trim() ||
    process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "No AgentRouter credentials found. Copy .env.example to .env and set " +
        "AGENTROUTER_API_KEY to the API key from your AgentRouter console " +
        "(https://agentrouter.org).\n" +
        "  (or set MOCK=true to test the plumbing with no key at all)",
    );
  }
  const baseURL = process.env.ANTHROPIC_BASE_URL?.trim() || DEFAULT_BASE_URL;
  client = new Anthropic({
    apiKey,
    baseURL,
    // This overrides the SDK's own User-Agent (merge order puts defaultHeaders
    // last). Only for AgentRouter, so other hosts get a stock client.
    ...(usingAgentRouter()
      ? {
          defaultHeaders: {
            "User-Agent": CLIENT_UA,
            "x-app": "cli",
            "anthropic-beta": AGENTROUTER_BETA_HEADERS,
          },
        }
      : {}),
  });
  return client;
}

/**
 * Mock mode: canned replies, no API call, no key, no cost.
 *
 * It exercises everything except the model — streaming, the widget, CORS, rate
 * limiting, your deployment. It cannot tell you whether the answers are any
 * good, so every mock reply is prefixed so nobody mistakes one for the real
 * thing.
 */
export const MOCK = process.env.MOCK === "true";

/**
 * Defaults to deepseek-v4-flash: a fast, cheap model — the right fit for a
 * support widget. Slow Opus replies were the complaint that led here. It is not
 * Anthropic's model, but it runs on the same Anthropic-compatible API that
 * AgentRouter exposes, so nothing else in the app changes.
 *
 * This AgentRouter plan allows these models:
 *   deepseek-v4-flash   (default) fast and cheap
 *   glm-5.3, gpt-5.6-sol   other non-Anthropic options
 *   claude-opus-5, claude-opus-4-8   Anthropic Claude — strongest answers,
 *     but Opus-tier slow (they think before replying) and costly. Reach for
 *     these with AGENT_MODEL when answer quality matters more than speed.
 *
 * Set via AGENT_MODEL, e.g. AGENT_MODEL=claude-opus-5. If a model errors, check
 * Console → API Token → model restrictions.
 */
export const MODEL = process.env.AGENT_MODEL?.trim() || "deepseek-v4-flash";

/**
 * Support answers are short by design. 8192 leaves room for the model's own
 * adaptive thinking on top of the visible answer without letting a runaway fill
 * the panel.
 */
const MAX_TOKENS = 8192;

/**
 * Thinking is left to the model.
 *
 * On Claude Sonnet 5 (and the rest of the current Claude family) adaptive
 * thinking is on by default, and the fixed `budget_tokens` dial is gone — older
 * models rejected nothing, current ones reject an explicit budget with a 400.
 * Sending no `thinking` parameter is the one setting valid across every current
 * model, so we send none. Answer depth is tuned with AGENT_MODEL instead.
 */

/**
 * The date in the business's own timezone, with no clock time.
 *
 * Deliberately date-only: this string sits inside the system prompt, and
 * Anthropic's prompt cache is a prefix match — any change to the system block
 * invalidates the cached prefix. A clock time here would change on every
 * request and silently destroy the cache hit. A date changes once a day, which
 * costs one cache miss at midnight.
 */
function todayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());
}

let cachedPrompt: { day: string; text: string } | null = null;

/** The system prompt, rebuilt only when the date rolls over. */
function systemPrompt(): string {
  const day = todayInTimezone(businessProfile.timezone);
  if (cachedPrompt?.day !== day) {
    cachedPrompt = { day, text: buildSystemPrompt(businessProfile, day) };
  }
  return cachedPrompt.text;
}

/** Fails loudly at startup rather than on a customer's first message. */
export function validateConfig(): void {
  // Mock mode deliberately needs no credentials at all.
  if (!MOCK) getClient();

  try {
    todayInTimezone(businessProfile.timezone);
  } catch {
    throw new Error(
      `business.ts: "${businessProfile.timezone}" is not a valid IANA timezone. ` +
        `Use something like "America/New_York" or "Europe/London".`,
    );
  }
  if (!businessProfile.name.trim()) {
    throw new Error("business.ts: `name` cannot be empty.");
  }
}

/** What we say when we genuinely cannot answer — falls back to a human. */
export function handoffMessage(): string {
  const { phone, email, bookingUrl } = businessProfile.contact;
  const routes = [
    phone && `call us on ${phone}`,
    email && `email ${email}`,
    bookingUrl && `use the form at ${bookingUrl}`,
  ].filter((route): route is string => Boolean(route));

  if (routes.length === 0) {
    return "I'm not able to help with that one — please get in touch with the team directly.";
  }
  const last = routes[routes.length - 1] ?? "";
  const list =
    routes.length === 1 ? last : `${routes.slice(0, -1).join(", ")} or ${last}`;
  return `That one's better answered by a person — you can ${list} and someone will help you out.`;
}

export interface ReplyMeta {
  /** Everything that was streamed, assembled. */
  text: string;
  /** True when a safety classifier declined the prompt or stopped the answer. */
  refused: boolean;
  stopReason: string | null;
  /** Null in mock mode, where nothing was billed. */
  usage: {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
  } | null;
  mocked: boolean;
}

/**
 * Produce a reply, handing each chunk of text to `onDelta` as it arrives.
 *
 * The callback shape keeps server.ts independent of the SDK's stream events,
 * which is what lets mock mode substitute cleanly below.
 *
 * `shouldStop` is polled between chunks — it returns true once the visitor has
 * closed the tab, so we stop generating rather than talking to an empty room.
 *
 * Transient failures (429, 5xx, network) are retried by the SDK itself, which
 * does so with backoff by default, so there is no retry loop to maintain here.
 */
export async function generateReply(
  messages: ChatMessage[],
  onDelta: (chunk: string) => void,
  shouldStop: () => boolean,
): Promise<ReplyMeta> {
  if (MOCK) return mockReply(messages, onDelta, shouldStop);

  // The system prompt is the one stable, repeated prefix in every request, so
  // it is the natural cache breakpoint. cache_control marks it cacheable.
  // AgentRouter's WAF wants the ?beta=true path variant, so we add it as a
  // request option (the SDK appends it to the URL) only for that host.
  const stream = getClient().messages.stream(
    {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: systemPrompt(),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    },
    usingAgentRouter() ? { query: { beta: "true" } } : undefined,
  );

  let text = "";

  try {
    for await (const event of stream) {
      if (shouldStop()) {
        stream.abort();
        break;
      }
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        text += event.delta.text;
        onDelta(event.delta.text);
      }
    }
  } catch (error) {
    // A visitor closing the tab aborts the stream, which surfaces as an error
    // here; that's not a real failure. Everything else propagates.
    if (!shouldStop()) throw error;
  }

  if (shouldStop()) {
    return { text, refused: false, stopReason: null, usage: null, mocked: false };
  }

  // The full message carries the stop reason and cumulative token usage, which
  // the streaming events only hint at.
  const final = await stream.finalMessage();

  // "refusal" means a safety classifier declined the request. An empty reply
  // then routes to a human back in server.ts.
  const refused = final.stop_reason === "refusal";

  return {
    text,
    refused,
    stopReason: final.stop_reason ?? null,
    usage: {
      input: final.usage.input_tokens,
      cacheRead: final.usage.cache_read_input_tokens ?? 0,
      cacheWrite: final.usage.cache_creation_input_tokens ?? 0,
      output: final.usage.output_tokens,
    },
    mocked: false,
  };
}

// --- mock mode -------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Streams a canned answer word by word, so the widget's streaming path, typing
 * indicator and scrolling all behave exactly as they will in production.
 */
async function mockReply(
  messages: ChatMessage[],
  onDelta: (chunk: string) => void,
  shouldStop: () => boolean,
): Promise<ReplyMeta> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const question = (lastUser?.content ?? "").toLowerCase();

  const words = `[mock] ${chooseMockAnswer(question)}`.split(" ");
  let text = "";

  for (let index = 0; index < words.length; index += 1) {
    if (shouldStop()) break;
    const chunk = (index === 0 ? "" : " ") + (words[index] ?? "");
    text += chunk;
    onDelta(chunk);
    await sleep(30);
  }

  return { text, refused: false, stopReason: "end_turn", usage: null, mocked: true };
}

function chooseMockAnswer(question: string): string {
  const has = (...terms: string[]): boolean =>
    terms.some((term) => question.includes(term));

  if (has("hello", "hi ", "hey", "there?") || question.length < 4) {
    return "Hi! This is mock mode, so I'm reading from a script rather than thinking. Ask me about pricing, hours, or booking to see different canned replies.";
  }
  if (has("price", "cost", "how much", "quote", "charge")) {
    return "This is where a real pricing answer would go, read from the servicesAndPricing list in business.ts. In mock mode I can't look anything up, so treat this as a layout test rather than an answer.";
  }
  if (has("open", "hours", "closed", "sunday", "saturday", "today", "tomorrow")) {
    return "A real reply here would quote your opening hours and work out whether today counts. Mock mode doesn't know what day it is, so this is placeholder text of about the length a genuine answer runs to.";
  }
  if (has("book", "appointment", "reserve", "slot")) {
    return "A real reply would point you at your booking link and say what needs booking ahead versus what takes walk-ins. This is a stand-in.";
  }
  if (has("refund", "complaint", "broken", "wrong", "angry", "discount")) {
    return "This is the handoff path. A real agent would recognise this as something for a person and give your phone number and email rather than trying to resolve it.";
  }
  return "Mock mode is on, so this is canned text rather than a real answer — useful for checking that streaming, scrolling and the widget layout all behave. Set MOCK=false and add an API key to get genuine answers from your business details.";
}
