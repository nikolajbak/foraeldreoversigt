/**
 * Front page ("opslagstavle") news.
 *
 * Selector contract, from fskintra's `pgFrontpage.py`:
 *   div.sk-news-item[data-feed-item-id]
 *     div.sk-news-item-author      — sender span, then the recipient list
 *     div.sk-news-item-timestamp   — Danish timestamp, "(opdateret …)" suffix
 *     div.sk-news-item-content     — body, plus attachments and comments
 *   ul.sk-reminders-container      — birthdays and today's activities
 */

import { clean, type Doc, parseDanishDateTime, textOf } from '../../auth/index.ts';
import type { Element } from 'npm:domhandler@^6.0.1';
import { childUrl, type FskintraClient } from '../client.ts';
import type { Attachment, Child, Frontpage, NewsItem } from '../types.ts';

export interface GetFrontpageOptions {
  /** Fetch comments too — one extra request per commented item. */
  includeComments?: boolean;
}

export async function getFrontpage(
  client: FskintraClient,
  child: Child,
  options: GetFrontpageOptions = {},
): Promise<Frontpage> {
  const doc = await client.fetchPage(childUrl(child, '/Index'));
  const frontpage = parseFrontpage(doc, child.name, (url) => client.absUrl(url));

  if (options.includeComments) {
    for (const item of frontpage.news) {
      if (item.commentCount > 0 && item.id) {
        item.comments = await getComments(client, child, item.id, item.commentCount);
      }
    }
  }

  return frontpage;
}

/** Pure parser, so the markup contract can be tested without the network. */
export function parseFrontpage(
  doc: Doc,
  childName: string,
  absUrl: (url: string) => string,
): Frontpage {
  const reminders: string[] = [];
  doc('ul.sk-reminders-container > li').each((_, li) => {
    const text = clean(doc(li).text());
    // "Der er aktiviteter i dag" is a permanent fixture, not news.
    if (text && !/der er aktiviteter i dag/i.test(text)) reminders.push(text);
  });

  const news = doc('div.sk-news-item')
    .toArray()
    .map((el) => parseNewsItem(doc, el, absUrl));

  return { child: childName, reminders, news };
}

function parseNewsItem(doc: Doc, el: Element, absUrl: (url: string) => string): NewsItem {
  const item = doc(el);

  const content = item.find('div.sk-news-item-content').first().clone();
  content.find('.sk-attachments-list, .sk-news-item-comments').remove();
  const body = textOf(doc, content);

  const author = item.find('div.sk-news-item-author').first();
  const authorName = clean(author.find('span').first().text());

  // Whatever remains in the author line once the sender, the "til" label and
  // the show-more link are gone is the recipient list.
  const recipientLine = author.clone();
  recipientLine.find('span').first().remove();
  recipientLine.find('.sk-news-item-for, a.sk-news-show-more-link').remove();
  // The " og " separator is its own element; dropping it outright would glue
  // the last two names together.
  recipientLine.find('.sk-news-item-and').replaceWith(', ');
  const recipients = clean(recipientLine.text())
    .split(/\s*(?:,|\bog\b)\s*/)
    .map((r) => r.trim())
    .filter(Boolean);

  // "25. jun. 2018 16:26 (opdateret 26. jun. 2018)" — keep the original
  // timestamp and drop the edit note, opening parenthesis included. fskintra
  // splits on the bare word and leaves a dangling "(".
  const dateText = (
    clean(item.find('div.sk-news-item-timestamp').text()).split(/\(?\s*opdateret/i)[0] ?? ''
  ).trim();

  const attachments: Attachment[] = [];
  item.find('div.sk-attachments-list a[href]').each((_, a) => {
    const href = doc(a).attr('href');
    if (href) attachments.push({ name: clean(doc(a).text()), url: absUrl(href) });
  });

  const commentsBlock = item.find('div.sk-news-item-comments');
  const commentCount = Number(/vis (\d+) kommentar/i.exec(clean(commentsBlock.text()))?.[1] ?? 0);

  const date = parseDanishDateTime(dateText);

  return {
    id: item.attr('data-feed-item-id') ?? '',
    title: (body.split('\n')[0] ?? '').replace(/[ .]+$/, '').trim(),
    author: authorName,
    recipients,
    ...(date ? { date } : {}),
    dateText,
    body,
    attachments,
    commentCount,
  };
}

/**
 * Comments are lazy-loaded: the count goes in the POST body as `_`, and the
 * server renders that many. Undocumented, and taken from fskintra.
 */
async function getComments(
  client: FskintraClient,
  child: Child,
  itemId: string,
  count: number,
): Promise<string[]> {
  const doc = await client.fetchPage(childUrl(child, `/news/pins/${itemId}/comments`), {
    method: 'POST',
    body: new URLSearchParams({ _: String(count) }),
  });

  const comments: string[] = [];
  doc('.sk-comments-container .sk-comment, .sk-comments-container li').each((_, el) => {
    const text = textOf(doc, doc(el));
    if (text) comments.push(text);
  });

  if (comments.length === 0) {
    const all = textOf(doc, doc('.sk-comments-container'));
    if (all) comments.push(all);
  }
  return comments;
}
