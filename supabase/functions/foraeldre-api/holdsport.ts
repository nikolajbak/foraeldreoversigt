// Holdsport/SportMember: officiel REST-API med basic auth.
// https://github.com/Holdsport/holdsport-api
import { getCredential, listCredentialSources } from './db.ts';
import { type Item, NeedsLoginError } from './types.ts';

const API = 'https://api.holdsport.dk/v1';

export interface HoldsportLogin {
  child: string;
  username: string;
  password: string;
}

// deno-lint-ignore no-explicit-any
type Any = any;

async function call<T>(login: HoldsportLogin, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      accept: 'application/json',
      authorization: 'Basic ' + btoa(unescape(encodeURIComponent(`${login.username}:${login.password}`))),
    },
  });
  if (res.status === 401) {
    await res.body?.cancel();
    throw new NeedsLoginError(`Holdsport afviser login for ${login.child}. Tjek brugernavn og adgangskode.`);
  }
  if (!res.ok) throw new Error(`Holdsport ${res.status} på ${path}`);
  return await res.json() as T;
}

export async function testLogin(login: HoldsportLogin): Promise<string[]> {
  const teams = await call<Any[]>(login, '/teams');
  return teams.map((t) => t.name);
}

export async function syncHoldsport(): Promise<Item[]> {
  const items: Item[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const source of await listCredentialSources('holdsport:')) {
    const login = await getCredential<HoldsportLogin>(source);
    if (!login) continue;
    const teams = await call<Any[]>(login, '/teams');
    for (const team of teams) {
      const acts = await call<Any[]>(login, `/teams/${team.id}/activities?date=${today}&per_page=40`);
      for (const a of acts) {
        const details = [
          a.place && `Sted: ${a.place}`,
          a.pickup_time && `Mødetid: ${fmtTime(a.pickup_time)}${a.pickup_place ? ` (${a.pickup_place})` : ''}`,
          a.status && `Status: ${a.status}`,
          a.comment,
        ].filter(Boolean);
        items.push({
          id: `holdsport:aktivitet:${a.id}`,
          source: 'holdsport',
          kind: 'aktivitet',
          child: login.child,
          title: a.name || 'Aktivitet',
          sender: team.name,
          body: details.join('\n') || null,
          starts_at: a.starttime || null,
          ends_at: a.endtime || null,
          url: 'https://www.holdsport.dk/',
          // Tilmeldingsstatus er udeladt: den ændrer man selv, det skal ikke give besked.
          hashParts: [a.name, a.starttime, a.endtime, a.place, a.pickup_time, a.comment],
        });
      }
    }
  }
  return items;
}

function fmtTime(v: string): string {
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  return d.toLocaleTimeString('da-DK', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit' });
}
