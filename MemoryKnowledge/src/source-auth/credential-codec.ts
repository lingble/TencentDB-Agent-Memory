/**
 * Credential base64 encoding/decoding (for storage; not encryption).
 *
 * Tokens are stored base64-encoded in `cred_secret` and decoded in memory when used.
 * base64 provides no confidentiality: Node's base64 decoder never throws, and invalid input yields garbage —
 * so charset + length validation **must** come first, otherwise corrupted content would be used as a valid token for clone.
 *
 * Confidentiality is provided by access control (SQLite file permissions + APIs never echo secrets + no plaintext in logs),
 * not by this module. See design doc §4.1.3.
 */

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** UTF-8 → base64. Empty string returns empty string (caller guarantees a non-empty secret). */
export function encodeSecret(plain: string): string {
  return Buffer.from(plain, "utf8").toString("base64");
}

/** base64 → UTF-8. Invalid input returns null (does not throw). */
export function decodeSecret(b64: string | null | undefined): string | null {
  if (!b64 || b64.length % 4 !== 0 || !B64_RE.test(b64)) return null;
  return Buffer.from(b64, "base64").toString("utf8");
}
