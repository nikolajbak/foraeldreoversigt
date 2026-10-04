/**
 * Which sections this school actually has.
 *
 * ForældreIntra is modular: a school buys weekly plans but not homework, photos
 * but not sign-ups. There is no manifest anywhere that says which — the only
 * way to find out is to ask for a page and read what comes back.
 *
 * This is the ForældreIntra counterpart of aula-mcp's widget detection, and it
 * matters for the same reason: an agent told "you have no homework" will say
 * so to the parent, when the truth is "this school does not use that module".
 * Those two answers must not collapse into the same empty array.
 *
 * Probing costs one request per section, so results are cached per child and
 * `discover` is the only thing that runs the full sweep.
 */

import { clean } from '../../auth/index.ts';
import { childUrl, type FskintraClient } from '../client.ts';
import { SectionUnavailableError } from '../errors.ts';
import { type Child, SECTION_IDS, type SectionId, type SectionStatus } from '../types.ts';

/** Danish labels, matching what the site calls each area. */
export const SECTION_LABELS: Readonly<Record<SectionId, string>> = Object.freeze({
  news: 'Forside / opslagstavle',
  messages: 'Beskeder',
  weekplans: 'Ugeplaner',
  homework: 'Lektier',
  documents: 'Dokumenter',
  photos: 'Billeder',
  contacts: 'Kontaktinformation',
  signups: 'Tilmelding til samtaler/arrangementer',
});

/**
 * One cheap probe per section: fetch the landing page and look for the
 * container the parser needs. We check for the container rather than for
 * emptiness — a school that uses weekly plans but has posted none still has
 * `ul.sk-weekly-plans-list-container` on the page.
 */
const PROBES: Readonly<Record<SectionId, { path: string; selector: string }>> = Object.freeze({
  news: { path: '/Index', selector: 'div.sk-news-item, ul.sk-reminders-container' },
  messages: { path: '/messages/conversations', selector: '.sk-l-content-wrapper' },
  weekplans: {
    path: 'item/weeklyplansandhomework/list/',
    selector: 'ul.sk-weekly-plans-list-container',
  },
  homework: {
    path: 'item/weeklyplansandhomework/diary/',
    selector: 'li.ccl-rwgm-column-1-2.sk-grid-priority-column',
  },
  documents: { path: '/documents/class', selector: 'div.sk-document, #FoldersJson' },
  photos: { path: '/photos/archives', selector: '#sk-photos-toolbar-filter' },
  contacts: { path: '/contacts/students/cards', selector: '#sk-toolbar-contact-dropdown' },
  signups: { path: '/signup/conversation', selector: '.sk-signup-container' },
});

const cache = new WeakMap<FskintraClient, Map<string, SectionStatus[]>>();

export async function probeSections(
  client: FskintraClient,
  child: Child,
  options: { force?: boolean; only?: readonly SectionId[] } = {},
): Promise<SectionStatus[]> {
  const perClient = cache.get(client) ?? new Map<string, SectionStatus[]>();
  cache.set(client, perClient);

  const cached = perClient.get(child.id);
  if (cached && !options.force && !options.only) return cached;

  const wanted = options.only ?? SECTION_IDS;
  const statuses: SectionStatus[] = [];

  for (const id of wanted) {
    statuses.push(await probeOne(client, child, id));
  }

  if (!options.only) perClient.set(child.id, statuses);
  return statuses;
}

async function probeOne(
  client: FskintraClient,
  child: Child,
  id: SectionId,
): Promise<SectionStatus> {
  const probe = PROBES[id];
  const label = SECTION_LABELS[id];

  try {
    const doc = await client.fetchPage(childUrl(child, probe.path));

    if (/ikke autoriseret/i.test(doc('body').text())) {
      return { id, label, available: false, note: 'ForældreIntra says "ikke autoriseret".' };
    }
    if (doc(probe.selector).length === 0) {
      return {
        id,
        label,
        available: false,
        note: `The page loaded but had no \`${probe.selector}\` — the module is probably off.`,
      };
    }
    return { id, label, available: true };
  } catch (error) {
    if (error instanceof SectionUnavailableError) {
      return { id, label, available: false, note: error.message };
    }
    return {
      id,
      label,
      available: false,
      note: `Probe failed: ${clean(error instanceof Error ? error.message : String(error))}`,
    };
  }
}
