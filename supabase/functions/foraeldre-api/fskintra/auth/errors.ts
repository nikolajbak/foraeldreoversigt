/**
 * Base error for everything the auth package throws. Subclass for distinct
 * failure modes that callers should branch on — the MCP tools turn each of
 * these into a different structured response, so "which class" is load-bearing.
 */
export class FskintraAuthError extends Error {
  override readonly name: string = 'FskintraAuthError';
  override readonly cause: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.cause = options?.cause;
  }
}

export class RedirectLoopError extends FskintraAuthError {
  override readonly name: string = 'RedirectLoopError';
  constructor(
    public readonly hops: number,
    public readonly lastUrl: string,
  ) {
    super(`Exceeded ${hops} redirect hops; stuck at ${lastUrl}`);
  }
}

export class HtmlParseError extends FskintraAuthError {
  override readonly name: string = 'HtmlParseError';
  constructor(
    message: string,
    public readonly snippet?: string,
  ) {
    super(message);
  }
}

/** Credentials were rejected by ForældreIntra. Re-running login won't help. */
export class InvalidCredentialsError extends FskintraAuthError {
  override readonly name: string = 'InvalidCredentialsError';
}

/**
 * The school redirected to UNI-Login. This client only implements the
 * ordinary ForældreIntra login ("alm login"), so we stop with a specific
 * error rather than half-walking a flow we don't support.
 */
export class UniLoginNotSupportedError extends FskintraAuthError {
  override readonly name: string = 'UniLoginNotSupportedError';
  constructor(public readonly host: string) {
    super(
      `The school redirected to UNI-Login (${host}). This client supports ordinary ` +
        `ForældreIntra login only.`,
    );
  }
}

/**
 * ForældreIntra is blocking login with the periodic "Bekræft
 * kontaktoplysninger" page. Confirming is a change the school sees, so we
 * surface it as a typed error and let the caller decide — the MCP tool turns
 * this into a structured `confirm_contacts_required` payload rather than
 * returning empty data.
 *
 * The same shape as aula-mcp's step-up error, and for the same reason: an
 * agent can act on "you must do X" but can't act on an empty list.
 */
export class ConfirmContactsRequiredError extends FskintraAuthError {
  override readonly name: string = 'ConfirmContactsRequiredError';
  constructor(
    public readonly url: string,
    /** The visible text of the confirmation page, so the agent can relay it. */
    public readonly pageText: string,
  ) {
    super(`ForældreIntra requires you to confirm your contact details before continuing (${url}).`);
  }
}

/** No stored session and no credentials in the environment. */
export class NotLoggedInError extends FskintraAuthError {
  override readonly name: string = 'NotLoggedInError';
  constructor(message = 'No ForældreIntra session. Run `fskintra login` first.') {
    super(message);
  }
}
