import { timingSafeEqual } from "node:crypto";

export type AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; message: string };

type Headers = Record<string, string | string[] | undefined>;

function bearerToken(headers: Headers): string | null {
  const raw = headers["authorization"] ?? headers["Authorization"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") return null;
  return parts[1];
}

function constantTimeEqual(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers; differing lengths are a
  // mismatch by definition (the length leak is acceptable and standard).
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Gate an HTTP request against the optional bearer token.
 * - No token configured  -> open (ok).
 * - Token configured, header missing/malformed -> 401.
 * - Token configured, value mismatch            -> 403.
 */
export function checkAuth(
  headers: Headers,
  expectedToken: string | undefined
): AuthResult {
  if (!expectedToken) return { ok: true };

  const provided = bearerToken(headers);
  if (provided === null) {
    return { ok: false, status: 401, message: "Unauthorized: missing bearer token" };
  }
  if (!constantTimeEqual(provided, expectedToken)) {
    return { ok: false, status: 403, message: "Forbidden: invalid bearer token" };
  }
  return { ok: true };
}
