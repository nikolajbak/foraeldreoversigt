/**
 * Public surface of `@fskintra-mcp/fskintra-client`.
 *
 * This layer knows what a ForældreIntra page contains. It does not know about
 * MCP, Hono, or the CLI — those are leaves that wire this package together
 * with `fskintra-auth`.
 */

export type { FskintraClientOptions } from './client.ts';
export {
  childUrl,
  credentialsFromEnv,
  FskintraClient,
  parseChildren,
} from './client.ts';
export {
  FskintraClientError,
  SectionParseError,
  SectionUnavailableError,
  SessionExpiredError,
} from './errors.ts';
export * from './sections/index.ts';
export type {
  Attachment,
  Child,
  ContactCard,
  ConversationSummary,
  Document,
  Frontpage,
  Homework,
  HomeworkEntry,
  HomeworkGroup,
  Message,
  MessageUi,
  NewsItem,
  PhotoAlbum,
  SectionId,
  SectionStatus,
  SignupEvent,
  Weekplan,
  WeekplanDay,
  WeekplanLink,
} from './types.ts';
export { SECTION_IDS } from './types.ts';
