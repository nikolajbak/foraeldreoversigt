/**
 * The authenticated ForældreIntra client every section parser runs through.
 *
 * Responsibilities that live here on purpose, so no call site can forget them:
 *   - resolving credentials (stored session first, environment second),
 *   - resuming a persisted session before paying for a full login,
 *   - detecting the "200 OK but it's really the login page" response and
 *     re-authenticating exactly once before giving up,
 *   - persisting the refreshed cookies so the next process starts warm.
 */

import {
  ConfirmContactsRequiredError,
  type Doc,
  MemorySessionStore,
  FskintraHttpClient,
  FskintraLoginClient,
  isChildLink,
  type Logger,
  NotLoggedInError,
  normalizeHostname,
  parse,
  type SessionStore,
  type StoredSessionRecord,
  silentLogger,
  type WireTracer,
} from '../auth/index.ts';
import { FskintraClientError, SessionExpiredError } from './errors.ts';
import type { Child } from './types.ts';

export interface FskintraClientOptions {
  store?: SessionStore;
  logger?: Logger;
  tracer?: WireTracer;
  /** Overrides both the stored record and the environment. */
  credentials?: { hostname: string; username: string; password: string };
  /** Passed through to the login client; see its docs before enabling. */
  autoConfirmContacts?: boolean;
}

/**
 * Credentials from the environment. The stored session is the normal path;
 * this exists for headless deployments (the Home Assistant addon, a NAS)
 * where running an interactive `fskintra login` is awkward.
 */
export function credentialsFromEnv():
  | { hostname: string; username: string; password: string }
  | undefined {
  const hostname = process.env.FSKINTRA_HOSTNAME?.trim();
  const username = process.env.FSKINTRA_USERNAME?.trim();
  const password = process.env.FSKINTRA_PASSWORD;
  if (!hostname || !username || !password) return undefined;
  return { hostname: normalizeHostname(hostname), username, password };
}

/** A response is really the login screen when it lands on one of these. */
const LOGIN_PATH_RE = /\/Account\/(IdpLogin|Login)/i;

export class FskintraClient {
  readonly http: FskintraHttpClient;
  private readonly store: SessionStore;
  /** Public so section modules can record swallowed, non-fatal failures. */
  readonly logger: Logger;
  private readonly login: FskintraLoginClient;
  private readonly overrideCredentials: FskintraClientOptions['credentials'];

  private record: StoredSessionRecord | undefined;
  private indexDoc: Doc | undefined;
  private indexUrl: string | undefined;
  private children: Child[] | undefined;
  /** Shared across concurrent callers so a re-login fires once. */
  private authPromise: Promise<void> | undefined;

  constructor(options: FskintraClientOptions = {}) {
    this.logger = options.logger ?? silentLogger;
    this.store = options.store ?? new MemorySessionStore();
    this.http = new FskintraHttpClient({
      logger: this.logger,
      ...(options.tracer ? { tracer: options.tracer } : {}),
    });
    this.login = new FskintraLoginClient({
      http: this.http,
      logger: this.logger,
      autoConfirmContacts: options.autoConfirmContacts ?? false,
    });
    this.overrideCredentials = options.credentials;
  }

  /** The hostname this client is talking to, once authenticated. */
  get hostname(): string | undefined {
    return this.record?.hostname;
  }

  get username(): string | undefined {
    return this.record?.username;
  }

  /** Unix epoch seconds of the last time the session was confirmed live. */
  get verifiedAt(): number | undefined {
    return this.record?.verified_at;
  }

  absUrl(url: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    const hostname = this.record?.hostname;
    if (!hostname) throw new NotLoggedInError();
    return `https://${hostname}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  /**
   * Ensure we have a live session. Resumes from stored cookies when possible;
   * falls back to a full login. Concurrent callers share one attempt.
   */
  async authenticate(force = false): Promise<void> {
    if (this.indexDoc && !force) return;
    if (!this.authPromise) {
      this.authPromise = this.doAuthenticate(force).finally(() => {
        this.authPromise = undefined;
      });
    }
    return this.authPromise;
  }

  private async doAuthenticate(force: boolean): Promise<void> {
    let record: StoredSessionRecord | undefined;
    if (!this.overrideCredentials) {
      this.record ??= await this.store.load();
      record = this.record;
    }

    const credentials =
      this.overrideCredentials ??
      (record?.password
        ? { hostname: record.hostname, username: record.username, password: record.password }
        : credentialsFromEnv());

    if (!force && record?.cookies && record.indexUrl) {
      const resumed = await this.login.resume(record);
      if (resumed) {
        this.logger.info('client.session_resumed', { indexUrl: resumed.indexUrl });
        this.indexDoc = resumed.doc;
        this.indexUrl = resumed.indexUrl;
        this.children = undefined;
        await this.persist({ ...record, cookies: resumed.cookies, indexUrl: resumed.indexUrl });
        return;
      }
    }

    if (!credentials) {
      throw new NotLoggedInError(
        record
          ? 'The stored ForældreIntra session expired and no password was saved. ' +
              'Run `fskintra login` again.'
          : 'No ForældreIntra session. Run `fskintra login`, or set FSKINTRA_HOSTNAME, ' +
              'FSKINTRA_USERNAME and FSKINTRA_PASSWORD.',
      );
    }

    this.http.resetJar();
    const result = await this.login.login(credentials);
    this.indexDoc = result.doc;
    this.indexUrl = result.indexUrl;
    this.children = undefined;

    await this.persist({
      version: 1,
      hostname: normalizeHostname(credentials.hostname),
      username: credentials.username,
      // Only carry the password forward if it was already being stored (or the
      // caller supplied it explicitly). We never start storing it on our own.
      ...(record?.password || this.overrideCredentials ? { password: credentials.password } : {}),
      ...(record?.meta ? { meta: record.meta } : {}),
      cookies: result.cookies,
      indexUrl: result.indexUrl,
      saved_at: 0,
    });
  }

  private async persist(next: StoredSessionRecord): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    this.record = { ...next, saved_at: now, verified_at: now };
    try {
      await this.store.save(this.record);
    } catch (error) {
      // A read-only or unreadable store should degrade to "works, but doesn't
      // remember", not take the whole request down.
      this.logger.warn('client.session_persist_failed', { error: (error as Error).message });
    }
  }

  /** Forget the cached session in this process. Does not touch the store. */
  invalidate(): void {
    this.indexDoc = undefined;
    this.indexUrl = undefined;
    this.children = undefined;
  }

  /** The logged-in front page. */
  async getIndexDoc(force = false): Promise<Doc> {
    await this.authenticate(force);
    if (!this.indexDoc) throw new NotLoggedInError();
    return this.indexDoc;
  }

  /**
   * Fetch a page as the logged-in parent.
   *
   * Retries once through a full re-login when the response is really the login
   * screen. ForældreIntra returns 200 for that, so a status check alone would
   * hand the caller a page of navigation chrome and call it success.
   */
  async fetchPage(
    url: string,
    options: { method?: 'GET' | 'POST'; body?: URLSearchParams } = {},
  ): Promise<Doc> {
    const body = await this.fetchRaw(url, options);
    return parse(body);
  }

  /** Same retry semantics as `fetchPage`, but returns the raw body. */
  async fetchRaw(
    url: string,
    options: { method?: 'GET' | 'POST'; body?: URLSearchParams } = {},
  ): Promise<string> {
    await this.authenticate();
    const target = this.absUrl(url);

    let response = await this.http.follow(target, {
      ...(options.method ? { method: options.method } : {}),
      ...(options.body ? { body: options.body } : {}),
    });

    if (isLoginResponse(response.final.url, response.final.status)) {
      this.logger.info('client.session_expired_retrying', { url: target });
      this.invalidate();
      await this.authenticate(true);
      response = await this.http.follow(target, {
        ...(options.method ? { method: options.method } : {}),
        ...(options.body ? { body: options.body } : {}),
      });
      if (isLoginResponse(response.final.url, response.final.status)) {
        throw new SessionExpiredError(target);
      }
    }

    return response.final.body;
  }

  /**
   * Fetch and JSON-parse an endpoint (the conversations UI serves several).
   *
   * `fetchRaw` has already ruled out the login-page case, so a body that will
   * not parse means the endpoint changed shape — a parser bug, not an auth
   * problem, and it should be reported as one.
   */
  async fetchJson<T>(url: string): Promise<T> {
    const target = this.absUrl(url);
    const body = await this.fetchRaw(url);
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new FskintraClientError(
        `Expected JSON from ${target} but got ${body.length} bytes starting with ` +
          `${JSON.stringify(body.slice(0, 60))}.`,
      );
    }
  }

  /** Download an attachment or document with the session's cookies. */
  async download(url: string): Promise<{ contentType: string; data: Uint8Array }> {
    await this.authenticate();
    return this.http.requestBinary(this.absUrl(url));
  }

  // ------------------------------------------------------------- children ---

  async getChildren(force = false): Promise<Child[]> {
    if (this.children && !force) return this.children;
    const doc = await this.getIndexDoc(force);
    this.children = parseChildren(doc, (url) => this.absUrl(url));
    this.logger.info('client.children_found', {
      count: this.children.length,
      names: this.children.map((c) => c.name),
    });
    return this.children;
  }

  /**
   * Resolve a child by name (case-insensitive, prefix then substring) or id.
   * With no argument, returns the only child — or fails listing the options,
   * which is what an agent needs to ask a useful follow-up question.
   */
  async resolveChild(nameOrId?: string): Promise<Child> {
    const all = await this.getChildren();
    if (all.length === 0) {
      throw new Error('No children found on the ForældreIntra front page.');
    }
    if (!nameOrId) {
      if (all.length === 1) return all[0] as Child;
      throw new Error(
        `More than one child on this account; specify one of: ${all.map((c) => c.name).join(', ')}`,
      );
    }

    const needle = nameOrId.trim().toLowerCase();
    const match =
      all.find((c) => c.id === needle || c.name.toLowerCase() === needle) ??
      all.find((c) => c.name.toLowerCase().startsWith(needle)) ??
      all.find((c) => c.name.toLowerCase().includes(needle));

    if (!match) {
      throw new Error(
        `No child matching ${JSON.stringify(nameOrId)}. Known: ${all.map((c) => c.name).join(', ')}`,
      );
    }
    return match;
  }
}

/**
 * Build a child-scoped URL.
 *
 * Most sections hang off the prefix with a leading slash. The weekplan and
 * homework pages are the exception and concatenate directly, giving URLs like
 * `.../Andreaitem/weeklyplansandhomework/list/`. That looks like a bug in
 * ForældreIntra; fskintra reproduced it because the correct-looking URL 404s.
 */
export function childUrl(child: Child, suffix: string): string {
  if (!suffix.startsWith('/') && !suffix.startsWith('item/')) {
    throw new Error(`childUrl suffix must start with "/" or "item/": ${suffix}`);
  }
  return child.urlPrefix + suffix;
}

/** Pure parser, so the markup contract can be tested without the network. */
export function parseChildren(doc: Doc, absUrl: (url: string) => string): Child[] {
  // The currently selected child's own nav link renders with empty text; the
  // name is only in the personal-menu button.
  const selectedName = doc('#sk-personal-menu-button').first().text().replace(/\s+/g, ' ').trim();

  const byPrefix = new Map<string, Child>();
  doc('a[href]').each((_, el) => {
    const href = doc(el).attr('href');
    if (!href || !isChildLink(href)) return;

    // Strip /Index and any ?query/#fragment before forming the section prefix.
    // Uses [\s\S] not . so a newline in a query can't survive, matching how
    // isChildLink splits — the two must never disagree about the same href.
    const urlPrefix = absUrl(href.replace(/\/Index\/?(?:[?#][\s\S]*)?$/i, ''));
    if (byPrefix.has(urlPrefix)) return;

    const name = doc(el).text().replace(/\s+/g, ' ').trim() || selectedName;
    if (!name) return;

    byPrefix.set(urlPrefix, {
      name,
      id: new URL(urlPrefix).pathname.split('/')[2] ?? '',
      urlPrefix,
    });
  });

  return [...byPrefix.values()].sort((a, b) => a.name.localeCompare(b.name, 'da'));
}

function isLoginResponse(url: string, status: number): boolean {
  if (status === 401) return true;
  try {
    return LOGIN_PATH_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export { ConfirmContactsRequiredError };
