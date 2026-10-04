// Midlertidig: kan serveren nå MitID via ForældreIntra → UniLogin → NemLog-in?
type Hop = { status: number; url: string; title?: string; note?: string };

export async function probeMitId(host: string): Promise<Hop[]> {
  const jar = new Map<string, Map<string, string>>();
  const hops: Hop[] = [];
  const cookieFor = (u: URL) =>
    [...jar].filter(([d]) => u.hostname === d || u.hostname.endsWith('.' + d))
      .flatMap(([, m]) => [...m].map(([k, v]) => `${k}=${v}`)).join('; ');
  const keep = (u: URL, res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(';');
      const i = kv.indexOf('=');
      const dom = attrs.map((a) => a.trim()).find((a) => /^domain=/i.test(a))?.slice(7).replace(/^\./, '') ?? u.hostname;
      if (!jar.has(dom)) jar.set(dom, new Map());
      jar.get(dom)!.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  };
  async function go(url: string, body?: URLSearchParams): Promise<string> {
    let u = new URL(url);
    let init: RequestInit = body ? { method: 'POST', body } : {};
    for (let n = 0; n < 12; n++) {
      const res = await fetch(u, {
        ...init,
        redirect: 'manual',
        headers: { cookie: cookieFor(u), 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'accept-language': 'da' },
      });
      keep(u, res);
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        hops.push({ status: res.status, url: u.origin + u.pathname });
        u = new URL(loc, u);
        init = {};
        continue;
      }
      const text = await res.text();
      hops.push({ status: res.status, url: u.origin + u.pathname, title: text.match(/<title>([^<]*)/i)?.[1]?.trim() });
      return text;
    }
    throw new Error('for mange omdirigeringer');
  }
  const sp = encodeURIComponent(`urn:itslearning:nsi:saml:2.0:${host}`);
  const broker = await go(`https://${host}/Account/RedirectToNemLogin?partnerSp=${sp}`);
  const action = broker.match(/<form[^>]*action="([^"]+)"/i)?.[1]?.replaceAll('&amp;', '&');
  if (!action) return [...hops, { status: 0, url: '', note: 'ingen formular hos UniLogin' }];
  const nem = await go(action, new URLSearchParams({ selectedIdp: 'nemlogin3' }));
  hops.push({ status: 0, url: '', note: `MitID-felter fundet: ${/MitIDAuthCode/.test(nem)}` });
  const core = await fetch('https://www.mitid.dk/mitid-core-client-backend/v1/authenticator-sessions/web/init', { method: 'POST' });
  hops.push({ status: core.status, url: 'mitid core-client backend', note: (await core.text()).slice(0, 120) });
  return hops;
}
