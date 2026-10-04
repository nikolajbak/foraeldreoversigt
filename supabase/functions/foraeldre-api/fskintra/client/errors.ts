/**
 * Typed errors the client surface throws. Subclassing FskintraAuthError keeps
 * callers' catch blocks focused on the kind of failure rather than on which
 * package raised it.
 */

import { FskintraAuthError } from '../auth/index.ts';

export class FskintraClientError extends FskintraAuthError {
  override readonly name: string = 'FskintraClientError';
}

/**
 * The school does not have this module enabled, or this account has no access
 * to it. ForældreIntra signals it with the phrase "ikke autoriseret" in the
 * page body, or by simply omitting the container we look for.
 *
 * This is the ForældreIntra analogue of aula-mcp's per-widget availability:
 * schools buy different modules, and an agent needs "not available here"
 * rather than an empty list it might report as "you have no homework".
 */
export class SectionUnavailableError extends FskintraClientError {
  override readonly name: string = 'SectionUnavailableError';
  constructor(
    public readonly section: string,
    message?: string,
  ) {
    super(message ?? `This school does not use ${section}, or your account has no access to it.`);
  }
}

/**
 * The markup we rely on was not on the page. Distinct from
 * SectionUnavailableError: that one means "correctly absent", this one means
 * "should have been there". Only the second is a bug report.
 */
export class SectionParseError extends FskintraClientError {
  override readonly name: string = 'SectionParseError';
  constructor(
    public readonly section: string,
    public readonly url: string,
    detail: string,
  ) {
    super(`Could not parse ${section} at ${url}: ${detail}`);
  }
}

/**
 * A page came back that is really the login screen.
 *
 * The same failure class as aula-mcp's dead widget JWT (upstream #311): the
 * server answers 200 OK with a body that means "you are not authenticated",
 * so a status-code check sees success. Detection lives in the client so no
 * call site can forget it.
 */
export class SessionExpiredError extends FskintraClientError {
  override readonly name: string = 'SessionExpiredError';
  constructor(public readonly url: string) {
    super(`The ForældreIntra session expired while fetching ${url}.`);
  }
}
