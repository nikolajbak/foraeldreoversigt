// foraeldre-api: én edge-funktion for Forældreoversigt.
// Adgang: familiekode (header x-familiekode) for appen, x-cron-secret for pg_cron.
import { deleteConfig, deleteCredential, getConfig, listCredentialSources, setConfig, setCredential, sql } from './db.ts';
import * as aula from './aula.ts';
import * as fi from './foraeldreintra.ts';
import * as holdsport from './holdsport.ts';
import { sendToAll, subscribe, unsubscribe, vapidPublicKey } from './push.ts';
import { runSync } from './sync.ts';
import { probeMitId } from './probe.ts';
import { NeedsLoginError, sha256Hex } from './types.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const ORIGINS = ['https://nikolajbak.github.io'];

function cors(req: Request): Record<string, string> {
  const o = req.headers.get('origin') ?? '';
  const ok = ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return {
    'access-control-allow-origin': ok ? o : ORIGINS[0],
    'access-control-allow-headers': 'content-type, x-familiekode',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    vary: 'origin',
  };
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface FamilyCode {
  salt: string;
  hash: string;
}

async function codeHash(code: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100_000 },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Konstant-tids sammenligning. */
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function requireFamily(req: Request) {
  const fails = (await getConfig<{ n: number; since: number }>('auth_fails')) ?? { n: 0, since: Date.now() };
  if (fails.n >= 20 && Date.now() - fails.since < 15 * 60_000) {
    throw new HttpError(429, 'For mange forkerte forsøg. Vent et kvarter.');
  }
  const stored = await getConfig<FamilyCode>('family_code');
  const given = req.headers.get('x-familiekode') ?? '';
  if (!stored) throw new HttpError(403, 'Appen er ikke sat op endnu.');
  if (!given || !same(await codeHash(given, stored.salt), stored.hash)) {
    const fresh = Date.now() - fails.since > 15 * 60_000;
    await setConfig('auth_fails', fresh ? { n: 1, since: Date.now() } : { n: fails.n + 1, since: fails.since });
    throw new HttpError(401, 'Forkert familiekode.');
  }
}

async function isCron(req: Request) {
  const given = req.headers.get('x-cron-secret');
  if (!given) return false;
  const secret = await getConfig<string>('cron_secret');
  return !!secret && same(given, secret);
}

const slug = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9æøå]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'barn';

const background = (p: Promise<unknown>) =>
  EdgeRuntime.waitUntil(p.catch((e) => console.error('baggrundssynk', e)));

async function overview() {
  const items = await sql`
    select id, source, kind, child, title, body, url, sender, starts_at, ends_at, published_at, important,
           first_seen, updated_at
      from foraeldre.items
     where (kind in ('begivenhed','aktivitet') and coalesce(ends_at, starts_at) >= now() - interval '6 hours'
              and starts_at < now() + interval '45 days')
        or (kind not in ('begivenhed','aktivitet') and seen_in_last_sync
              and coalesce(published_at, first_seen) > now() - interval '45 days')
     order by coalesce(starts_at, published_at, first_seen) desc
     limit 400`;
  const status = await sql`select source, ok, message, needs_login, last_run from foraeldre.source_status`;
  const children = await sql`select name from foraeldre.children order by name`;
  return { items, status, children: children.map((c) => c.name), hentet: new Date().toISOString() };
}

async function settings() {
  const holdsportSources = await listCredentialSources('holdsport:');
  const hs = [];
  for (const s of holdsportSources) {
    const rows = await sql`select data->>'child' child, data->>'username' username from foraeldre.credentials where source = ${s}`;
    hs.push({ id: s, child: rows[0]?.child, username: rows[0]?.username });
  }
  const fiRow = await sql`select data->>'hostname' hostname, data->>'username' username from foraeldre.credentials where source = 'forældreintra'`;
  const devices = await sql`select count(*)::int n from foraeldre.push_subscriptions`;
  const aulaTok = await sql`select data->>'last_refresh' lr, data->>'obtained_at' ob from foraeldre.credentials where source = 'aula'`;
  return {
    aula: aulaTok.length ? { forbundet: true, fornyet: Number(aulaTok[0].lr ?? aulaTok[0].ob) } : { forbundet: false },
    holdsport: hs,
    forældreintra: fiRow[0] ?? null,
    enheder: devices[0].n,
  };
}

async function route(req: Request, path: string): Promise<unknown> {
  const m = req.method;
  const body = m === 'POST' ? await req.json().catch(() => ({})) : {};

  if (m === 'GET' && path === '/status') {
    return { opsat: !!(await getConfig('family_code')) };
  }

  if (m === 'POST' && path === '/opsaet') {
    if (await getConfig('family_code')) throw new HttpError(409, 'Appen er allerede sat op.');
    const tokenHash = await getConfig<string>('setup_token_hash');
    if (!tokenHash || !same(await sha256Hex(String(body.token ?? '')), tokenHash)) {
      throw new HttpError(403, 'Opsætningslinket er ugyldigt.');
    }
    const code = String(body.kode ?? '');
    if (code.length < 6) throw new HttpError(400, 'Familiekoden skal være mindst 6 tegn.');
    const salt = crypto.randomUUID();
    await setConfig('family_code', { salt, hash: await codeHash(code, salt) });
    await deleteConfig('setup_token_hash');
    return { ok: true };
  }

  if (m === 'POST' && path === '/probe/mitid') {
    if (!(await isCron(req))) throw new HttpError(401, 'Nej.');
    return { hops: await probeMitId('borneuni.m.skoleintra.dk') };
  }
  if (m === 'POST' && path === '/sync') {
    if (!(await isCron(req))) await requireFamily(req);
    return await runSync();
  }

  await requireFamily(req);

  switch (`${m} ${path}`) {
    case 'GET /oversigt':
      return await overview();
    case 'GET /indstillinger':
      return await settings();

    case 'GET /push/noegle':
      return { key: await vapidPublicKey() };
    case 'POST /push/tilmeld':
      await subscribe(body.subscription, String(body.device ?? '').slice(0, 80));
      return { ok: true };
    case 'POST /push/frameld':
      await unsubscribe(String(body.endpoint ?? ''));
      return { ok: true };
    case 'POST /push/test':
      return {
        leveret: await sendToAll({ title: 'Forældreoversigt', body: 'Notifikationer virker 👍', tag: 'test', url: './' }),
      };

    case 'POST /aula/start':
      return { url: await aula.startLogin() };
    case 'POST /aula/afslut':
      await aula.finishLogin(String(body.adresse ?? ''));
      await sql`update foraeldre.source_status set needs_login = false, ok = true, message = null where source = 'aula'`;
      background(runSync());
      return { ok: true };
    case 'POST /aula/frakobl':
      await deleteCredential('aula');
      return { ok: true };

    case 'POST /holdsport': {
      const login = {
        child: String(body.child ?? '').trim(),
        username: String(body.username ?? '').trim(),
        password: String(body.password ?? ''),
      };
      if (!login.child || !login.username || !login.password) throw new HttpError(400, 'Udfyld barn, brugernavn og adgangskode.');
      const teams = await holdsport.testLogin(login);
      await setCredential(`holdsport:${slug(login.child)}`, login);
      background(runSync());
      return { ok: true, hold: teams };
    }
    case 'POST /holdsport/fjern':
      if (!String(body.id ?? '').startsWith('holdsport:')) throw new HttpError(400, 'Ukendt Holdsport-login');
      await deleteCredential(String(body.id));
      await sql`delete from foraeldre.items where source = 'holdsport' and child = ${String(body.child ?? '')}`;
      return { ok: true };

    case 'POST /forældreintra':
    case 'POST /foraeldreintra': {
      const host = String(body.hostname ?? '').trim();
      const user = String(body.username ?? '').trim();
      const pass = String(body.password ?? '');
      if (!host || !user || !pass) throw new HttpError(400, 'Udfyld skolens adresse, brugernavn og adgangskode.');
      const kids = await fi.connect(host, user, pass);
      background(runSync());
      return { ok: true, børn: kids };
    }
    case 'POST /foraeldreintra/frakobl':
      await deleteCredential('forældreintra');
      return { ok: true };
  }
  throw new HttpError(404, 'Ukendt adresse');
}

Deno.serve(async (req) => {
  const headers = { ...cors(req), 'content-type': 'application/json; charset=utf-8' };
  if (req.method === 'OPTIONS') return new Response(null, { headers });
  const path = decodeURIComponent(new URL(req.url).pathname).replace(/^.*\/foraeldre-api/, '') || '/';
  try {
    return new Response(JSON.stringify(await route(req, path)), { headers });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e instanceof NeedsLoginError ? 422 : 500;
    const msg = e instanceof Error ? e.message : String(e);
    if (status === 500) console.error(path, e);
    return new Response(JSON.stringify({ fejl: msg }), { status, headers });
  }
});
