import { config } from "../config.js";

/**
 * Check if a Slack user ID is in the allowlist.
 * Fail-closed: if the allowlist is empty, deny everyone.
 */
export function isAllowed(userId: string): boolean {
  if (config.ALLOWED_USER_IDS.length === 0) return false;
  return config.ALLOWED_USER_IDS.includes(userId);
}
