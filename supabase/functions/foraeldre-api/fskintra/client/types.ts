/** Shared domain types across the section parsers. */

export interface Child {
  /** Display name as ForældreIntra shows it, e.g. "Andrea 3A". */
  name: string;
  /** Numeric id from the URL, e.g. "1234". */
  id: string;
  /** Absolute prefix, e.g. https://host/parent/1234/Andrea */
  urlPrefix: string;
}

export interface Attachment {
  name: string;
  url: string;
}

export interface NewsItem {
  id: string;
  title: string;
  author: string;
  recipients: string[];
  /** ISO-8601 local date-time, when the Danish timestamp could be parsed. */
  date?: string;
  /** The timestamp exactly as ForældreIntra rendered it. Never lossy. */
  dateText: string;
  body: string;
  attachments: Attachment[];
  commentCount: number;
  comments?: string[];
}

export interface Frontpage {
  child: string;
  reminders: string[];
  news: NewsItem[];
}

/**
 * ForældreIntra ships two message UIs and a school is on one or the other.
 * Which one decides both the list endpoint and the shape of a thread.
 */
export type MessageUi = 'conversations' | 'inbox';

export interface Message {
  id: string;
  threadId?: string;
  subject: string;
  sender: string;
  recipients: string[];
  date?: string;
  dateText: string;
  body: string;
  /** Quoted earlier messages, when this one is a reply. */
  quoted?: string;
  attachments: Attachment[];
  unread: boolean;
}

export interface ConversationSummary {
  threadId: string;
  latestMessageId: string;
  subject: string;
  sender: string;
  dateText: string;
  unread: boolean;
}

export interface WeekplanDay {
  day: string;
  date: string;
  entries: string[];
}

export interface Weekplan {
  /** Week identifier from the URL, e.g. "35-2018". */
  id: string;
  title: string;
  url: string;
  days: WeekplanDay[];
  /**
   * True when this plan could not be fully loaded — the detail page was broken
   * or absent, so only the list-level title/link is present and `days` is empty
   * for that reason (not because the week is genuinely empty). Distinguishes
   * "broken/unloaded" from a real empty week at the output boundary.
   */
  partial?: true;
}

export interface WeekplanLink {
  id: string;
  title: string;
  url: string;
}

export interface HomeworkEntry {
  subject: string;
  text: string;
}

export interface HomeworkGroup {
  /** Due-date heading, e.g. "Mandag, 3. sep. 2018:". */
  due: string;
  entries: HomeworkEntry[];
}

export interface Homework {
  title: string;
  url: string;
  groups: HomeworkGroup[];
}

export interface Document {
  name: string;
  folder: string;
  url: string;
  date?: string;
  dateText: string;
}

export interface PhotoAlbum {
  title: string;
  url: string;
  photos: string[];
}

export interface ContactCard {
  name: string;
  url: string;
  fields: { section: string; label: string; value: string }[];
}

export interface SignupEvent {
  kind: 'conversation' | 'event';
  title: string;
  fields: { label: string; value: string }[];
}

/** The functional areas the client can serve. Keys of the discover manifest. */
export const SECTION_IDS = [
  'news',
  'messages',
  'weekplans',
  'homework',
  'documents',
  'photos',
  'contacts',
  'signups',
] as const;

export type SectionId = (typeof SECTION_IDS)[number];

export interface SectionStatus {
  id: SectionId;
  /** Danish label, matching what the site calls it. */
  label: string;
  available: boolean;
  /** Why it is unavailable, or a note about how it was detected. */
  note?: string;
}
