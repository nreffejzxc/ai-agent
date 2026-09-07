import { randomUUID } from "node:crypto";
import type { ChatMessage } from "./agent.js";

/**
 * Conversation memory, held server-side.
 *
 * The browser only ever sends the newest message plus an opaque session id —
 * it never sends the transcript back. That matters: if the browser supplied
 * the history, a visitor could forge assistant turns ("you promised me a 90%
 * discount") and the model would treat them as its own words.
 *
 * The trade-off is that memory lives in this process. A restart clears it, and
 * running more than one instance behind a load balancer needs either sticky
 * sessions or a shared store (swap this Map for Redis — the interface below is
 * small on purpose).
 */

const SESSION_TTL_MS = 60 * 60 * 1000; // an hour of inactivity
const MAX_SESSIONS = 5_000; // hard ceiling so memory can't grow forever
const MAX_STORED_MESSAGES = 40; // ~20 exchanges, then the oldest fall off

interface Session {
  messages: ChatMessage[];
  lastSeen: number;
}

const sessions = new Map<string, Session>();

function sweepExpired(now: number): void {
  for (const [id, session] of sessions) {
    if (now - session.lastSeen > SESSION_TTL_MS) sessions.delete(id);
  }
}

function evictOldest(): void {
  let oldestId: string | undefined;
  let oldestSeen = Infinity;
  for (const [id, session] of sessions) {
    if (session.lastSeen < oldestSeen) {
      oldestSeen = session.lastSeen;
      oldestId = id;
    }
  }
  if (oldestId !== undefined) sessions.delete(oldestId);
}

function createSession(): string {
  const now = Date.now();
  sweepExpired(now);
  if (sessions.size >= MAX_SESSIONS) evictOldest();

  const id = randomUUID();
  sessions.set(id, { messages: [], lastSeen: now });
  return id;
}

/**
 * Turn whatever the browser sent into a session id we're willing to use.
 *
 * An id is only honoured if we already issued it. Minting a session under a
 * caller-chosen key would let someone pick `sessionId: "chat"` and share a
 * transcript with every other visitor who did the same.
 */
export function resolveSessionId(candidate: string | undefined): string {
  if (candidate && sessions.has(candidate)) return candidate;
  return createSession();
}

/**
 * Keep the tail of the conversation, and make sure it still starts with a user
 * turn — the API requires that, and trimming can leave an assistant message at
 * the front.
 */
function trim(messages: ChatMessage[]): ChatMessage[] {
  const tail = messages.slice(-MAX_STORED_MESSAGES);
  let start = 0;
  while (start < tail.length && tail[start]?.role !== "user") start += 1;
  return tail.slice(start);
}

function append(
  sessionId: string,
  message: ChatMessage,
): ChatMessage[] {
  const session = sessions.get(sessionId);
  if (!session) return [];
  session.messages = trim([...session.messages, message]);
  session.lastSeen = Date.now();
  return [...session.messages];
}

/** Record the visitor's message and return the history to send to the model. */
export function appendUserMessage(
  sessionId: string,
  text: string,
): ChatMessage[] {
  return append(sessionId, { role: "user", content: text });
}

/** Record what the agent said, so it remembers it next turn. */
export function appendAssistantMessage(sessionId: string, text: string): void {
  if (!text.trim()) return;
  append(sessionId, { role: "assistant", content: text });
}

/** For /health — a rough sense of how busy the widget is. */
export function activeSessionCount(): number {
  sweepExpired(Date.now());
  return sessions.size;
}
