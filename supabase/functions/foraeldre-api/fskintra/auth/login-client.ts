/**
 * The ForældreIntra login flow.
 *
 * Ported from `svalgaard/fskintra`'s `skoleintra/surllib.py:skoleLogin`, which
 * is the only written-down description of this flow that exists. It is a small
 * state machine rather than a linear script because the site can interpose
 * pages in any order:
 *
 *   /Fi/ ──redirects──> /Account/IdpLogin ──credentials POST──> SSO relay
 *                              │                        (auto-submit form)
 *                              │                                 │
 *                              │                                 ▼
 *                              └──> /ConfirmContacts ──> /parent/<id>/<name>/Index
 *
 * Each round looks at where we landed and decides the next move. Bounded at
 * MAX_ROUNDS so a redirect cycle fails loudly instead of hanging.
 *
 * Why no headless browser (the same reasoning as aula-mcp's MitID decision):
 *   - Playwright is ~300 MB of Chromium per platform for a flow that is three
 *     form posts.
 *   - A browser flow fails with "selector not found" or "navigation timeout".
 *     This one fails with "no login form at <url>" or "landed on <url> after 8
 *     rounds", which points at a line.
 *   - Every hop goes through the wire tracer, so a failing login produces a
 *     shareable, sanitised transcript.
 */

import { isChildLink } from './child-link.ts';
import {
  ConfirmContactsRequiredError,
  FskintraAuthError,
  InvalidCredentialsError,
  UniLoginNotSupportedError,
} from './errors.ts';
import { type Doc, findFormWithField, parse, serializeForm, textOf } from './html.ts';
import type { FskintraResponse } from './http.ts';
import { FskintraHttpClient } from './http.ts';
import type { Logger } from './logger.ts';
import { silentLogger } from './logger.ts';
import type { StoredSessionRecord } from './session-store.ts';

/** A logged-in front page looks like https://host/parent/1234/Andrea/Index */
const INDEX_RE = /\/parent\/[^/]+\/[^/]*\/Index\/?$/i;

/**
 * Where to go when authentication worked but the page it returned to is a
 * dead end. The site root is the installation's own answer to "where does
 * this user belong": with the assertion already consumed it renders the front
 * page directly, and if the session did not take it starts a fresh SAML round
 * trip, which the loop below knows how to walk.
 */
const LANDING_FALLBACK = '/';

const MAX_ROUNDS = 8;

/**
 * Ways into the parent flow, tried in order until one answers.
 *
 * `/Fi/` is ForældreIntra's own front door. It redirects via
 * `/Infoweb/Fi2/Default.asp` to `csiproxy/login?roleType=Parent`, through the
 * SAML IdP, and lands on a login form already stamped `RoleType=Parent` —
 * often on the school's `.m.` host rather than the one the user typed.
 *
 * `/Account/IdpLogin` is where that chain ends, and some installations serve
 * it directly on the school host. Others 404 it, which is what turned a
 * perfectly ordinary login into "no ordinary login form at …". Asking for the
 * front door first and the form second covers both.
 */
const ENTRY_PATHS = ['/Fi/', '/Account/IdpLogin'] as const;

export interface LoginCredentials {
  /** Bare hostname, e.g. `minskole.skoleintra.dk`. A full URL is accepted. */
  hostname: string;
  username: string;
  password: string;
}

export interface LoginClientOptions {
  http?: FskintraHttpClient;
  logger?: Logger;
  /**
   * Submit the periodic "Bekræft kontaktoplysninger" form automatically.
   * Off by default: confirming is a change the school sees, and this client
   * should not make it on the user's behalf without being told to.
   */
  autoConfirmContacts?: boolean;
}

export interface LoginResult {
  /** The parsed, logged-in front page. */
  doc: Doc;
  /** Absolute URL of the front page — worth persisting; it skips the chain. */
  indexUrl: string;
  /** Serialized cookie jar, for the session store. */
  cookies: string;
}

/** Normalise a pasted URL or bare host into a hostname. */
export function normalizeHostname(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
}

export class FskintraLoginClient {
  readonly http: FskintraHttpClient;
  private readonly logger: Logger;
  private readonly autoConfirmContacts: boolean;

  constructor(options: LoginClientOptions = {}) {
    this.logger = options.logger ?? silentLogger;
    this.http = options.http ?? new FskintraHttpClient({ logger: this.logger });
    this.autoConfirmContacts = options.autoConfirmContacts ?? false;
  }

  absUrl(hostname: string, url: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    return `https://${hostname}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  /**
   * Restore a previous session's cookies and check whether they still work by
   * fetching the cached front page. Returns undefined when there is nothing to
   * restore or the session is dead — the caller then runs a full `login()`.
   *
   * This is the cheap path, and the common one: it is a single GET.
   */
  async resume(record: StoredSessionRecord): Promise<LoginResult | undefined> {
    if (!record.cookies || !record.indexUrl) return undefined;

    await this.http.restoreJar(record.cookies);

    this.logger.debug('login.resume_attempt', { indexUrl: record.indexUrl });
    let response: FskintraResponse;
    try {
      const followed = await this.http.follow(record.indexUrl);
      response = followed.final;
    } catch (error) {
      this.logger.info('login.resume_failed', { error: (error as Error).message });
      return undefined;
    }

    const doc = parse(response.body);
    if (response.status !== 200 || !this.isFrontPage(doc, new URL(response.url))) {
      this.logger.info('login.resume_rejected', { url: response.url, status: response.status });
      return undefined;
    }

    return {
      doc,
      indexUrl: response.url,
      cookies: await this.http.jar.serialize(),
    };
  }

  /** Full login from credentials. */
  async login(credentials: LoginCredentials): Promise<LoginResult> {
    const hostname = normalizeHostname(credentials.hostname);
    this.logger.info('login.start', { hostname, username: credentials.username });

    let response = await this.openEntryPage(hostname);
    const triedLandings = new Set<string>();

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const doc = parse(response.body);
      const url = new URL(response.url);
      this.logger.debug('login.step', {
        round: round + 1,
        url: response.url,
        status: response.status,
      });

      // A front page by its URL shape is unambiguous — accept it early.
      if (response.body.length > 0 && INDEX_RE.test(url.pathname)) {
        this.logger.info('login.success', { indexUrl: response.url });
        return {
          doc,
          indexUrl: response.url,
          cookies: await this.http.jar.serialize(),
        };
      }

      if (url.hostname.endsWith('emu.dk') || /unilogin/i.test(url.hostname)) {
        throw new UniLoginNotSupportedError(url.hostname);
      }

      // Actionable interstitials come first. Each is rendered inside the site
      // chrome, which carries the child-switcher nav — so the link-based
      // front-page test below would swallow them if it ran first. Order is
      // load-bearing: ConfirmContacts, then relay, then the login form.
      if (/\/ConfirmContacts\/?$/i.test(url.pathname)) {
        response = await this.handleConfirmContacts(doc, response.url);
        continue;
      }

      // Relay detection comes BEFORE the credentials branch, as it does in
      // fskintra. An SSO relay can render at the same path the login form
      // uses, and matching on the URL alone would then re-submit credentials
      // into a form that has no username field.
      const relay = this.findRelayForm(doc, url) ?? undefined;
      if (relay?.explicit) {
        this.logger.debug('login.relay', { action: relay.action || response.url });
        response = (
          await this.http.follow(new URL(relay.action || response.url, response.url).toString(), {
            method: relay.method,
            ...(relay.method === 'POST' ? { body: relay.fields } : {}),
          })
        ).final;
        continue;
      }

      if (/\/Account\/(IdpLogin|Login)\/?$/i.test(url.pathname)) {
        response = await this.submitCredentials(doc, response.url, credentials);
        continue;
      }

      // A front page can live at a URL INDEX_RE has never heard of, recognised
      // by the child links it carries — the same links the client scrapes off
      // it a moment later. This must come BEFORE the generic single-form relay
      // below: a real ASP.NET front page wraps its whole body in one <form>,
      // which findRelayForm would otherwise submit back to the school's site.
      if (response.body.length > 0 && this.hasChildLinks(doc)) {
        this.logger.info('login.success', { indexUrl: response.url });
        return {
          doc,
          indexUrl: response.url,
          cookies: await this.http.jar.serialize(),
        };
      }

      // A lone, unnamed form is tried as a relay only after every known branch
      // is ruled out (fskintra orders it this way, because the login page is
      // also a lone form). Never on an error page: a 4xx/5xx rendered in site
      // chrome with a stray form is a dead landing, not a relay to follow.
      if (relay && response.status < 400) {
        this.logger.debug('login.relay_generic', { action: relay.action || response.url });
        response = (
          await this.http.follow(new URL(relay.action || response.url, response.url).toString(), {
            method: relay.method,
            ...(relay.method === 'POST' ? { body: relay.fields } : {}),
          })
        ).final;
        continue;
      }

      // Nothing here is actionable and it is not the front page. If the flow
      // returned an error status the SAML assertion has still been consumed
      // and the cookies set — the carried return URL (`/Fi/`, usually) is just
      // a page this installation does not serve. Either way, ask the site
      // where the user belongs. followLandingFallback tries each root once, so
      // a root that is itself a dead end fails the login rather than looping.
      const recovered = await this.followLandingFallback(response, hostname, triedLandings);
      if (!recovered) break;
      response = recovered;
    }

    throw new FskintraAuthError(
      `Login did not reach the ForældreIntra front page after ${MAX_ROUNDS} rounds. ` +
        `Last URL: ${response.url}. Re-run with --debug for a wire transcript.`,
    );
  }

  /**
   * Walk ENTRY_PATHS until one of them yields a page. A 404 means this
   * installation does not have that door, not that login is impossible, so it
   * is a reason to try the next path rather than to give up.
   */
  private async openEntryPage(hostname: string): Promise<FskintraResponse> {
    const attempts: string[] = [];
    let unreachable = 0;
    let firstCause: unknown;

    for (const path of ENTRY_PATHS) {
      const url = this.absUrl(hostname, path);
      let response: FskintraResponse;
      try {
        response = (await this.http.follow(url)).final;
      } catch (cause) {
        firstCause ??= cause;
        unreachable += 1;
        attempts.push(`${url} → ${(cause as Error).message}`);
        this.logger.debug('login.entry_unreachable', { url, error: (cause as Error).message });
        continue;
      }

      if (response.status >= 400) {
        // Any error here means "not this door", not "login impossible" — try
        // the next entry path. The loop's post-assertion recovery cannot apply
        // at round 0: no SAML assertion has been exchanged yet.
        attempts.push(`${url} → HTTP ${response.status}`);
        this.logger.debug('login.entry_missing', { url, status: response.status });
        continue;
      }

      this.logger.debug('login.entry', {
        url,
        landedOn: response.url,
        status: response.status,
      });
      return response;
    }

    // Two ways to have found no door, told apart by how they failed. Every
    // path throwing at the transport level is a bad hostname or dead network;
    // a mix of 404s and refusals is an installation that serves neither door,
    // which is a layout we don't recognise. The messages must differ: the
    // first points the user at their connection, the second at the URLs tried.
    if (unreachable === ENTRY_PATHS.length) {
      throw new FskintraAuthError(
        `Could not reach https://${hostname}. Check the hostname and your connection.`,
        { cause: firstCause },
      );
    }
    throw new FskintraAuthError(
      `No ForældreIntra login page on https://${hostname}. Tried:\n  ${attempts.join('\n  ')}`,
      firstCause ? { cause: firstCause } : undefined,
    );
  }

  /**
   * Is this the logged-in front page? By URL shape first, by the child links
   * it carries second. Used by `resume`, where either signal is enough to
   * trust a restored session.
   */
  private isFrontPage(doc: Doc, url: URL): boolean {
    if (INDEX_RE.test(url.pathname)) return true;
    return this.hasChildLinks(doc);
  }

  /** Does the page carry at least one child link? The content-only test. */
  private hasChildLinks(doc: Doc): boolean {
    return doc('a[href]')
      .toArray()
      .some((el) => isChildLink(doc(el).attr('href')));
  }

  /**
   * Retry a dead landing at the site root — first on the host we ended up on,
   * then on the one the user typed, since the flow can change hosts. Each
   * candidate is tried at most once per login, so a root that is itself a dead
   * end fails the login instead of looping on it.
   */
  private async followLandingFallback(
    from: FskintraResponse,
    hostname: string,
    tried: Set<string>,
  ): Promise<FskintraResponse | undefined> {
    const candidates = [
      new URL(LANDING_FALLBACK, from.url).toString(),
      this.absUrl(hostname, LANDING_FALLBACK),
    ];

    for (const candidate of candidates) {
      if (tried.has(candidate)) continue;
      tried.add(candidate);
      this.logger.debug('login.landing_fallback', {
        from: from.url,
        status: from.status,
        to: candidate,
      });
      try {
        return (await this.http.follow(candidate)).final;
      } catch (error) {
        // A fallback that cannot be fetched is not the story. Keep the dead
        // end we already have, so the error names it rather than the guess.
        this.logger.debug('login.landing_fallback_failed', {
          to: candidate,
          error: (error as Error).message,
        });
      }
    }
    return undefined;
  }

  private async submitCredentials(
    doc: Doc,
    currentUrl: string,
    credentials: LoginCredentials,
  ): Promise<FskintraResponse> {
    const pageText = textOf(doc, doc('body')).toLowerCase();
    if (pageText.includes('ikke adgang') || pageText.includes('forkert brugernavn')) {
      throw new InvalidCredentialsError(
        'ForældreIntra rejected the credentials. Check the username and password.',
      );
    }

    const form = findFormWithField(doc, 'UserName', 'Username', 'username');
    if (!form) {
      if (doc('a[href*="RedirectToUniLogin"]').length) {
        throw new UniLoginNotSupportedError(new URL(currentUrl).hostname);
      }
      throw new FskintraAuthError(
        `No ordinary login form at ${currentUrl}. The page layout may have changed, or ` +
          `JavaScript-based login protection is active.`,
      );
    }

    const userField =
      form.find('[name="UserName"], [name="Username"], [name="username"]').attr('name') ??
      'UserName';
    const passField = form.find('[name="Password"], [name="password"]').attr('name') ?? 'Password';

    const spec = serializeForm(doc, form, {
      [userField]: credentials.username,
      [passField]: credentials.password,
    });

    this.logger.debug('login.submit_credentials', { action: spec.action || currentUrl });
    return (
      await this.http.follow(new URL(spec.action || currentUrl, currentUrl).toString(), {
        method: 'POST',
        body: spec.fields,
      })
    ).final;
  }

  /**
   * The "Bekræft kontaktoplysninger" interstitial. fskintra clicks it
   * automatically; we don't, unless asked. Confirming tells the school the
   * details on file are correct, which is a statement the user should make,
   * not their MCP server.
   */
  private async handleConfirmContacts(doc: Doc, currentUrl: string): Promise<FskintraResponse> {
    const form = doc('.sk-l-content-wrapper form, form')
      .filter((_, el) => /Confirm\/?$/i.test(doc(el).attr('action') ?? ''))
      .first();

    const pageText = textOf(doc, doc('.sk-l-content-wrapper').first()) || textOf(doc, doc('body'));

    if (!form.length) {
      throw new ConfirmContactsRequiredError(currentUrl, pageText.slice(0, 2000));
    }
    if (!this.autoConfirmContacts) {
      throw new ConfirmContactsRequiredError(currentUrl, pageText.slice(0, 2000));
    }

    const spec = serializeForm(doc, form);
    this.logger.warn('login.auto_confirming_contacts', { url: currentUrl });
    return (
      await this.http.follow(new URL(spec.action, currentUrl).toString(), {
        method: 'POST',
        body: spec.fields,
      })
    ).final;
  }

  /**
   * SSO relay pages carry exactly one form that a browser would auto-submit
   * via JavaScript.
   *
   * `explicit` marks the two shapes fskintra actually observed — a form named
   * `relay`, or a page under `/sso/ssocomplete`. Those are safe to submit
   * before anything else. A lone unnamed form is the general case and is only
   * tried once the known branches have been ruled out, because the login page
   * is also a lone form.
   */
  private findRelayForm(
    doc: Doc,
    url: URL,
  ):
    | { action: string; method: 'GET' | 'POST'; fields: URLSearchParams; explicit: boolean }
    | undefined {
    const forms = doc('form');
    if (forms.length !== 1) return undefined;

    const form = forms.first();
    const explicit =
      url.pathname.toLowerCase().includes('/sso/ssocomplete') ||
      (form.attr('name') ?? '').toLowerCase() === 'relay';

    return { ...serializeForm(doc, form), explicit };
  }
}
