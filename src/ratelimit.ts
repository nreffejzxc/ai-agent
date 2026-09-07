/**
 * A small sliding-window rate limiter, keyed per visitor.
 *
 * This is the one piece of this project you should not skip. A chat endpoint
 * with your API key behind it is a stranger's free access to a paid model, and
 * a single script can run up a real bill overnight.
 *
 * In-memory, so the limit is per process — good enough for one instance. Move
 * to Redis if you run several.
 */

const MAX_TRACKED_KEYS = 20_000;

interface Limits {
  max: number;
  windowMs: number;
}

let limits: Limits | null = null;

/**
 * Read limits on first use rather than at import time, so it doesn't matter
 * whether .env has been loaded yet when this module is first imported.
 */
function getLimits(): Limits {
  if (limits) return limits;

  const max = Number(process.env.RATE_LIMIT_MAX ?? 20);
  const windowSeconds = Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? 300);

  limits = {
    max: Number.isFinite(max) && max > 0 ? Math.floor(max) : 20,
    windowMs:
      Number.isFinite(windowSeconds) && windowSeconds > 0
        ? Math.floor(windowSeconds) * 1000
        : 300_000,
  };
  return limits;
}

const hits = new Map<string, number[]>();

export interface RateLimitResult {
  ok: boolean;
  retryAfterSeconds: number;
}

export function checkRateLimit(key: string): RateLimitResult {
  const { max, windowMs } = getLimits();
  const now = Date.now();
  const cutoff = now - windowMs;

  const recent = (hits.get(key) ?? []).filter((time) => time > cutoff);

  if (recent.length >= max) {
    const oldest = recent[0] ?? now;
    hits.set(key, recent);
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }

  recent.push(now);
  hits.set(key, recent);

  // Opportunistic cleanup: without this, one entry per unique IP accumulates
  // forever, which is a slow memory leak an attacker can accelerate.
  if (hits.size > MAX_TRACKED_KEYS) {
    for (const [otherKey, times] of hits) {
      if (times.every((time) => time <= cutoff)) hits.delete(otherKey);
    }
  }

  return { ok: true, retryAfterSeconds: 0 };
}
