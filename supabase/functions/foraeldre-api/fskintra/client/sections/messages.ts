/**
 * Messages ("beskeder").
 *
 * The awkward part of ForældreIntra: schools run one of two entirely
 * different message UIs, and which one you get changes both the endpoints and
 * the data shape.
 *
 *   conversations — the newer, Gmail-like view. The conversation list is not
 *                   in the markup at all; it is JSON stashed in a data
 *                   attribute, and threads come from JSON endpoints.
 *   inbox         — the older view. Inbox/outbox pages of list items, each
 *                   linking to a message page that has to be scraped.
 *
 * fskintra sniffed which by looking at the "Besked" link in the top menu, and
 * so do we. Detection is cached per client because it cannot change mid-session.
 */

import {
  clean,
  type Doc,
  htmlToText,
  parseDanishDateTime,
  textOf,
} from '../../auth/index.ts';
import { childUrl, type FskintraClient } from '../client.ts';
import { SectionParseError } from '../errors.ts';
import type { Attachment, Child, ConversationSummary, Message, MessageUi } from '../types.ts';

const uiCache = new WeakMap<FskintraClient, MessageUi>();

export async function detectMessageUi(client: FskintraClient): Promise<MessageUi> {
  const cached = uiCache.get(client);
  if (cached) return cached;

  const doc = await client.getIndexDoc();
  let found: MessageUi | undefined;
  doc('a[href]').each((_, a) => {
    if (found) return false;
    if (!/besked/i.test(clean(doc(a).text()))) return undefined;
    const href = doc(a).attr('href');
    const last = href?.replace(/\/$/, '').split('/').pop();
    if (last === 'conversations' || last === 'inbox') found = last;
    return undefined;
  });

  // Default to the newer UI: a school on the old one still has the link, so
  // guessing "conversations" only misfires when the menu itself changed.
  const ui = found ?? 'conversations';
  uiCache.set(client, ui);
  return ui;
}

export async function listConversations(
  client: FskintraClient,
  child: Child,
): Promise<ConversationSummary[]> {
  const ui = await detectMessageUi(client);
  return ui === 'conversations'
    ? listFromConversations(client, child)
    : listFromTrays(client, child);
}

/**
 * Every message in a conversation, oldest first.
 *
 * `threadId` is empty for "threadless" conversations — messages broadcast to
 * all students, which ForældreIntra serves from a different endpoint.
 */
export async function getConversation(
  client: FskintraClient,
  child: Child,
  threadId: string,
  latestMessageId: string,
): Promise<Message[]> {
  const ui = await detectMessageUi(client);
  if (ui === 'inbox') return [await getTrayMessage(client, child, latestMessageId)];

  const suffix = threadId
    ? '/messages/conversations/loadmessagesforselectedconversation' +
      `?threadId=${encodeURIComponent(threadId)}` +
      `&takeFromRootMessageId=${encodeURIComponent(latestMessageId)}` +
      '&takeToMessageId=0&searchRequest='
    : '/messages/conversations/getmessageforthreadlessconversation' +
      `?messageId=${encodeURIComponent(latestMessageId)}`;

  // The cache-buster is what fskintra sends; without it the server has been
  // observed to serve a stale thread.
  const url = `${childUrl(child, suffix)}&_=${Date.now()}`;
  const payload = await client.fetchJson<RawMessage | RawMessage[]>(url);
  const raw = Array.isArray(payload) ? payload : [payload];
  return raw.map((m) => messageFromJson(m, threadId)).reverse();
}

export async function markRead(
  client: FskintraClient,
  child: Child,
  messageId: string,
  isRead = true,
): Promise<void> {
  await client.fetchRaw(childUrl(child, '/messages/UpdateMessagesReadState'), {
    method: 'POST',
    body: new URLSearchParams({
      'selectionState[MessageIds][]': messageId,
      isRead: String(isRead),
    }),
  });
}

// ---------------------------------------------------------------- new UI ---

interface RawMessage {
  Id: number | string;
  Subject?: string;
  SenderName?: string;
  SentReceivedDateText?: string;
  BaseText?: string;
  PreviousMessagesText?: string;
  Recipients?: string[] | Record<string, { Name?: string }[]>;
  AttachmentsLinks?: { HrefAttributeValue: string; Text: string }[] | null;
  ShowUnreadIndication?: boolean;
}

interface RawConversation {
  ThreadId?: string;
  LatestMessageId?: number | string;
  Subject?: string;
  SenderName?: string;
  SentReceivedDateText?: string;
  ShowUnreadIndication?: boolean;
}

export function messageFromJson(json: RawMessage, threadId: string): Message {
  const dateText = clean(json.SentReceivedDateText);
  const date = parseDanishDateTime(dateText);
  const quoted = json.PreviousMessagesText ? htmlToText(json.PreviousMessagesText) : undefined;

  return {
    id: String(json.Id),
    ...(threadId ? { threadId } : {}),
    subject: clean(json.Subject) || '(uden emne)',
    sender: clean(json.SenderName),
    recipients: normalizeRecipients(json.Recipients),
    ...(date ? { date } : {}),
    dateText,
    body: htmlToText(json.BaseText ?? ''),
    ...(quoted ? { quoted } : {}),
    attachments: (json.AttachmentsLinks ?? []).map((a) => ({
      name: clean(a.Text),
      url: a.HrefAttributeValue,
    })),
    unread: json.ShowUnreadIndication === true,
  };
}

/**
 * Recipients were a plain array until August 2025, when they became a map
 * keyed by group with the flat list under "". Both shapes are still in the
 * wild depending on the school's version.
 */
export function normalizeRecipients(recipients: RawMessage['Recipients']): string[] {
  if (!recipients) return [];
  if (Array.isArray(recipients)) return recipients.map((r) => clean(r)).filter(Boolean);
  return Object.values(recipients)
    .flat()
    .map((r) => clean(r?.Name))
    .filter(Boolean);
}

async function listFromConversations(
  client: FskintraClient,
  child: Child,
): Promise<ConversationSummary[]> {
  const url = childUrl(child, '/messages/conversations');
  const doc = await client.fetchPage(url);
  const conversations = findConversationsJson(doc);

  if (!conversations) {
    throw new SectionParseError(
      'messages',
      url,
      'no conversation JSON on the page (looked for a data attribute containing "message")',
    );
  }

  return conversations
    .filter((c) => c.LatestMessageId)
    .map((c) => ({
      threadId: c.ThreadId ?? '',
      latestMessageId: String(c.LatestMessageId),
      subject: clean(c.Subject) || '(uden emne)',
      sender: clean(c.SenderName),
      dateText: clean(c.SentReceivedDateText),
      unread: c.ShowUnreadIndication === true,
    }));
}

/**
 * The conversation list is JSON on some div's data attribute. We search by the
 * attribute's *shape* rather than its name, because the name has changed
 * before and a fixed selector would break silently on the next rename.
 */
export function findConversationsJson(doc: Doc): RawConversation[] | undefined {
  let result: RawConversation[] | undefined;

  doc('.sk-l-content-wrapper div').each((_, el) => {
    if (result) return false;
    for (const [name, value] of Object.entries(el.attribs ?? {})) {
      if (!name.toLowerCase().includes('message') || value.length < 100) continue;
      try {
        const parsed = JSON.parse(value) as { Conversations?: RawConversation[] };
        if (parsed && Array.isArray(parsed.Conversations)) {
          result = parsed.Conversations;
          return false;
        }
      } catch {
        // Not the attribute we're after — keep looking.
      }
    }
    return undefined;
  });

  return result;
}

// ---------------------------------------------------------------- old UI ---

async function listFromTrays(client: FskintraClient, child: Child): Promise<ConversationSummary[]> {
  const out: ConversationSummary[] = [];

  for (const tray of ['inbox', 'outbox'] as const) {
    const doc = await client.fetchPage(childUrl(child, `/messages/${tray}`));
    doc('.sk-message-list-item').each((_, el) => {
      const item = doc(el);
      const href = item.find('a[href]').first().attr('href') ?? '';
      const id = /\/message\/(\d+)/.exec(href)?.[1];
      if (!id) return;

      // Senders render as "Jens Hansen (klasselærer)".
      const sender = clean(item.find('.sk-message-senderrecipient-name').first().text()).replace(
        /\s*\(.*\)$/,
        '',
      );

      out.push({
        threadId: '',
        latestMessageId: id,
        subject: clean(item.find('.sk-message-title').first().text()) || '(uden emne)',
        sender,
        dateText: clean(item.find('.sk-message-send-date').first().text()),
        unread: item.hasClass('sk-message-unread') || item.find('.sk-unread').length > 0,
      });
    });
  }

  return out;
}

async function getTrayMessage(
  client: FskintraClient,
  child: Child,
  messageId: string,
): Promise<Message> {
  const doc = await client.fetchPage(childUrl(child, `/messages/message/${messageId}`));

  const titled = doc(
    '.sk-message-title-rows-container div.sk-message-senderrecipient-name',
  ).first();
  const recipients = (
    titled.length ? titled : doc('div.sk-message-senderrecipient-name').first()
  ).clone();
  recipients.find('span').first().remove(); // "Til:"
  recipients.find('a.sk-message-show-more-link').remove();

  const dateText = clean(doc('div.sk-message-send-date').first().text());
  const date = parseDanishDateTime(dateText);
  // The reply/forward block is the div that follows the body and its link.
  const quotedNode = doc('div.sk-message-text + a + div').first();

  const attachments: Attachment[] = [];
  doc('div.sk-attachments-list a[href]').each((_, a) => {
    const href = doc(a).attr('href');
    if (href) attachments.push({ name: clean(doc(a).text()), url: href });
  });

  return {
    id: messageId,
    subject: clean(doc('div.sk-message-subject-text').first().text()) || '(uden emne)',
    sender: clean(doc('.sk-message-sender-name, .sk-message-senderrecipient-name').first().text()),
    recipients: clean(recipients.text())
      .split(/\s*(?:,|\bog\b)\s*/)
      .filter(Boolean),
    ...(date ? { date } : {}),
    dateText,
    body: textOf(doc, doc('div.sk-message-text').first()),
    ...(quotedNode.length ? { quoted: textOf(doc, quotedNode) } : {}),
    attachments,
    unread: false,
  };
}
