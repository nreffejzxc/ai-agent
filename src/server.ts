/**
 * HTTP server: serves the chat widget and relays conversations to Claude
 * through AgentRouter (an Anthropic-compatible gateway).
 *
 * `dotenv/config` is first on purpose — ES module imports are evaluated in
 * order, so this loads .env before any module below reads process.env.
 */
import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { businessProfile, PLACEHOLDER_NAME } from "./business.js";
import {
  MOCK,
  MODEL,
  generateReply,
  handoffMessage,
  validateConfig,
} from "./agent.js";
import {
  activeSessionCount,
  appendAssistantMessage,
  appendUserMessage,
  resolveSessionId,
} from "./sessions.js";
import { checkRateLimit } from "./ratelimit.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");
const logFile = path.join(here, "..", "logs", "conversations.jsonl");

const PORT = Number(process.env.PORT ?? 3000);
const MAX_MESSAGE_CHARS = 2000;
const LOG_TRANSCRIPTS = process.env.LOG_TRANSCRIPTS === "true";

/**
 * Only trust X-Forwarded-For when you actually run behind a proxy you control
 * (Nginx, Cloudflare, Render, Fly...). Trusting it otherwise lets a caller
 * spoof an IP per request and walk straight through the rate limiter.
 */
const TRUST_PROXY = process.env.TRUST_PROXY === "true";

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (allowedOrigins.length === 0) {
    // Development mode: allow any site. ALLOWED_ORIGINS locks this down.
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  // An origin that isn't allowed simply gets no CORS header, and the browser
  // blocks the response.

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.static(publicDir, { maxAge: "5m" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    business: businessProfile.name,
    model: MOCK ? "mock (no API calls)" : MODEL,
    mock: MOCK,
    activeSessions: activeSessionCount(),
  });
});

app.post("/api/chat", async (req, res) => {
  const visitor = clientIp(req);

  const limit = checkRateLimit(visitor);
  if (!limit.ok) {
    res.status(429).json({
      error: `You've sent a lot of messages in a short time. Please try again in about ${limit.retryAfterSeconds} seconds.`,
    });
    return;
  }

  const body = req.body as { sessionId?: unknown; message?: unknown } | undefined;
  const message = typeof body?.message === "string" ? body.message.trim() : "";

  if (!message) {
    res.status(400).json({ error: "A message is required." });
    return;
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    res.status(400).json({
      error: `Please keep messages under ${MAX_MESSAGE_CHARS} characters.`,
    });
    return;
  }

  const sessionId = resolveSessionId(
    typeof body?.sessionId === "string" ? body.sessionId : undefined,
  );
  const history = appendUserMessage(sessionId, message);

  // From here on we're streaming, so errors have to travel as SSE events
  // rather than status codes.
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // stops Nginx buffering the stream
  res.flushHeaders();

  const send = (payload: unknown): void => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // The id may be freshly minted, so tell the browser which one to echo back.
  send({ type: "session", sessionId });

  let visitorLeft = false;
  res.on("close", () => {
    visitorLeft = true;
  });

  let reply = "";

  try {
    const meta = await generateReply(
      history,
      (chunk) => {
        reply += chunk;
        send({ type: "delta", text: chunk });
      },
      () => visitorLeft,
    );

    if (visitorLeft) {
      appendAssistantMessage(sessionId, meta.text);
      res.end();
      return;
    }

    reply = meta.text;

    // Empty reply, or a safety classifier declined. For a support widget the
    // right move is a human, not a retry — the visitor gets a useful next step
    // instead of an empty bubble.
    if (!reply.trim()) {
      reply = handoffMessage();
      send({ type: "delta", text: reply });
    }

    if (meta.usage) {
      console.log(
        `[chat] session=${sessionId.slice(0, 8)} in=${meta.usage.input} ` +
          `cache_read=${meta.usage.cacheRead} cache_write=${meta.usage.cacheWrite} ` +
          `out=${meta.usage.output} stop=${meta.stopReason}` +
          (meta.refused ? " REFUSED (handed off)" : ""),
      );
    } else {
      console.log(`[chat] session=${sessionId.slice(0, 8)} mock reply, nothing billed`);
    }

    appendAssistantMessage(sessionId, reply);
    logTranscript(sessionId, message, reply);

    send({ type: "done" });
    res.end();
  } catch (error) {
    console.error("[chat] request failed:", error);
    if (!res.writableEnded) {
      send({ type: "error", message: friendlyError(error) });
      res.end();
    }
  }
});

/**
 * Turn an SDK error into something a customer can read. Specific first.
 *
 * The Anthropic SDK's error classes all carry the HTTP `status`, so we branch
 * on that rather than on error classes — which also keeps this working for the
 * plain network failures that never reach the API at all.
 */
function friendlyError(error: unknown): string {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;

  if (status === 401 || status === 403) {
    return "The assistant isn't set up correctly right now. Please contact us directly and we'll help.";
  }
  if (status === 429) {
    return "We're handling a lot of chats at the moment. Please try again in a minute.";
  }
  if (status === 503) {
    return "The assistant is very busy right now — that's on the AI provider's side and usually clears in a few seconds. Please try again.";
  }
  if (status === 400) {
    return "Something about that message confused me. Could you try rephrasing it?";
  }
  if (
    error instanceof Error &&
    /fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(
      error.message,
    )
  ) {
    return "I couldn't reach the assistant just now. Please try again in a moment.";
  }
  if (typeof status === "number") {
    return "Sorry, something went wrong on our side. Please try again, or contact us directly.";
  }
  return "Sorry, something went wrong. Please try again.";
}

function clientIp(req: express.Request): string {
  if (TRUST_PROXY) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded)
      ? forwarded[0]
      : forwarded?.split(",")[0];
    if (first?.trim()) return first.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * Optional transcript log — genuinely the fastest way to find out what your
 * customers actually ask, and what the agent couldn't answer. It contains real
 * customer messages, so treat the file as personal data.
 */
function logTranscript(sessionId: string, question: string, answer: string): void {
  if (!LOG_TRANSCRIPTS) return;
  const line = JSON.stringify({
    at: new Date().toISOString(),
    sessionId,
    question,
    answer,
  });
  fs.appendFile(logFile, `${line}\n`, (error) => {
    if (error) console.error("[log] could not write transcript:", error);
  });
}

function start(): void {
  validateConfig();

  if (LOG_TRANSCRIPTS) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }

  app.listen(PORT, () => {
    console.log(`\n  ${businessProfile.name} support agent`);
    console.log(`  http://localhost:${PORT}  (open this to try it)`);
    if (MOCK) {
      console.log("  MOCK MODE — canned replies, no API calls, nothing billed.");
      console.log("  Set MOCK=false in .env for real answers.\n");
    } else {
      console.log(`  model ${MODEL}\n`);
    }

    if (businessProfile.name === PLACEHOLDER_NAME) {
      console.warn(
        "  ⚠  src/business.ts still has the example bike-shop details.\n" +
          "     Replace them with your own before putting this on your site.\n",
      );
    }
    if (!MOCK && !process.env.AGENTROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY) {
      console.warn(
        "  ⚠  No AgentRouter key in the environment. Copy .env.example to .env\n" +
          "     and add AGENTROUTER_API_KEY from https://agentrouter.org,\n" +
          "     or set MOCK=true to test without one.\n",
      );
    }
    if (!MOCK && process.env.AGENTROUTER_API_KEY?.includes("...")) {
      console.warn(
        "  ⚠  AGENTROUTER_API_KEY still looks like the placeholder from\n" +
          "     .env.example. Replace it with a real key, or set MOCK=true.\n",
      );
    }
    if (allowedOrigins.length === 0) {
      console.warn(
        "  ⚠  ALLOWED_ORIGINS is empty, so any website may call this server.\n" +
          "     Fine locally; set it to your domain before going live.\n",
      );
    }
  });
}

start();
