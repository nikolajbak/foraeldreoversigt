// Henter alle kilder, gemmer nyt/ændret indhold og sender notifikationer.
import { getStatus, rememberChildren, setStatus, sql } from './db.ts';
import * as aula from './aula.ts';
import * as fi from './foraeldreintra.ts';
import { syncHoldsport } from './holdsport.ts';
import { listCredentialSources } from './db.ts';
import { type PushMessage, sendToAll } from './push.ts';
import { type Item, NeedsLoginError, sha256Hex } from './types.ts';

type Source = Item['source'];

const LABEL: Record<Source, string> = {
  aula: 'Aula',
  holdsport: 'Holdsport',
  'forældreintra': 'ForældreIntra',
};

export const hashOf = (i: Item) => sha256Hex(JSON.stringify(i.hashParts));

/** Lease-lås, så to kørsler aldrig fornyer Aula-tokenet samtidig (det roterer). */
async function takeLock(): Promise<boolean> {
  const rows = await sql`
    insert into foraeldre.config (key, value) values ('sync_lock', jsonb_build_object('until', now() + interval '4 minutes'))
    on conflict (key) do update set value = excluded.value, updated_at = now()
      where (foraeldre.config.value->>'until')::timestamptz < now()
    returning key`;
  return rows.length > 0;
}

async function releaseLock() {
  await sql`delete from foraeldre.config where key = 'sync_lock'`;
}

export interface SyncReport {
  [source: string]: { ok: boolean; items?: number; nye?: number; ændrede?: number; fejl?: string; spring?: string };
}

export async function runSync(): Promise<SyncReport> {
  if (!(await takeLock())) return { lås: { ok: false, spring: 'En anden synkronisering kører allerede' } };
  const report: SyncReport = {};
  const pending: { item: Item; change: 'ny' | 'ændret' }[] = [];
  try {
    const jobs: [Source, () => Promise<{ items: Item[]; children?: string[] } | null>][] = [
      ['aula', async () => (await aula.isConnected()) ? await aula.syncAula(await knownHashes('aula'), hashOf) : null],
      ['holdsport', async () =>
        (await listCredentialSources('holdsport:')).length ? { items: await syncHoldsport() } : null],
      ['forældreintra', async () => (await fi.isConnected()) ? await fi.syncForaeldreIntra() : null],
    ];

    for (const [source, job] of jobs) {
      const before = await getStatus(source);
      try {
        const result = await job();
        if (!result) {
          report[source] = { ok: true, spring: 'ikke forbundet' };
          continue;
        }
        if (result.children) await rememberChildren(result.children);
        const { nye, ændrede } = await store(source, result.items);
        const baseline = before?.baseline_done ?? false;
        await setStatus(source, { ok: true, baseline_done: true });
        report[source] = { ok: true, items: result.items.length, nye: nye.length, ændrede: ændrede.length };
        // Første kørsel er tavs: alt er "nyt", men intet er nyt for jer.
        if (baseline) {
          for (const item of nye) if (worthNotifying(item, 'ny')) pending.push({ item, change: 'ny' });
          for (const item of ændrede) if (worthNotifying(item, 'ændret')) pending.push({ item, change: 'ændret' });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(source, e);
        if (e instanceof NeedsLoginError) {
          await setStatus(source, { ok: false, message: msg, needs_login: true });
          if (!before?.needs_login) {
            await sendToAll({
              title: `${LABEL[source]} skal logges ind igen`,
              body: msg,
              tag: `login-${source}`,
              url: './#indstillinger',
            });
          }
        } else {
          await setStatus(source, { ok: false, message: msg.slice(0, 300) });
        }
        report[source] = { ok: false, fejl: msg.slice(0, 300) };
      }
    }

    await notify(pending);
    await sql`select foraeldre.oprydning()`;
  } finally {
    await releaseLock();
  }
  return report;
}

async function knownHashes(source: Source): Promise<Map<string, string>> {
  const rows = await sql`select id, hash from foraeldre.items where source = ${source}`;
  return new Map(rows.map((r) => [r.id as string, r.hash as string]));
}

async function store(source: Source, items: Item[]) {
  const known = await knownHashes(source);
  const nye: Item[] = [];
  const ændrede: Item[] = [];
  const seen = new Set<string>();
  for (const i of items) {
    if (seen.has(i.id)) continue;
    seen.add(i.id);
    const hash = await hashOf(i);
    const prev = known.get(i.id);
    if (prev === undefined) nye.push(i);
    else if (prev !== hash) ændrede.push(i);
    await sql`
      insert into foraeldre.items
        (id, source, kind, child, title, body, url, sender, starts_at, ends_at, published_at, important, hash, seen_in_last_sync)
      values
        (${i.id}, ${i.source}, ${i.kind}, ${i.child ?? null}, ${i.title}, ${i.body ?? null}, ${i.url ?? null},
         ${i.sender ?? null}, ${i.starts_at ?? null}, ${i.ends_at ?? null}, ${i.published_at ?? null},
         ${i.important ?? false}, ${hash}, true)
      on conflict (id) do update set
        child = excluded.child, title = excluded.title, body = excluded.body, url = excluded.url,
        sender = excluded.sender, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
        published_at = excluded.published_at, important = excluded.important,
        seen_in_last_sync = true,
        updated_at = case when foraeldre.items.hash <> excluded.hash then now() else foraeldre.items.updated_at end,
        hash = excluded.hash`;
  }
  const ids = [...seen];
  await sql`
    update foraeldre.items set seen_in_last_sync = false
     where source = ${source} and not (id = any(${ids}))`;
  return { nye, ændrede };
}

/** Hvad er værd at forstyrre en forælder for? */
function worthNotifying(i: Item, change: 'ny' | 'ændret'): boolean {
  const now = Date.now();
  const age = i.published_at ? now - Date.parse(i.published_at) : 0;
  switch (i.kind) {
    case 'besked':
      return age < 7 * 86_400_000;
    case 'opslag':
    case 'påmindelse':
    case 'lektier':
      return change === 'ny' && age < 7 * 86_400_000;
    case 'begivenhed':
    case 'aktivitet':
      // Kun fremtidige; ændringer kun inden for de næste 14 dage.
      if (!i.starts_at || Date.parse(i.starts_at) < now) return false;
      return change === 'ny' || Date.parse(i.starts_at) - now < 14 * 86_400_000;
  }
}

function fmtWhen(iso?: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('da-DK', {
    timeZone: 'Europe/Copenhagen', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function message(i: Item, change: 'ny' | 'ændret'): PushMessage {
  const who = i.child ? `${i.child} · ` : '';
  const src = LABEL[i.source];
  const titles: Record<Item['kind'], string> = {
    besked: change === 'ny' ? 'Ny besked' : 'Nyt svar',
    opslag: 'Nyt opslag',
    påmindelse: 'Påmindelse',
    lektier: 'Nye lektier',
    begivenhed: change === 'ny' ? 'Ny begivenhed' : 'Ændret begivenhed',
    aktivitet: change === 'ny' ? 'Ny aktivitet' : 'Ændret aktivitet',
  };
  const lines = [
    i.title,
    i.starts_at ? fmtWhen(i.starts_at) : i.sender ?? '',
    (i.body ?? '').split('\n')[0].slice(0, 140),
  ].filter(Boolean);
  return {
    title: `${who}${titles[i.kind]} (${src})`,
    body: lines.join('\n'),
    tag: i.id,
    url: `./#item=${encodeURIComponent(i.id)}`,
  };
}

async function notify(pending: { item: Item; change: 'ny' | 'ændret' }[]) {
  if (!pending.length) return;
  if (pending.length > 5) {
    const sources = [...new Set(pending.map((p) => LABEL[p.item.source]))].join(', ');
    await sendToAll({
      title: `${pending.length} nye ting om børnene`,
      body: `Fra ${sources}. Åbn oversigten for at se dem.`,
      tag: 'samlet',
      url: './',
    });
    return;
  }
  for (const { item, change } of pending) await sendToAll(message(item, change), item.id);
}
