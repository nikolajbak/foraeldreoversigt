// Aula via app-klientens OAuth (PKCE) og www.aula.dk/api.
//
// Selve MitID-loginet sker i forælderens egen browser på telefonen; STIL's
// bot-værn blokerer det fra servere. Herfra rører serveren kun token-
// endpointet på login.aula.dk (refresh), som ikke ligger bag værnet.
//
// Konstanter og API-metoder er de samme som Aulas egen app og
// github.com/Casperjuel/aula-mcp (MIT) bruger.
import { deleteConfig, getConfig, getCredential, setConfig, setCredential } from './db.ts';
import { type Item, NeedsLoginError, stripHtml, toIso } from './types.ts';

const CLIENT_ID = '_99949a54b8b65423862aac1bf629599ed64231607a';
const SCOPE = 'aula-sensitive';
const REDIRECT_URI = 'https://app-private.aula.dk';
const AUTH_BASE = 'https://login.aula.dk/simplesaml/module.php/oidc';
const API_HOST = 'https://www.aula.dk';
const PORTAL = 'https://www.aula.dk/portal/#';

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch-sekunder
  obtained_at: number;
  last_refresh?: number;
}

interface Pending {
  verifier: string;
  state: string;
  created: number;
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// --- Login ----------------------------------------------------------------

export async function startLogin(): Promise<string> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  await setConfig('aula_pending', { verifier, state, created: Date.now() } satisfies Pending);
  const qs = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPE,
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_BASE}/authorize.php?${qs}`;
}

/** Tager adressen forælderen landede på (eller bare koden) og henter tokens. */
export async function finishLogin(pasted: string): Promise<void> {
  const pending = await getConfig<Pending>('aula_pending');
  if (!pending || Date.now() - pending.created > 30 * 60_000) {
    throw new Error('Login-forsøget er udløbet. Tryk "Log ind med MitID" igen.');
  }
  let code = pasted.trim();
  let state: string | null = null;
  const m = code.match(/[?&#]code=([^&#\s]+)/);
  if (m) {
    code = decodeURIComponent(m[1]);
    const s = pasted.match(/[?&#]state=([^&#\s]+)/)?.[1];
    if (s) state = decodeURIComponent(s);
  }
  if (!code || code.includes('://')) {
    throw new Error('Kunne ikke finde en kode i adressen. Kopiér hele adressen fra adresselinjen.');
  }
  if (state && state !== pending.state) {
    throw new Error('Adressen hører til et ældre login-forsøg. Start forfra.');
  }
  const res = await fetch(`${AUTH_BASE}/token.php`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: pending.verifier,
    }),
  });
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`Aula afviste koden (${res.status}). Koden virker kun få minutter – prøv igen.`);
  }
  await setCredential('aula', parseTokens(text));
  await deleteConfig('aula_pending');
}

function parseTokens(body: string, fallbackRefresh?: string): Tokens {
  const j = JSON.parse(body);
  const now = Math.floor(Date.now() / 1000);
  const refresh = j.refresh_token ?? fallbackRefresh;
  if (!j.access_token || !refresh) throw new Error('Aula svarede uden tokens');
  return {
    access_token: j.access_token,
    refresh_token: refresh,
    expires_at: now + Number(j.expires_in ?? 3600),
    obtained_at: now,
  };
}

async function refresh(tokens: Tokens): Promise<Tokens> {
  const res = await fetch(`${AUTH_BASE}/token.php`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: CLIENT_ID,
    }),
  });
  const text = await res.text();
  if (res.status === 400 || res.status === 401) {
    throw new NeedsLoginError('Aula-adgangen er udløbet. Log ind med MitID igen.');
  }
  if (res.status !== 200) throw new Error(`Aula token-fornyelse fejlede (${res.status})`);
  // Refresh-tokenet roterer: gem det nye med det samme, ellers er kæden brudt.
  const next = { ...parseTokens(text, tokens.refresh_token), last_refresh: Math.floor(Date.now() / 1000) };
  await setCredential('aula', next);
  return next;
}

async function validTokens(force = false): Promise<Tokens> {
  const tokens = await getCredential<Tokens>('aula');
  if (!tokens) throw new NeedsLoginError('Aula er ikke forbundet endnu.');
  const now = Math.floor(Date.now() / 1000);
  // Forny også hver 6. time, selv om adgangen stadig gælder, så kæden holdes varm.
  const stale = now - (tokens.last_refresh ?? tokens.obtained_at) > 6 * 3600;
  if (force || stale || tokens.expires_at - 120 < now) return await refresh(tokens);
  return tokens;
}

export async function isConnected(): Promise<boolean> {
  return !!(await getCredential<Tokens>('aula'));
}

// --- API ------------------------------------------------------------------

class AulaApi {
  private cookies = new Map<string, string>();
  private version = 22;
  private contextReady = false;

  constructor(private tokens: Tokens) {}

  private cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private keepCookies(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  private url(params: URLSearchParams) {
    params.set('access_token', this.tokens.access_token);
    return `${API_HOST}/api/v${this.version}/?${params}`;
  }

  async init() {
    const stored = await getConfig<number>('aula_api_version');
    if (stored) this.version = stored;
    for (let v = this.version; v <= this.version + 8; v++) {
      this.version = v;
      const res = await this.raw(new URLSearchParams({ method: 'profiles.getProfilesByLogin' }));
      if (res.status === 200) {
        await res.body?.cancel();
        if (v !== stored) await setConfig('aula_api_version', v);
        return;
      }
      await res.body?.cancel();
      if (res.status === 401 || res.status === 403) throw new AuthFailed();
      if (res.status !== 410) throw new Error(`Aula svarede ${res.status} på versionstjek`);
    }
    throw new Error('Fandt ingen gyldig Aula API-version');
  }

  private async raw(params: URLSearchParams, init: RequestInit = {}) {
    const res = await fetch(this.url(params), {
      ...init,
      headers: { accept: 'application/json', cookie: this.cookieHeader(), ...(init.headers ?? {}) },
      redirect: 'manual',
    });
    this.keepCookies(res);
    return res;
  }

  private async envelope<T>(res: Response): Promise<T> {
    const text = await res.text();
    if (res.status === 401) throw new AuthFailed();
    if (res.status !== 200) throw new Error(`Aula API ${res.status}: ${text.slice(0, 200)}`);
    const env = JSON.parse(text);
    const code = env?.status?.code;
    if (code === 448) throw new StepUpRequired();
    if (code && code !== 0) {
      if (code === 401 || code === 403) throw new StepUpRequired();
      throw new Error(`Aula API fejl ${code}: ${env?.status?.message ?? ''}`);
    }
    return env.data as T;
  }

  async get<T>(method: string, query: Record<string, string> = {}, arrays: Record<string, (string | number)[]> = {}) {
    const params = new URLSearchParams({ method, ...query });
    for (const [k, vs] of Object.entries(arrays)) for (const v of vs) params.append(`${k}[]`, String(v));
    return this.envelope<T>(await this.raw(params));
  }

  async post<T>(method: string, body: unknown) {
    if (!this.contextReady) {
      await this.get('profiles.getProfileContext', { portalrole: 'guardian' });
      this.contextReady = true;
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const csrf = this.cookies.get('Csrfp-Token');
    if (csrf) headers['csrfp-token'] = csrf;
    return this.envelope<T>(
      await this.raw(new URLSearchParams({ method }), { method: 'POST', headers, body: JSON.stringify(body) }),
    );
  }
}

class AuthFailed extends Error {}
class StepUpRequired extends Error {}

/** Aulas tidsformat: "2026-10-05 00:00:00.0000+0200", i dansk tid. */
function aulaTs(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'longOffset',
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  const off = (p.timeZoneName as string).replace('GMT', '').replace(':', '') || '+0000';
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute}:${p.second}.0000${off}`;
}

interface AulaChild {
  id: number;
  name: string;
  institutionProfile?: { id: number; institutionName?: string };
}

// deno-lint-ignore no-explicit-any
type Any = any;

export interface AulaResult {
  items: Item[];
  children: string[];
}

/** Henter beskeder, opslag og kalender. `known` = id → hash fra sidste kørsel. */
export async function syncAula(known: Map<string, string>, hashOf: (i: Item) => Promise<string>): Promise<AulaResult> {
  let tokens = await validTokens();
  let api = new AulaApi(tokens);
  try {
    await api.init();
  } catch (e) {
    if (!(e instanceof AuthFailed)) throw e;
    tokens = await validTokens(true);
    api = new AulaApi(tokens);
    try {
      await api.init();
    } catch (e2) {
      if (e2 instanceof AuthFailed) throw new NeedsLoginError('Aula afviser adgangen. Log ind med MitID igen.');
      throw e2;
    }
  }

  const profiles = await api.get<{ profiles: Any[] }>('profiles.getProfilesByLogin');
  const guardian = profiles.profiles.find((p) => (p.portalRole ?? 'guardian') === 'guardian') ?? profiles.profiles[0];
  const kids: AulaChild[] = guardian?.children ?? [];
  const kidIds = kids.map((k) => k.id);
  const nameById = new Map<number, string>(kids.map((k) => [k.id, firstName(k.name)]));

  const ctx = await api.get<Any>('profiles.getProfileContext', { portalrole: 'guardian' });
  const guardianIds: number[] = (ctx?.institutionProfiles ?? guardian?.institutionProfiles ?? [])
    .map((p: Any) => p.id)
    .filter(Boolean);

  const items: Item[] = [];

  // Beskeder: forælderens egen indbakke indeholder kun egne børns sager.
  const threads = await api.get<{ threads: Any[] }>('messaging.getThreads', {
    sortOn: 'date', orderDirection: 'desc', page: '0',
  });
  let bodiesFetched = 0;
  for (const t of threads?.threads ?? []) {
    const latestId = t.latestMessage?.id ?? t.lastMessage?.id ?? t.latestMessage?.sendDateTime;
    const sent = t.latestMessage?.sendDateTime ?? t.lastMessage?.sendDateTime;
    const item: Item = {
      id: `aula:besked:${t.id}`,
      source: 'aula',
      kind: 'besked',
      title: t.subject || '(uden emne)',
      sender: t.lastMessage?.sender?.fullName ?? t.latestMessage?.sender?.fullName ?? null,
      published_at: toIso(sent),
      url: `${PORTAL}/beskeder/${t.id}`,
      important: !t.read,
      body: stripHtml(t.lastMessage?.text?.html ?? t.lastMessage?.text ?? t.latestMessage?.text?.html ?? '') || null,
      hashParts: [latestId],
    };
    const changed = known.get(item.id) !== (await hashOf(item));
    if (changed && bodiesFetched < 8) {
      bodiesFetched++;
      try {
        const data = await api.get<Any>('messaging.getMessagesForThread', { threadId: String(t.id), page: '0' });
        const msgs: Any[] = data?.messages ?? [];
        const newest = msgs[0];
        if (newest) {
          item.body = stripHtml(newest.text?.html ?? newest.text ?? '') || item.body;
          item.sender = newest.sender?.fullName ?? item.sender;
        }
      } catch (e) {
        if (e instanceof StepUpRequired) item.body = 'Følsom besked – åbn den i Aula.';
        else throw e;
      }
    }
    items.push(item);
  }

  // Opslag fra skole/institution.
  const posts = await api.get<{ posts?: Any[] }>(
    'posts.getAllPosts',
    { parent: 'profile', index: '0', limit: '20', isUnread: 'false' },
    { institutionProfileIds: [...new Set([...guardianIds, ...kidIds])] },
  );
  for (const p of posts?.posts ?? []) {
    const body = stripHtml(p.content?.html);
    items.push({
      id: `aula:opslag:${p.id}`,
      source: 'aula',
      kind: 'opslag',
      title: p.title || '(opslag)',
      body: body.length > 1500 ? body.slice(0, 1500) + '…' : body,
      sender: p.ownerProfile?.fullName ?? p.ownerProfile?.name ?? null,
      published_at: toIso(p.timestamp ?? p.publishAt),
      important: !!p.isImportant,
      url: `${PORTAL}/overblik`,
      hashParts: [p.title, body.slice(0, 500)],
    });
  }

  // Kalender: begivenheder de næste 45 dage (skemalektioner udelades).
  if (kidIds.length) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 45 * 86_400_000);
    const events = await api.post<Any[]>('calendar.getEventsByProfileIdsAndResourceIds', {
      instProfileIds: kidIds,
      resourceIds: [],
      start: aulaTs(start),
      end: aulaTs(end),
    });
    for (const ev of events ?? []) {
      if (ev.type === 'lesson') continue;
      const who = (ev.belongsToProfiles ?? [])
        .map((id: number) => nameById.get(id))
        .filter(Boolean)
        .join(', ');
      items.push({
        id: `aula:begivenhed:${ev.id ?? `${ev.title}|${ev.startDateTime}`}`,
        source: 'aula',
        kind: 'begivenhed',
        child: who || null,
        title: ev.title || 'Begivenhed',
        body: ev.primaryResource?.name ? `Sted: ${ev.primaryResource.name}` : null,
        starts_at: toIso(ev.startDateTime),
        ends_at: toIso(ev.endDateTime),
        url: `${PORTAL}/kalender`,
        hashParts: [ev.title, ev.startDateTime, ev.endDateTime, ev.primaryResource?.name],
      });
    }
  }

  return { items, children: kids.map((k) => firstName(k.name)) };
}

function firstName(full: string): string {
  return (full ?? '').trim().split(/\s+/)[0] ?? full;
}
