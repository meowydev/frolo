// Password hashing (req: secure password hashing). Uses Node's built-in scrypt
// (memory-hard KDF) so there is no native dependency. Format:
//   scrypt$N$r$p$<saltB64>$<hashB64>
// Verification is constant-time. Password values are never logged.

import { scrypt, randomBytes, timingSafeEqual, type ScryptOptions } from "node:crypto";

// Promise wrapper that supports the options overload (promisify(scrypt) loses it).
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

// Cost parameters. N must be a power of two. These are reasonable for an
// interactive login on a small VM.
const N = 16384;
const r = 8;
const p = 1;
const KEYLEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, KEYLEN, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  })) as Buffer;
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const rr = Number(parts[2]);
  const pp = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  const derived = (await scryptAsync(password, salt, expected.length, {
    N: n,
    r: rr,
    p: pp,
    maxmem: 64 * 1024 * 1024,
  })) as Buffer;
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

// Password policy: minimum length, not empty. Returns an error message or null.
export function validatePasswordStrength(password: string): string | null {
  if (typeof password !== "string" || password.length < 10) {
    return "Password must be at least 10 characters.";
  }
  if (password.length > 512) return "Password is too long.";
  return null;
}
