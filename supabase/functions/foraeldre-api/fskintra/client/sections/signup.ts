/**
 * Sign-ups for parent-teacher conversations and school events
 * ("tilmelding til samtaler/arrangementer").
 *
 * Rows whose status is "Lukket" are dropped: there is nothing to act on, and
 * an agent shown a closed sign-up will offer to book it.
 */

import { clean } from '../../auth/index.ts';
import { childUrl, type FskintraClient } from '../client.ts';
import type { Child, SignupEvent } from '../types.ts';

export async function getSignups(client: FskintraClient, child: Child): Promise<SignupEvent[]> {
  const events: SignupEvent[] = [];

  for (const kind of ['conversation', 'event'] as const) {
    const doc = await client.fetchPage(childUrl(child, `/signup/${kind}`));

    doc('.sk-signup-container ul.ccl-rwgm-row').each((_, ul) => {
      const row = doc(ul);
      if (row.hasClass('sk-grid-top-header')) return;

      const fields: { label: string; value: string }[] = [];
      let label = '';
      row.find('li').each((__, li) => {
        const text = clean(doc(li).text());
        if (doc(li).hasClass('sk-grid-inline-header')) {
          label = text.replace(/:$/, '');
        } else {
          fields.push({ label, value: text });
        }
      });

      const isClosed = fields.some((f) => /^status/i.test(f.label) && /^lukket/i.test(f.value));
      if (isClosed || fields.length === 0) return;

      const first = fields[0];
      if (!first) return;
      events.push({ kind, title: `${first.label}: ${first.value}`, fields });
    });
  }

  return events;
}
