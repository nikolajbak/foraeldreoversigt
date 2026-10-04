/** Every section parser, re-exported under one roof. */

export { probeSections, SECTION_LABELS } from './availability.ts';
export { getContacts } from './contacts.ts';
export { collectDocuments, getDocuments } from './documents.ts';
export { getHomework } from './homework.ts';
export {
  detectMessageUi,
  findConversationsJson,
  getConversation,
  listConversations,
  markRead,
  messageFromJson,
  normalizeRecipients,
} from './messages.ts';
export type { GetFrontpageOptions } from './news.ts';
export { getFrontpage, parseFrontpage } from './news.ts';
export { getPhotoAlbums } from './photos.ts';
export { getSignups } from './signup.ts';
export {
  assertAuthorized,
  getWeekplan,
  getWeekplans,
  listWeekplans,
  parseWeekplan,
} from './weekplans.ts';
