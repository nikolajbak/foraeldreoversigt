/**
 * Wire tracing for the login flow and page fetches.
 *
 * When scraping breaks — and it will, because ForældreIntra's markup is not a
 * contract — the only way to diagnose it is to see the actual HTTP traffic.
 * The tracer is called by FskintraHttpClient around every fetch, and bodies
 * that contain known secrets are redacted so a transcript is safe to paste
 * into a GitHub issue.
 *
 * Three implementations:
 *   - noopTracer: default; zero-cost.
 *   - InMemoryTracer: collects entries in an array. One CLI run, dump at end.
 *   - JsonlFileTracer: appends one JSONL row per entry. Survives crashes.
 */

import { Buffer } from 'node:buffer';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface WireEntry {
  /** ISO 8601 timestamp. */
  ts: string;
  /** Sequence number — useful when sorting entries from concurrent calls. */
  seq: number;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  /** Body summary; secrets replaced by `<redacted N chars>`. */
  requestBody: string | null;
  status: number;
  responseHeaders: Record<string, string>;
  /** Body summary, possibly truncated. */
  responseBody: string;
  /** Response body length in bytes, before truncation. */
  responseBodyBytes: number;
  durationMs: number;
}

export interface WireTracer {
  record(entry: WireEntry): void;
}

export const noopTracer: WireTracer = { record() {} };

/** Collect entries in memory. */
export class InMemoryTracer implements WireTracer {
  readonly entries: WireEntry[] = [];
  record(entry: WireEntry): void {
    this.entries.push(entry);
  }
  clear(): void {
    this.entries.length = 0;
  }
}

/** Append-only JSONL file tracer. Creates the parent dir if needed. */
export class JsonlFileTracer implements WireTracer {
  private dirReady = false;
  constructor(private readonly path: string) {}

  record(entry: WireEntry): void {
    void this.write(entry);
  }

  private async write(entry: WireEntry): Promise<void> {
    if (!this.dirReady) {
      await mkdir(dirname(this.path), { recursive: true });
      this.dirReady = true;
    }
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

/**
 * Headers whose values are always redacted. `cookie` and `set-cookie` matter
 * most here: a ForældreIntra session cookie is a bearer credential, and it is
 * on nearly every request in a transcript.
 */
export const SECRET_HEADERS: ReadonlySet<string> = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  '__requestverificationtoken',
]);

/**
 * Form/JSON body field names that are redacted. The ASP.NET anti-forgery
 * token is included because it is replayable within a session.
 */
export const SECRET_BODY_FIELDS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pass',
  'pwd',
  '__requestverificationtoken',
  'samlresponse',
  'relaystate',
  'token',
  'access_token',
  'refresh_token',
  'code',
  'code_verifier',
]);

/** URL query parameters that are redacted. */
export const SECRET_URL_PARAMS: ReadonlySet<string> = new Set([
  'password',
  'token',
  'access_token',
  'refresh_token',
  'code',
  'code_verifier',
  'state',
  '__requestverificationtoken',
  'ticket',
]);

function redacted(value: string): string {
  return `<redacted ${value.length} chars>`;
}

export function sanitizeHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const entries =
    headers instanceof Headers ? [...headers.entries()] : Object.entries(headers ?? {});
  for (const [rawKey, value] of entries) {
    const key = rawKey.toLowerCase();
    out[key] = SECRET_HEADERS.has(key) ? redacted(value) : value;
  }
  return out;
}

/**
 * Redact secret query parameters while keeping the path and the harmless
 * params — the URL structure is exactly what makes a transcript diagnosable.
 */
export function sanitizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  for (const [key, value] of [...parsed.searchParams.entries()]) {
    if (SECRET_URL_PARAMS.has(key.toLowerCase())) {
      parsed.searchParams.set(key, redacted(value));
    }
  }
  return parsed.toString();
}

/**
 * Redact secret fields in a request body. Handles form-urlencoded and JSON;
 * anything else is reported by length only, since an unrecognised body could
 * contain anything.
 */
export function sanitizeRequestBody(body: string | null | undefined): string | null {
  if (body == null || body === '') return null;

  if (body.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      for (const key of Object.keys(parsed)) {
        if (SECRET_BODY_FIELDS.has(key.toLowerCase())) {
          parsed[key] = redacted(String(parsed[key]));
        }
      }
      return JSON.stringify(parsed);
    } catch {
      // Fall through to the form-encoded path.
    }
  }

  if (body.includes('=')) {
    const params = new URLSearchParams(body);
    const out = new URLSearchParams();
    for (const [key, value] of params.entries()) {
      out.append(key, SECRET_BODY_FIELDS.has(key.toLowerCase()) ? redacted(value) : value);
    }
    return out.toString();
  }

  return redacted(body);
}

const MAX_RESPONSE_CHARS = 4096;

/**
 * ForældreIntra pages are large and mostly chrome. We keep a bounded prefix —
 * enough to see which page came back and whether the expected container is in
 * it, without writing megabytes per login.
 */
export function sanitizeResponseBody(body: string): { text: string; bytes: number } {
  const bytes = Buffer.byteLength(body, 'utf8');
  if (body.length <= MAX_RESPONSE_CHARS) return { text: body, bytes };
  return {
    text: `${body.slice(0, MAX_RESPONSE_CHARS)}\n…<truncated, ${bytes} bytes total>`,
    bytes,
  };
}

/** Render a trace as a readable terminal report. */
export function formatTraceText(entries: readonly WireEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    lines.push(`#${e.seq} ${e.method} ${e.url}`);
    lines.push(`   -> ${e.status} (${e.durationMs}ms, ${e.responseBodyBytes} bytes)`);
    if (e.requestBody) lines.push(`   body: ${e.requestBody.slice(0, 200)}`);
    const location = e.responseHeaders['location'];
    if (location) lines.push(`   location: ${location}`);
  }
  return lines.join('\n');
}
