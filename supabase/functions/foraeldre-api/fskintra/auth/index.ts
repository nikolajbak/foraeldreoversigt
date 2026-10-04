/**
 * Public surface of `@fskintra-mcp/fskintra-auth`.
 *
 * This layer knows about HTTP, cookies, the ForældreIntra login form and how
 * to persist a session. It knows nothing about what a ForældreIntra *page*
 * contains — that is `fskintra-client`'s job. Keeping the boundary strict
 * means anyone who just wants an authenticated session can use this package
 * without buying into MCP.
 */

export { isChildLink } from './child-link.ts';
export type { FskintraCookieJarOptions } from './cookies.ts';
export { FskintraCookieJar } from './cookies.ts';
export {
  aesGcmDecrypt,
  aesGcmEncrypt,
  randomBase64Url,
  randomBytes,
  sha256,
} from './crypto.ts';
export { base64url, bytesToHex, hexToBytes } from './encoding.ts';
export {
  ConfirmContactsRequiredError,
  FskintraAuthError,
  HtmlParseError,
  InvalidCredentialsError,
  NotLoggedInError,
  RedirectLoopError,
  UniLoginNotSupportedError,
} from './errors.ts';
export type { Doc, FormSpec, Node } from './html.ts';
export {
  clean,
  findFormWithField,
  htmlToText,
  parse,
  parseDanishDateTime,
  serializeForm,
  textOf,
} from './html.ts';
export type {
  FollowOptions,
  FollowResult,
  FskintraHttpClientOptions,
  FskintraResponse,
  RedirectStep,
  RequestOptions,
} from './http.ts';
export { DEFAULT_HEADERS, FskintraHttpClient } from './http.ts';
export type { Logger } from './logger.ts';
export { consoleLogger, silentLogger, stderrLogger } from './logger.ts';
export type { LoginClientOptions, LoginCredentials, LoginResult } from './login-client.ts';
export { FskintraLoginClient, normalizeHostname } from './login-client.ts';
export type { SessionStore, StoredSessionRecord } from './session-store.ts';
export {
  canReauthenticate,
  defaultConfigDir,
  EncryptedFileSessionStore,
  MemorySessionStore,
  SessionStoreError,
} from './session-store.ts';
export type { WireEntry, WireTracer } from './wire-tracer.ts';
export {
  formatTraceText,
  InMemoryTracer,
  JsonlFileTracer,
  noopTracer,
  SECRET_BODY_FIELDS,
  SECRET_HEADERS,
  SECRET_URL_PARAMS,
  sanitizeHeaders,
  sanitizeRequestBody,
  sanitizeResponseBody,
  sanitizeUrl,
} from './wire-tracer.ts';
