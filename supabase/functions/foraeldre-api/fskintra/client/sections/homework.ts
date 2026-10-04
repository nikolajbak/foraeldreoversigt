/**
 * Homework ("lektier").
 *
 * Three hops, which is why this is the most fragile section: the diary
 * overview links to a class page, that page carries a "view all notes" link,
 * and that link is extended with /NextMonth so the coming month is included.
 */

import { clean, textOf } from '../../auth/index.ts';
import { childUrl, type FskintraClient } from '../client.ts';
import type { Child, Homework, HomeworkEntry, HomeworkGroup } from '../types.ts';
import { assertAuthorized } from './weekplans.ts';

export async function getHomework(client: FskintraClient, child: Child): Promise<Homework[]> {
  const doc = await client.fetchPage(childUrl(child, 'item/weeklyplansandhomework/diary/'));

  const columns = doc('li.ccl-rwgm-column-1-2.sk-grid-priority-column');
  if (!columns.length) {
    assertAuthorized(doc, 'lektier (homework)');
    return [];
  }

  const classUrls = new Set<string>();
  columns.find('a[href]').each((_, a) => {
    const href = doc(a).attr('href');
    if (href) classUrls.add(client.absUrl(href));
  });

  const result: Homework[] = [];
  for (const classUrl of classUrls) {
    const classDoc = await client.fetchPage(classUrl);
    const viewAll = classDoc('a#sk-diary-notes-view-all[href]').first().attr('href');
    if (!viewAll) continue;

    const url = `${client.absUrl(viewAll)}/NextMonth`;
    const notes = await client.fetchPage(url);

    const groups: HomeworkGroup[] = [];
    notes('ul.sk-list > li').each((_, li) => {
      const item = notes(li);
      const due = clean(item.find('div.sk-white-box > b').first().text());
      if (!due) return;

      const entries: HomeworkEntry[] = [];
      item.find('table tbody tr').each((__, tr) => {
        const cells = notes(tr).children('td, th');
        if (cells.length < 2) return;
        const subject = clean(cells.eq(0).text());
        const text = textOf(notes, cells.eq(1));
        if (subject && text) entries.push({ subject, text });
      });

      if (entries.length) groups.push({ due, entries });
    });

    if (groups.length) {
      result.push({ title: clean(classDoc('h3').first().text()), url, groups });
    }
  }

  return result;
}
