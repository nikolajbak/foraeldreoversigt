/**
 * HTTP client tuned for ForældreIntra.
 *
 * Why custom rather than plain `fetch`:
 *   - `fetch`'s automatic redirect handling does not expose `Set-Cookie` from
 *     intermediate hops, and the SSO relay chain sets cookies on those hops.
 *     Following redirects manually is the difference between a login that
 *     works and one that silently loses its session.
 *   - Intermediate "200 OK with an auto-submitting form" pages have to be
 *     parsed and re-posted, which a redirect-following client cannot do.
 *   - Every exchange goes through the wire tracer, sanitised, so failures are
 *     diagnosable from a shareable transcript.
 */

import { FskintraCookieJar } from './cookies.ts';
import { RedirectLoopError } from './errors.ts';
import type { Logger } from './logger.ts';
import { silentLogger } from './logger.ts';
import {
  noopTracer,
  sanitizeHeaders,
  sanitizeRequestBody,
  sanitizeResponseBody,
  sanitizeUrl,
  type WireTracer,
} from './wire-tracer.ts';

/** A desktop-Chrome fingerprint. ForældreIntra serves a different (worse) layout to unknown agents. */
export const DEFAULT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Google Chrome";v="126", "Chromium";v="126", "Not-A.Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'upgrade-insecure-requests': '1',
  'accept-language': 'da-DK,da;q=0.9,en;q=0.8',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
});

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export interface FskintraHttpClientOptions {
  jar?: FskintraCookieJar;
  logger?: Logger;
  /** Merged into DEFAULT_HEADERS; looked up lower-cased. */
  defaultHeaders?: Record<string, string>;
  /** Defaults to noop. The CLI's `--debug` swaps in a JsonlFileTracer. */
  tracer?: WireTracer;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  noDefaultHeaders?: boolean;
}

export interface FskintraResponse {
  status: number;
  headers: Headers;
  body: string;
  /** The URL this response came from (= request URL, since redirects are manual). */
  url: string;
}

export interface RedirectStep {
  url: string;
  status: number;
}

export interface FollowOptions extends RequestOptions {
  maxHops?: number;
}

export interface FollowResult {
  history: RedirectStep[];
  final: FskintraResponse;
}

export class FskintraHttpClient {
  readonly tracer: WireTracer;
  private _jar: FskintraCookieJar;
  private readonly logger: Logger;
  private readonly defaultHeaders: Record<string, string>;
  private seq = 0;

  constructor(options: FskintraHttpClientOptions = {}) {
    this.logger = options.logger ?? silentLogger;
    this._jar = options.jar ?? new FskintraCookieJar({ logger: this.logger });
    this.tracer = options.tracer ?? noopTracer;
    this.defaultHeaders = { ...DEFAULT_HEADERS, ...(options.defaultHeaders ?? {}) };
  }

  get jar(): FskintraCookieJar {
    return this._jar;
  }

  /**
   * Swap in a jar deserialized from the session store. Replacing the jar
   * (rather than merging into the current one) is deliberate: a resumed
   * session should start from exactly the cookies that were persisted, with
   * no leftovers from a previous attempt in this process.
   */
  async restoreJar(serialized: string): Promise<void> {
    this._jar = await FskintraCookieJar.deserialize(serialized);
  }

  /** Drop all cookies — `logout`, and the retry path after a dead session. */
  resetJar(): void {
    this._jar = new FskintraCookieJar({ logger: this.logger });
  }

  /** One request, no redirect following. Cookies in and out are handled. */
  async request(url: string, options: RequestOptions = {}): Promise<FskintraResponse> {
    const method = (options.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = options.noDefaultHeaders
      ? { ...(options.headers ?? {}) }
      : { ...this.defaultHeaders, ...(options.headers ?? {}) };

    const cookie = await this._jar.cookieHeader(url);
    if (cookie) headers['cookie'] = cookie;

    const body = options.body instanceof URLSearchParams ? options.body.toString() : options.body;
    if (body != null && !headers['content-type']) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }

    const startedAt = Date.now();
    this.logger.debug('http.request', { method, url: sanitizeUrl(url) });

    const response = await fetch(url, {
      method,
      headers,
      ...(body == null ? {} : { body }),
      redirect: 'manual',
    });

    await this._jar.storeFromResponse(response.headers, url);
    const text = await response.text();
    const durationMs = Date.now() - startedAt;
    const sanitizedResponse = sanitizeResponseBody(text);

    this.seq += 1;
    this.tracer.record({
      ts: new Date().toISOString(),
      seq: this.seq,
      method,
      url: sanitizeUrl(url),
      requestHeaders: sanitizeHeaders(headers),
      requestBody: sanitizeRequestBody(body ?? null),
      status: response.status,
      responseHeaders: sanitizeHeaders(response.headers),
      responseBody: sanitizedResponse.text,
      responseBodyBytes: sanitizedResponse.bytes,
      durationMs,
    });

    return { status: response.status, headers: response.headers, body: text, url };
  }

  /**
   * Walk the redirect chain manually, collecting cookies at every hop.
   * 303 always becomes GET; 301/302 do too, matching what browsers actually
   * do with form POSTs. 307/308 preserve the method and body.
   */
  async follow(url: string, options: FollowOptions = {}): Promise<FollowResult> {
    const maxHops = options.maxHops ?? 12;
    const history: RedirectStep[] = [];

    // `body` is tracked separately and the caller's copy is dropped from the
    // spread: leaving it in would resend the login POST body on the GET we
    // follow the redirect with.
    const { body: _initialBody, maxHops: _maxHops, method: _method, ...perRequest } = options;

    let current = url;
    let method = options.method ?? 'GET';
    let body = options.body;

    for (let hop = 0; hop < maxHops; hop++) {
      const response = await this.request(current, {
        ...perRequest,
        method,
        ...(body == null ? {} : { body }),
      });
      history.push({ url: current, status: response.status });

      const location = response.headers.get('location');
      if (!REDIRECT_STATUSES.has(response.status) || !location) {
        return { history, final: { ...response, url: current } };
      }

      current = new URL(location, current).toString();
      if (response.status !== 307 && response.status !== 308) {
        method = 'GET';
        body = undefined;
      }
    }

    throw new RedirectLoopError(maxHops, current);
  }

  /** Fetch a binary resource (attachment, photo) with the session's cookies. */
  async requestBinary(url: string): Promise<{ contentType: string; data: Uint8Array }> {
    const cookie = await this._jar.cookieHeader(url);
    const response = await fetch(url, {
      headers: { ...this.defaultHeaders, ...(cookie ? { cookie } : {}) },
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${sanitizeUrl(url)}`);
    }
    return {
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      data: new Uint8Array(await response.arrayBuffer()),
    };
  }
}
