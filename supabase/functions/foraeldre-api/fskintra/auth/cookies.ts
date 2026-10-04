/**
 * Cookie jar wrapper around `tough-cookie`. A real jar (not a single-host Map)
 * is required because the ForældreIntra login walks an SSO relay chain that
 * can cross hosts, and cookies set on an intermediate hop have to survive to
 * the final one.
 *
 * Parse failures are logged rather than silently swallowed — a dropped cookie
 * turns into an opaque "bounced back to the login page" hours later, and the
 * log line is what makes that diagnosable.
 */

import { Cookie, CookieJar } from 'npm:tough-cookie@^6.0.2';
import type { Logger } from './logger.ts';
import { silentLogger } from './logger.ts';

export interface FskintraCookieJarOptions {
  jar?: CookieJar;
  logger?: Logger;
}

export class FskintraCookieJar {
  private readonly jar: CookieJar;
  private readonly logger: Logger;

  constructor(opts: FskintraCookieJarOptions | CookieJar = {}) {
    if (opts instanceof CookieJar) {
      this.jar = opts;
      this.logger = silentLogger;
    } else {
      this.jar = opts.jar ?? new CookieJar();
      this.logger = opts.logger ?? silentLogger;
    }
  }

  /** Parse and store every Set-Cookie header from a response. */
  async storeFromResponse(headers: Headers, requestUrl: string): Promise<void> {
    for (const sc of headers.getSetCookie()) {
      const parsed = Cookie.parse(sc);
      if (!parsed) {
        this.logger.warn('cookies.parse_failed', { snippet: sc.slice(0, 80), requestUrl });
        continue;
      }
      try {
        await this.jar.setCookie(parsed, requestUrl);
      } catch (e) {
        // tough-cookie throws on domain/path mismatch, expiry, etc. One bad
        // cookie shouldn't abort a request, but we do want to know.
        this.logger.warn('cookies.set_failed', {
          name: parsed.key,
          domain: parsed.domain ?? '<implicit>',
          requestUrl,
          error: (e as Error).message,
        });
      }
    }
  }

  /** Cookie header value to send with a request, or empty string if none apply. */
  async cookieHeader(url: string): Promise<string> {
    return this.jar.getCookieString(url);
  }

  /** Look up a single cookie by name — handy for anti-forgery tokens. */
  async getCookieValue(url: string, name: string): Promise<string | undefined> {
    const cookies = await this.jar.getCookies(url);
    return cookies.find((c) => c.key === name)?.value;
  }

  /** Serialize the entire jar — for persistence across CLI invocations. */
  async serialize(): Promise<string> {
    return JSON.stringify(await this.jar.serialize());
  }

  /** Restore a previously-serialized jar. */
  static async deserialize(serialized: string): Promise<FskintraCookieJar> {
    const jar = await CookieJar.deserialize(JSON.parse(serialized));
    return new FskintraCookieJar(jar);
  }
}
