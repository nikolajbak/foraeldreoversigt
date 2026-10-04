/**
 * Session persistence. The MCP server and the CLI both read from here, so
 * `fskintra login` in a terminal "just works" against an already-running
 * server without restarting it.
 *
 * Design mirrors aula-mcp's token store:
 *   - `SessionStore` is the pluggable interface (load / save / clear).
 *   - `MemorySessionStore` for tests and ephemeral runs.
 *   - `EncryptedFileSessionStore` writes a JSON envelope (version + IV +
 *     ciphertext + tag) at `~/.config/fskintra-mcp/session.json`, mode 0600.
 *
 * The encryption key is resolved in this order:
 *   1. an explicit Buffer passed to the constructor — strongest; intended for
 *      callers that read from a system keychain,
 *   2. `FSKINTRA_MCP_KEY` — 64 hex chars, or an arbitrary passphrase that is
 *      SHA-256-derived,
 *   3. a generated key file at `~/.config/fskintra-mcp/.key` (mode 0600) —
 *      convenience fallback, with a warning that 1 or 2 are stronger.
 *
 * ## Why the password is in the record
 *
 * Aula persists OAuth refresh tokens. ForældreIntra has no such thing: the
 * only way to renew an expired session is to replay the login form. So the
 * record optionally carries the password, and that is the whole reason this
 * store is encrypted rather than plain JSON.
 *
 * Callers that would rather not store it can save with `password: undefined`
 * (`fskintra login --no-store-password`). The trade-off is real and belongs
 * to the user: without it, every session expiry needs an interactive login,
 * which a headless MCP server cannot do.
 */

import { Buffer } from 'node:buffer';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { aesGcmDecrypt, aesGcmEncrypt, randomBytes, sha256 } from './crypto.ts';
import { hexToBytes } from './encoding.ts';
import { FskintraAuthError } from './errors.ts';
import type { Logger } from './logger.ts';
import { silentLogger } from './logger.ts';

export class SessionStoreError extends FskintraAuthError {
  override readonly name: string = 'SessionStoreError';
}

/** Persisted record. Bumped via `version` if the shape ever changes. */
export interface StoredSessionRecord {
  version: 1;
  /** Bare hostname, e.g. `minskole.skoleintra.dk`. */
  hostname: string;
  username: string;
  /** Present unless the user opted out; see the note at the top of this file. */
  password?: string;
  /** Serialized tough-cookie jar. */
  cookies?: string;
  /**
   * Last known logged-in front page, e.g.
   * `https://host/parent/1234/Andrea/Index`. Starting there skips the whole
   * login chain when the cookies are still good.
   */
  indexUrl?: string;
  /** When the record was last written. Unix epoch seconds. */
  saved_at: number;
  /** When the session was last confirmed live. Unix epoch seconds. */
  verified_at?: number;
  /** Free-form metadata bag — debug only. */
  meta?: Record<string, unknown>;
}

export interface SessionStore {
  load(): Promise<StoredSessionRecord | undefined>;
  save(record: StoredSessionRecord): Promise<void>;
  clear(): Promise<void>;
}

/** In-memory store. Tests and one-shot runs. */
export class MemorySessionStore implements SessionStore {
  private record: StoredSessionRecord | undefined;

  async load(): Promise<StoredSessionRecord | undefined> {
    return this.record;
  }
  async save(record: StoredSessionRecord): Promise<void> {
    this.record = record;
  }
  async clear(): Promise<void> {
    this.record = undefined;
  }
}

interface Envelope {
  v: 1;
  iv: string;
  ct: string;
  tag: string;
}

export function defaultConfigDir(): string {
  return process.env.FSKINTRA_MCP_DIR?.trim() || join(homedir(), '.config', 'fskintra-mcp');
}

export interface EncryptedFileSessionStoreOptions {
  filePath?: string;
  key?: Buffer;
  logger?: Logger;
}

export class EncryptedFileSessionStore implements SessionStore {
  /** Public so callers can watch the file for out-of-band logins. */
  readonly filePath: string;
  private readonly explicitKey: Buffer | undefined;
  private readonly logger: Logger;
  private resolvedKey: Buffer | undefined;

  constructor(options: EncryptedFileSessionStoreOptions = {}) {
    this.filePath = options.filePath ?? join(defaultConfigDir(), 'session.json');
    this.explicitKey = options.key;
    this.logger = options.logger ?? silentLogger;
  }

  async load(): Promise<StoredSessionRecord | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return undefined;
    }

    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch (cause) {
      throw new SessionStoreError(`Session file at ${this.filePath} is not valid JSON.`, { cause });
    }
    if (envelope.v !== 1) {
      throw new SessionStoreError(`Unsupported session file version ${String(envelope.v)}.`);
    }

    const key = await this.getKey();
    try {
      const plaintext = aesGcmDecrypt(
        key,
        Buffer.from(envelope.iv, 'base64'),
        Buffer.from(envelope.ct, 'base64'),
        Buffer.from(envelope.tag, 'base64'),
      );
      return JSON.parse(plaintext.toString('utf8')) as StoredSessionRecord;
    } catch (cause) {
      throw new SessionStoreError(
        `Could not decrypt ${this.filePath}. The encryption key changed — set FSKINTRA_MCP_KEY ` +
          `to the key used when it was written, or run \`fskintra logout\` and log in again.`,
        { cause },
      );
    }
  }

  async save(record: StoredSessionRecord): Promise<void> {
    const key = await this.getKey();
    const iv = randomBytes(12);
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, Buffer.from(JSON.stringify(record), 'utf8'));
    const envelope: Envelope = {
      v: 1,
      iv: iv.toString('base64'),
      ct: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
    };

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(envelope), { mode: 0o600 });
    // writeFile's mode only applies on create; enforce it on rewrite too.
    await chmod(this.filePath, 0o600);
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch {
      // Already gone; nothing to do.
    }
  }

  private async getKey(): Promise<Buffer> {
    if (this.resolvedKey) return this.resolvedKey;

    if (this.explicitKey) {
      if (this.explicitKey.length !== 32) {
        throw new SessionStoreError('Explicit encryption key must be exactly 32 bytes.');
      }
      this.resolvedKey = this.explicitKey;
      return this.resolvedKey;
    }

    const fromEnv = process.env.FSKINTRA_MCP_KEY?.trim();
    if (fromEnv) {
      // 64 hex chars is a raw key; anything else is treated as a passphrase.
      this.resolvedKey = /^[0-9a-fA-F]{64}$/.test(fromEnv) ? hexToBytes(fromEnv) : sha256(fromEnv);
      return this.resolvedKey;
    }

    this.resolvedKey = await this.loadOrCreateKeyFile();
    return this.resolvedKey;
  }

  private async loadOrCreateKeyFile(): Promise<Buffer> {
    const keyPath = join(dirname(this.filePath), '.key');
    try {
      const existing = (await readFile(keyPath, 'utf8')).trim();
      if (/^[0-9a-fA-F]{64}$/.test(existing)) return hexToBytes(existing);
      this.logger.warn('session-store.key_file_malformed_regenerating', { keyPath });
    } catch {
      // No key file yet.
    }

    const key = randomBytes(32);
    await mkdir(dirname(keyPath), { recursive: true });
    await writeFile(keyPath, key.toString('hex'), { mode: 0o600 });
    await chmod(keyPath, 0o600);
    this.logger.warn('session-store.key_file_generated', {
      keyPath,
      hint: 'Set FSKINTRA_MCP_KEY (hex or passphrase) for stronger key handling.',
    });
    return key;
  }
}

/** True when the record has enough to attempt a silent re-login. */
export function canReauthenticate(record: StoredSessionRecord | undefined): boolean {
  return Boolean(record?.hostname && record.username && record.password);
}
