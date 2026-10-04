// ForældreIntra (SkoleIntra) via den vendorerede fskintra-kode.
// Login sker med skolens eget forældrelogin; UniLogin understøttes ikke.
import { getCredential, setCredential } from './db.ts';
import { type Item, NeedsLoginError, sha256Hex } from './types.ts';
import type { SessionStore, StoredSessionRecord } from './fskintra/auth/session-store.ts';
import {
  ConfirmContactsRequiredError,
  InvalidCredentialsError,
  UniLoginNotSupportedError,
} from './fskintra/auth/errors.ts';
import { FskintraClient } from './fskintra/client/client.ts';
import { getFrontpage } from './fskintra/client/sections/news.ts';
import { listConversations } from './fskintra/client/sections/messages.ts';
import { getHomework } from './fskintra/client/sections/homework.ts';

const SOURCE = 'forældreintra';

class DbStore implements SessionStore {
  async load() {
    return await getCredential<StoredSessionRecord>(SOURCE);
  }
  async save(record: StoredSessionRecord) {
    await setCredential(SOURCE, record);
  }
  async clear() {
    // Sessionen ryddes, men login-oplysningerne beholdes, så næste kørsel kan logge ind igen.
    const rec = await this.load();
    if (rec) await setCredential(SOURCE, { ...rec, cookies: undefined, indexUrl: undefined });
  }
}

function explain(e: unknown): never {
  if (e instanceof UniLoginNotSupportedError) {
    throw new NeedsLoginError(
      'Skolen sender login videre til UniLogin. Det understøttes ikke – der skal bruges skolens eget forældrelogin.',
    );
  }
  if (e instanceof InvalidCredentialsError) {
    throw new NeedsLoginError('ForældreIntra afviser brugernavn eller adgangskode.');
  }
  if (e instanceof ConfirmContactsRequiredError) {
    throw new NeedsLoginError(
      'ForældreIntra vil have jer til at bekræfte kontaktoplysninger. Log ind én gang på skolens side og bekræft dem.',
    );
  }
  throw e;
}

export async function connect(hostname: string, username: string, password: string): Promise<string[]> {
  const client = new FskintraClient({ store: new DbStore(), credentials: { hostname, username, password } });
  try {
    await client.authenticate(true);
    const kids = await client.getChildren(true);
    return kids.map((k) => k.name);
  } catch (e) {
    explain(e);
  }
}

export async function isConnected(): Promise<boolean> {
  return !!(await getCredential(SOURCE));
}

export interface FiResult {
  items: Item[];
  children: string[];
}

export async function syncForaeldreIntra(): Promise<FiResult> {
  const client = new FskintraClient({ store: new DbStore() });
  const items: Item[] = [];
  let kids;
  try {
    await client.authenticate();
    kids = await client.getChildren();
  } catch (e) {
    explain(e);
  }
  const base = client.hostname ? `https://${client.hostname}` : null;

  for (const child of kids) {
    const name = child.name.split(/\s+/)[0];

    const front = await getFrontpage(client, child);
    for (const n of front.news) {
      items.push({
        id: `${SOURCE}:opslag:${child.id}:${n.id || (await sha256Hex(n.title + n.dateText)).slice(0, 16)}`,
        source: SOURCE,
        kind: 'opslag',
        child: name,
        title: n.title || '(opslag)',
        body: n.body.length > 1500 ? n.body.slice(0, 1500) + '…' : n.body,
        sender: n.author || null,
        published_at: n.date ? new Date(n.date).toISOString() : null,
        url: base,
        hashParts: [n.title, n.body.slice(0, 500)],
      });
    }
    for (const r of front.reminders) {
      items.push({
        id: `${SOURCE}:påmindelse:${child.id}:${(await sha256Hex(r)).slice(0, 16)}`,
        source: SOURCE,
        kind: 'påmindelse',
        child: name,
        title: r.length > 120 ? r.slice(0, 117) + '…' : r,
        body: r.length > 120 ? r : null,
        url: base,
        hashParts: [r],
      });
    }

    try {
      for (const c of await listConversations(client, child)) {
        items.push({
          id: `${SOURCE}:besked:${c.threadId}`,
          source: SOURCE,
          kind: 'besked',
          child: name,
          title: c.subject || '(uden emne)',
          sender: c.sender || null,
          body: c.dateText ? `Sendt ${c.dateText}` : null,
          important: c.unread,
          url: base,
          hashParts: [c.latestMessageId],
        });
      }
    } catch (e) {
      client.logger.warn('fi.messages_failed', { error: String(e) });
    }

    try {
      for (const hw of await getHomework(client, child)) {
        for (const g of hw.groups) {
          const body = g.entries.map((x) => `${x.subject}: ${x.text}`).join('\n');
          if (!body) continue;
          items.push({
            id: `${SOURCE}:lektier:${child.id}:${(await sha256Hex(g.due)).slice(0, 12)}`,
            source: SOURCE,
            kind: 'lektier',
            child: name,
            title: `Lektier til ${g.due}`,
            body,
            url: base,
            hashParts: [body],
          });
        }
      }
    } catch (e) {
      client.logger.warn('fi.homework_failed', { error: String(e) });
    }
  }
  return { items, children: kids.map((k) => k.name.split(/\s+/)[0]) };
}
