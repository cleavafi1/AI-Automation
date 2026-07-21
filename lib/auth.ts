import crypto from "crypto";

// Simple session-based auth for a single admin user. The session cookie holds a
// signed token (HMAC-SHA256 over a small payload) — no DB, no third-party lib.

export const SESSION_COOKIE = "cleava_admin_session";
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

type SessionPayload = {
  sub: string; // subject — always "admin" for the single account
  exp: number; // expiry, ms since epoch
};

function getSecret(): string {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) {
    throw new Error("Missing ADMIN_SESSION_SECRET environment variable.");
  }
  return secret;
}

function sign(body: string): string {
  return crypto
    .createHmac("sha256", getSecret())
    .update(body)
    .digest("base64url");
}

/** Create a signed session token for the admin. */
export function createSessionToken(): string {
  const payload: SessionPayload = {
    sub: "admin",
    exp: Date.now() + SESSION_DURATION_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  return `${body}.${sign(body)}`;
}

/**
 * Verify a session token. Returns true only for a well-formed, correctly
 * signed, non-expired token. Fails closed on any error.
 */
export function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [body, sig] = parts;

  // Constant-time signature comparison.
  let expected: string;
  try {
    expected = sign(body);
  } catch {
    return false; // e.g. missing secret — fail closed
  }
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return false;

  // Signature valid — check payload.
  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8")
    ) as SessionPayload;
    if (payload.sub !== "admin") return false;
    if (typeof payload.exp !== "number" || Date.now() >= payload.exp) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export const SESSION_MAX_AGE_SECONDS = Math.floor(SESSION_DURATION_MS / 1000);

/**
 * Read the admin bcrypt hash from ADMIN_PASSWORD_HASH.
 *
 * The env value is expected to be the bcrypt hash base64-encoded (see
 * scripts/hash-password.mjs) — because Next.js's dotenv-expand mangles the "$"
 * characters in a raw bcrypt hash. We decode base64 here. As a fallback, if the
 * value already looks like a raw bcrypt hash (starts with "$2"), use it as-is.
 */
export function getAdminPasswordHash(): string | null {
  const raw = process.env.ADMIN_PASSWORD_HASH;
  if (!raw) return null;
  if (raw.startsWith("$2")) return raw; // already a raw bcrypt hash
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    return decoded.startsWith("$2") ? decoded : null;
  } catch {
    return null;
  }
}
