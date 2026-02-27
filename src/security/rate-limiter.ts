import { config } from "../config.js";

const windowMs = 60_000;
const maxRequests = config.RATE_LIMIT_PER_MINUTE;
const timestamps = new Map<string, number[]>();

/**
 * Sliding window rate limiter per user.
 * Returns true if the request is allowed.
 */
export function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const cutoff = now - windowMs;

  let userTs = timestamps.get(userId);
  if (!userTs) {
    userTs = [];
    timestamps.set(userId, userTs);
  }

  // Remove expired entries
  while (userTs.length > 0 && userTs[0]! < cutoff) {
    userTs.shift();
  }

  if (userTs.length >= maxRequests) {
    return false;
  }

  userTs.push(now);
  return true;
}
