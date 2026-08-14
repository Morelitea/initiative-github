/**
 * Encrypting the one thing in this app worth stealing.
 *
 * A member's GitHub token reaches whatever that member reaches. Storing it as
 * plaintext in a column would mean a database backup, a replica, or a stray
 * `SELECT` hands over everyone's account at once — so it is sealed with a key
 * the database does not have.
 *
 * AES-256-GCM: authenticated, so a token that was tampered with fails to open
 * rather than decrypting into something else. A fresh 96-bit nonce per value,
 * stored alongside, because reusing one with GCM is the way this construction
 * actually breaks.
 *
 * This is in the reference app rather than the kit deliberately. Custody is the
 * app's decision — where the key lives, how it rotates, whether a hosted
 * deployment uses a KMS instead — and a kit that made that choice for everybody
 * would be wrong for most of them.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { config } from "./config.js";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** The key, decoded once. 32 bytes, base64 in the environment. */
function key(): Buffer {
  const decoded = Buffer.from(config.encryptionKey, "base64");
  if (decoded.length !== 32) {
    throw new Error(
      "APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded — " +
        "generate one with: openssl rand -base64 32"
    );
  }
  return decoded;
}

/** `<nonce>.<ciphertext>.<tag>`, all base64url. */
export function seal(plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), nonce);
  const sealed = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [nonce, sealed, tag].map((part) => part.toString("base64url")).join(".");
}

/** The plaintext, or null if it does not open under this key. */
export function open(sealed: string): string | null {
  const parts = sealed.split(".");
  if (parts.length !== 3) return null;
  try {
    const [nonce, body, tag] = parts.map((part) => Buffer.from(part, "base64url"));
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) return null;
    const decipher = createDecipheriv(ALGORITHM, key(), nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf-8");
  } catch {
    // A value that does not authenticate is not an error to handle — it is a
    // credential that is no longer usable, and the caller treats it as absent.
    return null;
  }
}
