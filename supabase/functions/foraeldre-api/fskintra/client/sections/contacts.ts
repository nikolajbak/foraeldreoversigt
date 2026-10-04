/**
 * Contact cards for the pupils in a child's class.
 *
 * The card is a flat run of `h2` headings and label/value span pairs rather
 * than a table, so section membership has to be tracked while walking it.
 */

import { clean } from '../../auth/index.ts';
import { childUrl, type FskintraClient } from '../client.ts';
import { SectionParseError } from '../errors.ts';
import type { Child, ContactCard } from '../types.ts';

export async function getContacts(client: FskintraClient, child: Child): Promise<ContactCard[]> {
  const listUrl = childUrl(child, '/contacts/students/cards');
  const doc = await client.fetchPage(listUrl);

  const urls: string[] = [];
  doc('#sk-toolbar-contact-dropdown option[value]').each((_, opt) => {
    const value = doc(opt).attr('value');
    if (value) urls.push(client.absUrl(value));
  });

  if (urls.length === 0) {
    throw new SectionParseError('contacts', listUrl, 'no pupils in #sk-toolbar-contact-dropdown');
  }

  const cards: ContactCard[] = [];
  for (const url of urls) {
    const cardDoc = await client.fetchPage(url);
    const name = clean(cardDoc('.sk-contact-person-name span.sk-labeledtext-value').first().text());

    const fields: ContactCard['fields'] = [];
    let section = '';
    cardDoc('div.text-block')
      .first()
      .find('h2, div')
      .each((_, el) => {
        const node = cardDoc(el);
        if (el.tagName?.toLowerCase() === 'h2') {
          section = clean(node.text());
          return;
        }
        const spans = node.children('span');
        if (spans.length < 2) return;
        const label = clean(spans.eq(0).text()).replace(/:$/, '');
        const value = clean(spans.eq(1).text());
        if (label || value) fields.push({ section, label, value });
      });

    cards.push({ name, url, fields });
  }

  return cards;
}
