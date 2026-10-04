/** Small encoding helpers shared by the crypto + session-store layers. */

import { Buffer } from 'node:buffer';

export const base64url = {
  encode(input: Buffer | Uint8Array | string): string {
    return Buffer.from(input as Uint8Array).toString('base64url');
  },
  decode(input: string): Buffer {
    return Buffer.from(input, 'base64url');
  },
};

export function hexToBytes(hex: string): Buffer {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error(`Not a hex string: ${clean.slice(0, 16)}…`);
  }
  return Buffer.from(clean, 'hex');
}

export function bytesToHex(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes as Uint8Array).toString('hex');
}
