/**
 * Crypto primitives for the encrypted session store. Wraps `node:crypto`
 * (which Bun also provides) so callers don't sprinkle imports everywhere and
 * we can swap implementations if we ever need WebCrypto-only.
 */

import { Buffer } from 'node:buffer';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes as nodeRandomBytes,
} from 'node:crypto';
import { base64url } from './encoding.ts';

/** N cryptographically-random bytes. */
export function randomBytes(n: number): Buffer {
  return nodeRandomBytes(n);
}

/** N random bytes encoded as URL-safe base64 with no padding. */
export function randomBase64Url(n: number): string {
  return base64url.encode(nodeRandomBytes(n));
}

export function sha256(input: Buffer | string): Buffer {
  return createHash('sha256').update(input).digest();
}

export interface AesGcmCiphertext {
  ciphertext: Buffer;
  tag: Buffer;
}

/** AES-256-GCM encrypt with a 16-byte tag. */
export function aesGcmEncrypt(
  key: Buffer,
  iv: Buffer,
  plaintext: Buffer,
  aad?: Buffer,
): AesGcmCiphertext {
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

export function aesGcmDecrypt(
  key: Buffer,
  iv: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
  aad?: Buffer,
): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(aad);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
