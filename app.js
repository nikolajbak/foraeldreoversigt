'use strict';
// Forældreoversigt — samler Aula, ForældreIntra og Holdsport.
// Al hentning sker i edge-funktionen foraeldre-api; appen viser kun resultatet.

const API = 'https://gjycsqshkvkcupdnvgvf.supabase.co/functions/v1/foraeldre-api';
const KILDE = { aula: 'Aula', holdsport: 'Holdsport', 'forældreintra': 'ForældreIntra' };
const TZ = 'Europe/Copenhagen';

const app = document.getElementById('app');
const gem = {
  get(k, f = null) { try { const v = localStorage.getItem(k); return v === null ? f : JSON.parse(v); } catch { return f; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* privat tilstand */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* */ } },
};

const state = {
  kode: gem.get('kode'),
  data: gem.get('oversigt'),
  view: 'idag',
  barn: gem.get('barn', 'alle'),
  sidstSet: gem.get('sidstSet', 0),
  henter: false,
  indstillinger: null,
};

// ---------- hjælpere ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = (strings, ...vals) => strings.reduce((a, s, i) => a + s + (i < vals.length ? vals[i] : ''), '');

async function api(path, { method = 'GET', body, kode = state.kode } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: { 'content-type': 'application/json', ...(kode ? { 'x-familiekode': kode } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(navigator.onLine ? 'Kunne ikke nå serveren. Prøv igen om lidt.' : 'Ingen internetforbindelse.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    if (path !== '/status') logUd('Familiekoden virker ikke længere. Indtast den igen.');
    throw new Error(data.fejl || 'Forkert familiekode');
  }
  if (!res.ok) throw new Error(data.fejl || `Fejl ${res.status}`);
  return data;
}

function toast(tekst, ms = 3200) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = tekst;
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

const dagKey = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(d);
const fmt = (d, o) => new Intl.DateTimeFormat('da-DK', { timeZone: TZ, ...o }).format(d);
const kl = (iso) => fmt(new Date(iso), { hour: '2-digit', minute: '2-digit' });

function relDag(d) {
  const i = Math.round((new Date(dagKey(d)) - new Date(dagKey(new Date()))) / 86_400_000);
  if (i === 0) return 'I dag';
  if (i === 1) return 'I morgen';
  if (i === -1) return 'I går';
  return '';
}

function hvornaar(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const r = relDag(d);
  if (r === 'I dag') return kl(iso);
  if (r === 'I går') return 'I går';
  const dage = (Date.now() - d) / 86_400_000;
  if (dage < 6) return fmt(d, { weekday: 'long' });
  return fmt(d, { day: 'numeric', month: 'short' });
}

const erKalender = (i) => i.kind === 'begivenhed' || i.kind === 'aktivitet';
const nyt = (i) => state.sidstSet && Date.parse(i.first_seen) > state.sidstSet;

function filtreret() {
  const items = state.data?.items ?? [];
  if (state.barn === 'alle') return items;
  return items.filter((i) => !i.child || i.child.split(', ').includes(state.barn));
}

// ---------- ikoner ----------
const ikon = {
  idag: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/><circle cx="12" cy="12" r="4"/></svg>',
  nyt: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H8l-4 4z"/><path d="M8 9h8M8 12h5"/></svg>',
  kalender: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  tandhjul: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  tilbage: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
};

// ---------- rækker ----------
function raekke(i, { visTid = true } = {}) {
  const tid = visTid && erKalender(i) && i.starts_at;
  const meta = [
    i.child ? `<span class="barn">${esc(i.child)}</span>` : '',
    `<span class="kilde ${esc(i.source)}">${esc(i.sender || KILDE[i.source])}</span>`,
    !erKalender(i) && (i.published_at || i.first_seen) ? `<span class="tal">${esc(hvornaar(i.published_at || i.first_seen))}</span>` : '',
    nyt(i) ? '<span class="ny-maerke">Ny</span>' : '',
  ].filter(Boolean).join('');
  const uddrag = (i.body || '').split('\n').filter(Boolean).slice(0, 2).join(' · ');
  return h`<button class="raekke ${tid ? '' : 'uden-tid'} ${i.kind === 'besked' && i.important ? 'ulaest' : ''}" data-item="${esc(i.id)}">
    ${tid ? `<div class="tid">${kl(i.starts_at)}${i.ends_at ? `<small>${kl(i.ends_at)}</small>` : ''}</div>` : ''}
    <div class="indhold">
      <div class="titel">${esc(i.title)}</div>
      <div class="meta">${meta}</div>
      ${uddrag && !erKalender(i) ? `<div class="uddrag">${esc(uddrag)}</div>` : ''}
    </div>
    ${i.kind === 'besked' && i.important ? '<span class="prik" aria-label="Ulæst"></span>' : '<span></span>'}
  </button>`;
}

function dagsgrupper(items) {
  const grupper = new Map();
  for (const i of items) {
    const k = dagKey(new Date(i.starts_at));
    if (!grupper.has(k)) grupper.set(k, []);
    grupper.get(k).push(i);
  }
  return [...grupper].map(([k, liste]) => {
    const d = new Date(liste[0].starts_at);
    const rel = relDag(d);
    return h`<div class="dag">${rel ? `<span class="rel">${rel}</span>` : ''}<span class="dato2">${fmt(d, { weekday: 'long', day: 'numeric', month: 'long' })}</span></div>
      <div class="liste">${liste.map((i) => raekke(i)).join('')}</div>`;
  }).join('');
}

const kommende = (items) => items
  .filter((i) => erKalender(i) && i.starts_at && Date.parse(i.ends_at || i.starts_at) > Date.now() - 3_600_000)
  .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));

const opslag = (items) => items
  .filter((i) => !erKalender(i))
  .sort((a, b) => Date.parse(b.published_at || b.first_seen) - Date.parse(a.published_at || a.first_seen));

// ---------- visninger ----------
function bannere() {
  const st = state.data?.status ?? [];
  const login = st.filter((s) => s.needs_login);
  const fejl = st.filter((s) => !s.ok && !s.needs_login);
  return [
    ...login.map((s) => h`<div class="banner"><div><b>${KILDE[s.source]}</b> skal logges ind igen.</div>
      <button class="knap lille" data-gaa="indstillinger">Ordn det</button></div>`),
    ...fejl.map((s) => h`<div class="banner blid"><div><b>${KILDE[s.source]}</b> kunne ikke hentes sidst. Prøver igen af sig selv.</div></div>`),
  ].join('');
}

function chips() {
  const born = state.data?.children ?? [];
  if (born.length < 2) return '';
  return h`<div class="chips" role="group" aria-label="Vælg barn">
    ${['alle', ...born].map((b) => `<button class="chip" data-barn="${esc(b)}" aria-pressed="${state.barn === b}">${b === 'alle' ? 'Alle' : esc(b)}</button>`).join('')}
  </div>`;
}

function tomTilstand() {
  if (!state.data) return '<div class="tom"><b>Henter…</b>Et øjeblik.</div>';
  const ingenKilder = !(state.data.status ?? []).length;
  if (ingenKilder) {
    return h`<div class="tom"><b>Ingen kilder forbundet endnu</b>Forbind Aula, ForældreIntra og Holdsport under indstillinger.
      <div style="margin-top:14px"><button class="knap" data-gaa="indstillinger">Gå til indstillinger</button></div></div>`;
  }
  return '';
}

function visIdag() {
  const items = filtreret();
  const tom = tomTilstand();
  if (tom) return tom;
  const kal = kommende(items);
  const iDag = kal.filter((i) => relDag(new Date(i.starts_at)) === 'I dag');
  const iMorgen = kal.filter((i) => relDag(new Date(i.starts_at)) === 'I morgen');
  const senere = kal.filter((i) => !['I dag', 'I morgen'].includes(relDag(new Date(i.starts_at)))).slice(0, 4);
  const nye = opslag(items).filter((i) => nyt(i) || (i.kind === 'besked' && i.important)).slice(0, 6);
  const seneste = nye.length ? nye : opslag(items).slice(0, 4);

  return h`
    <div class="sektion"><h2>I dag</h2></div>
    ${iDag.length ? `<div class="liste">${iDag.map((i) => raekke(i)).join('')}</div>` : '<div class="tom" style="padding:18px">Intet i kalenderen i dag.</div>'}
    ${iMorgen.length ? `<div class="sektion"><h2>I morgen</h2></div><div class="liste">${iMorgen.map((i) => raekke(i)).join('')}</div>` : ''}
    <div class="sektion"><h2>${nye.length ? 'Nyt siden sidst' : 'Seneste'}</h2>${nye.length ? `<span class="antal">${nye.length}</span>` : ''}</div>
    ${seneste.length ? `<div class="liste">${seneste.map((i) => raekke(i)).join('')}</div>` : '<div class="tom" style="padding:18px">Ingen beskeder eller opslag.</div>'}
    ${senere.length ? `<div class="sektion"><h2>Snart</h2></div>${dagsgrupper(senere)}` : ''}
  `;
}

function visNyt() {
  const tom = tomTilstand();
  if (tom) return tom;
  const items = opslag(filtreret());
  if (!items.length) return '<div class="tom"><b>Ingen beskeder eller opslag</b>Når der kommer noget, står det her.</div>';
  const grupper = { 'I dag': [], 'I går': [], 'Denne uge': [], 'Tidligere': [] };
  for (const i of items) {
    const d = new Date(i.published_at || i.first_seen);
    const r = relDag(d);
    const dage = (Date.now() - d) / 86_400_000;
    (r === 'I dag' ? grupper['I dag'] : r === 'I går' ? grupper['I går'] : dage < 7 ? grupper['Denne uge'] : grupper['Tidligere']).push(i);
  }
  return Object.entries(grupper).filter(([, l]) => l.length).map(([navn, l]) =>
    `<div class="sektion"><h2>${navn}</h2><span class="antal">${l.length}</span></div><div class="liste">${l.map((i) => raekke(i)).join('')}</div>`).join('');
}

function visKalender() {
  const tom = tomTilstand();
  if (tom) return tom;
  const kal = kommende(filtreret());
  if (!kal.length) return '<div class="tom"><b>Kalenderen er tom</b>Ingen begivenheder eller aktiviteter de næste uger.</div>';
  return dagsgrupper(kal);
}

function statusMaerke(src) {
  const s = (state.data?.status ?? []).find((x) => x.source === src);
  if (!s) return '<span class="status fra">Ikke forbundet</span>';
  if (s.needs_login) return '<span class="status fejl">Log ind igen</span>';
  if (!s.ok) return '<span class="status fejl">Fejl</span>';
  return '<span class="status ok">Forbundet</span>';
}

function kildeFejl(src) {
  const s = (state.data?.status ?? []).find((x) => x.source === src);
  return s && !s.ok && s.message ? `<div class="fejltekst">${esc(s.message)}</div>` : '';
}

function visIndstillinger() {
  const ind = state.indstillinger;
  const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const pushMulig = 'serviceWorker' in navigator && 'PushManager' in window;
  const pushTil = gem.get('pushTil', false) && typeof Notification !== 'undefined' && Notification.permission === 'granted';

  let push;
  if (iOS && !standalone) {
    push = '<p>Notifikationer kræver, at appen ligger på hjemmeskærmen: tryk <b>Del</b> → <b>Føj til hjemmeskærm</b>, og åbn den derfra.</p>';
  } else if (!pushMulig) {
    push = '<p>Denne browser understøtter ikke notifikationer.</p>';
  } else if (pushTil) {
    push = h`<p>Notifikationer er slået til på denne enhed${ind ? ` (${ind.enheder} enhed${ind.enheder === 1 ? '' : 'er'} i alt)` : ''}.</p>
      <div class="raekker-lille"><button class="knap sekundaer lille" data-handling="push-test">Send en test</button>
      <button class="knap fare lille" data-handling="push-fra">Slå fra</button></div>`;
  } else {
    push = '<p>Få besked om nye beskeder, opslag og ændringer i kalenderen.</p><button class="knap" data-handling="push-til">Slå notifikationer til</button>';
  }

  const aulaVent = gem.get('aulaVent', false);
  const hs = ind?.holdsport ?? [];
  const fi = ind?.forældreintra;

  return h`
    <div class="kort"><h3>Notifikationer</h3>${push}</div>

    <div class="kort">
      <h3><span class="kilde aula"></span>Aula ${statusMaerke('aula')}</h3>
      ${kildeFejl('aula')}
      ${ind?.aula?.forbundet && !aulaVent ? h`<p>Forbundet. Adgangen fornyes automatisk.</p>
        <div class="raekker-lille"><button class="knap sekundaer lille" data-handling="aula-start">Log ind igen</button>
        <button class="knap fare lille" data-handling="aula-fra">Frakobl</button></div>` : h`
        <ol>
          <li>Tryk <b>Åbn Aula-login</b>, vælg <b>Forælder</b> og godkend med MitID.</li>
          <li>Du ender på en side, der ikke kan vises (<i>app-private.aula.dk</i>). Det er meningen.</li>
          <li>Kopiér hele adressen fra adresselinjen, og indsæt den herunder.</li>
        </ol>
        <p>Åbner Aula-appen i stedet, så tag loginet i en privat fane i Safari.</p>
        <button class="knap" data-handling="aula-start">Åbn Aula-login</button>
        ${aulaVent ? h`<label class="felt"><span>Adressen du landede på</span>
          <textarea id="aula-adresse" placeholder="https://app-private.aula.dk/?code=…" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
          <small>Koden virker kun et par minutter.</small></label>
          <button class="knap bred" data-handling="aula-afslut">Forbind Aula</button>` : ''}`}
    </div>

    <div class="kort">
      <h3><span class="kilde forældreintra"></span>ForældreIntra ${statusMaerke('forældreintra')}</h3>
      ${kildeFejl('forældreintra')}
      ${fi ? h`<p>Logget ind som ${esc(fi.username)} på ${esc(fi.hostname)}.</p>
        <button class="knap fare lille" data-handling="fi-fra">Frakobl</button>` : h`
        <p>Brug skolens eget forældrelogin. Sender skolen jer videre til UniLogin, virker det desværre ikke.</p>
        <form data-form="fi">
          <label class="felt"><span>Skolens adresse</span><input name="hostname" placeholder="minskole.m.skoleintra.dk" autocapitalize="off" autocomplete="off" required></label>
          <label class="felt"><span>Brugernavn</span><input name="username" autocapitalize="off" autocomplete="username" required></label>
          <label class="felt"><span>Adgangskode</span><input name="password" type="password" autocomplete="current-password" required></label>
          <button class="knap bred">Forbind ForældreIntra</button>
        </form>`}
    </div>

    <div class="kort">
      <h3><span class="kilde holdsport"></span>Holdsport ${hs.length ? statusMaerke('holdsport') : '<span class="status fra">Ikke forbundet</span>'}</h3>
      ${kildeFejl('holdsport')}
      ${hs.map((x) => h`<p style="display:flex;align-items:center;gap:8px"><b style="color:var(--ink)">${esc(x.child)}</b> · ${esc(x.username)}
        <button class="knap fare lille" style="margin-left:auto" data-handling="hs-fra" data-id="${esc(x.id)}" data-barn="${esc(x.child)}">Fjern</button></p>`).join('')}
      <p>${hs.length ? 'Tilføj et login mere, fx for et andet barn.' : 'Ét login pr. barn – det login, barnets hold ligger under.'}</p>
      <form data-form="hs">
        <label class="felt"><span>Barnets navn</span><input name="child" autocomplete="off" required></label>
        <label class="felt"><span>Holdsport-brugernavn (e-mail)</span><input name="username" type="email" autocapitalize="off" autocomplete="username" required></label>
        <label class="felt"><span>Adgangskode</span><input name="password" type="password" autocomplete="current-password" required></label>
        <button class="knap bred">Tilføj Holdsport</button>
      </form>
    </div>

    <div class="kort">
      <h3>Denne enhed</h3>
      <p>Familiekoden er gemt på enheden. Den anden forælder logger ind med samme kode på sin telefon.</p>
      <button class="knap fare lille" data-handling="log-ud">Log ud på denne enhed</button>
    </div>
  `;
}

// ---------- ramme ----------
function render() {
  if (location.hash.startsWith('#opsaet=')) return renderOpsaet();
  if (!state.kode) return renderLogin();

  const titler = { idag: 'Overblik', nyt: 'Beskeder & opslag', kalender: 'Kalender', indstillinger: 'Indstillinger' };
  const indhold = { idag: visIdag, nyt: visNyt, kalender: visKalender, indstillinger: visIndstillinger }[state.view]();
  const antalNye = opslag(state.data?.items ?? []).filter((i) => nyt(i)).length;
  const erInd = state.view === 'indstillinger';

  app.innerHTML = h`
    <main class="side">
      <header class="top">
        <div>
          <h1>${titler[state.view]}</h1>
          <div class="dato">${fmt(new Date(), { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        </div>
        ${erInd
          ? `<button class="ikonknap" data-gaa="idag" aria-label="Tilbage">${ikon.tilbage}</button>`
          : `<button class="ikonknap" data-gaa="indstillinger" aria-label="Indstillinger">${ikon.tandhjul}</button>`}
      </header>
      ${erInd ? '' : bannere() + chips()}
      ${indhold}
      ${!erInd && state.data ? h`<p class="opdateret">Opdateret ${esc(hvornaar(state.data.hentet) || 'for lidt siden')}
        · <a href="#" data-handling="opdater">${state.henter ? 'Henter…' : 'Hent nu'}</a></p>` : ''}
    </main>
    <nav class="nav" aria-label="Hovedmenu"><div class="nav-indre">
      ${[['idag', 'Overblik'], ['nyt', 'Beskeder'], ['kalender', 'Kalender']].map(([v, navn]) => h`
        <button data-gaa="${v}" ${state.view === v ? 'aria-current="page"' : ''}>${ikon[v]}${navn}
        ${v === 'nyt' && antalNye ? `<span class="badge">${antalNye}</span>` : ''}</button>`).join('')}
    </div></nav>`;

  const m = location.hash.match(/#item=(.+)/);
  if (m) visItem(decodeURIComponent(m[1]));
}

function renderLogin(fejl = '') {
  app.innerHTML = h`<div class="velkomst"><div class="kort">
    <img src="icons/icon-180.png" alt="">
    <h1>Forældreoversigt</h1>
    <p>Indtast familiekoden for at se børnenes Aula, ForældreIntra og Holdsport samlet.</p>
    <form data-form="login">
      <label class="felt"><span>Familiekode</span><input name="kode" type="password" autocomplete="current-password" required autofocus></label>
      ${fejl ? `<div class="fejltekst">${esc(fejl)}</div>` : ''}
      <button class="knap bred">Log ind</button>
    </form>
  </div></div>`;
}

function renderOpsaet(fejl = '') {
  app.innerHTML = h`<div class="velkomst"><div class="kort">
    <img src="icons/icon-180.png" alt="">
    <h1>Velkommen</h1>
    <p>Vælg en familiekode. I skal begge bruge den til at logge ind, så vælg noget, I kan huske og dele.</p>
    <form data-form="opsaet">
      <label class="felt"><span>Familiekode</span><input name="kode" type="password" minlength="6" autocomplete="new-password" required>
        <small>Mindst 6 tegn.</small></label>
      <label class="felt"><span>Gentag familiekoden</span><input name="kode2" type="password" minlength="6" autocomplete="new-password" required></label>
      ${fejl ? `<div class="fejltekst">${esc(fejl)}</div>` : ''}
      <button class="knap bred">Sæt op</button>
    </form>
  </div></div>`;
}

function visItem(id) {
  const i = (state.data?.items ?? []).find((x) => x.id === id);
  document.querySelector('.slør')?.remove();
  document.querySelector('.ark')?.remove();
  if (!i) return;
  const fakta = [
    i.child && ['Barn', esc(i.child)],
    i.starts_at && ['Hvornår', esc(fmt(new Date(i.starts_at), { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })) + (i.ends_at ? `–${kl(i.ends_at)}` : '')],
    i.sender && [i.kind === 'aktivitet' ? 'Hold' : 'Fra', esc(i.sender)],
    !i.starts_at && (i.published_at || i.first_seen) && ['Dato', esc(fmt(new Date(i.published_at || i.first_seen), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }))],
    ['Kilde', `<span class="kilde ${esc(i.source)}">${KILDE[i.source]}</span>`],
  ].filter(Boolean);
  const slør = document.createElement('div');
  slør.className = 'slør';
  const ark = document.createElement('div');
  ark.className = 'ark';
  ark.setAttribute('role', 'dialog');
  ark.setAttribute('aria-modal', 'true');
  ark.innerHTML = h`<div class="greb"></div>
    <h3>${esc(i.title)}</h3>
    <dl class="fakta">${fakta.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    ${i.body ? `<div class="krop">${esc(i.body)}</div>` : '<div style="height:14px"></div>'}
    ${i.url ? `<a class="knap sekundaer bred" href="${esc(i.url)}" target="_blank" rel="noopener">Åbn i ${KILDE[i.source]}</a>` : ''}`;
  const luk = () => {
    slør.remove();
    ark.remove();
    if (location.hash.startsWith('#item=')) history.replaceState(null, '', location.pathname);
  };
  slør.addEventListener('click', luk);
  let startY = null;
  ark.addEventListener('touchstart', (e) => { if (ark.scrollTop <= 0) startY = e.touches[0].clientY; }, { passive: true });
  ark.addEventListener('touchend', (e) => { if (startY !== null && e.changedTouches[0].clientY - startY > 80) luk(); startY = null; });
  document.body.append(slør, ark);
}

// ---------- data ----------
async function hent() {
  if (!state.kode) return;
  try {
    state.data = await api('/oversigt');
    gem.set('oversigt', state.data);
    const born = state.data.children ?? [];
    if (state.barn !== 'alle' && !born.includes(state.barn)) state.barn = 'alle';
    render();
  } catch (e) {
    if (state.kode) toast(navigator.onLine ? e.message : 'Ingen forbindelse – viser det senest hentede.');
  }
}

async function hentIndstillinger() {
  try {
    state.indstillinger = await api('/indstillinger');
    if (state.view === 'indstillinger') render();
  } catch (e) { toast(e.message); }
}

async function synk() {
  if (state.henter) return;
  state.henter = true;
  render();
  try {
    await api('/sync', { method: 'POST' });
    await hent();
  } catch (e) {
    toast(e.message);
  } finally {
    state.henter = false;
    render();
  }
}

function gaa(view) {
  if (state.view === 'idag' && view !== 'idag') markerSet();
  state.view = view;
  if (view === 'indstillinger') {
    history.replaceState(null, '', '#indstillinger');
    hentIndstillinger();
  } else if (location.hash) {
    history.replaceState(null, '', location.pathname);
  }
  render();
  scrollTo(0, 0);
}

function markerSet() {
  state.sidstSet = Date.now();
  gem.set('sidstSet', state.sidstSet);
}

function logUd(besked) {
  state.kode = null;
  state.data = null;
  gem.del('kode');
  gem.del('oversigt');
  renderLogin(besked);
}

// ---------- push ----------
function b64ToBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function pushTil() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('Notifikationer blev ikke tilladt. Det kan ændres under Indstillinger → Notifikationer.');
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api('/push/noegle');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  const device = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android' : 'Computer';
  await api('/push/tilmeld', { method: 'POST', body: { subscription: sub.toJSON(), device } });
  gem.set('pushTil', true);
  toast('Notifikationer er slået til');
  hentIndstillinger();
}

async function pushFra() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api('/push/frameld', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
  gem.set('pushTil', false);
  toast('Notifikationer er slået fra på denne enhed');
  hentIndstillinger();
}

// ---------- hændelser ----------
async function medKnap(knap, fn) {
  const tekst = knap?.innerHTML;
  if (knap) { knap.disabled = true; knap.innerHTML = '<span class="spinner"></span>'; }
  try { await fn(); } catch (e) { toast(e.message, 5000); } finally {
    if (knap && knap.isConnected) { knap.disabled = false; knap.innerHTML = tekst; }
  }
}

app.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-gaa],[data-barn],[data-item],[data-handling]');
  if (!t) return;
  if (t.dataset.gaa) return gaa(t.dataset.gaa);
  if (t.dataset.item) {
    history.replaceState(null, '', '#item=' + encodeURIComponent(t.dataset.item));
    return visItem(t.dataset.item);
  }
  if (t.dataset.barn && t.classList.contains('chip')) {
    state.barn = t.dataset.barn;
    gem.set('barn', state.barn);
    return render();
  }
  const handling = t.dataset.handling;
  if (!handling) return;
  e.preventDefault();
  switch (handling) {
    case 'opdater': return synk();
    case 'push-til': return medKnap(t, pushTil);
    case 'push-fra': return medKnap(t, pushFra);
    case 'push-test': return medKnap(t, async () => {
      const r = await api('/push/test', { method: 'POST' });
      toast(r.leveret ? 'Testbesked sendt' : 'Ingen enheder modtog den');
    });
    case 'aula-start': {
      // Vinduet åbnes før await, ellers blokerer Safari det som popup.
      const vindue = window.open('about:blank', '_blank');
      return medKnap(t, async () => {
        const { url } = await api('/aula/start', { method: 'POST' });
        gem.set('aulaVent', true);
        if (vindue) vindue.location.href = url; else location.href = url;
        render();
      });
    }
    case 'aula-afslut': return medKnap(t, async () => {
      const adresse = document.getElementById('aula-adresse')?.value || '';
      await api('/aula/afslut', { method: 'POST', body: { adresse } });
      gem.set('aulaVent', false);
      toast('Aula er forbundet. Henter data…');
      await hentIndstillinger();
      setTimeout(hent, 12000);
    });
    case 'aula-fra': return medKnap(t, async () => {
      if (!confirm('Frakobl Aula?')) return;
      await api('/aula/frakobl', { method: 'POST' });
      await hentIndstillinger();
    });
    case 'fi-fra': return medKnap(t, async () => {
      if (!confirm('Frakobl ForældreIntra?')) return;
      await api('/foraeldreintra/frakobl', { method: 'POST' });
      await hentIndstillinger();
    });
    case 'hs-fra': return medKnap(t, async () => {
      if (!confirm(`Fjern Holdsport for ${t.dataset.barn}?`)) return;
      await api('/holdsport/fjern', { method: 'POST', body: { id: t.dataset.id, child: t.dataset.barn } });
      await hentIndstillinger();
      hent();
    });
    case 'log-ud': return logUd('');
  }
});

app.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  const knap = form.querySelector('button');
  switch (form.dataset.form) {
    case 'login':
      return medKnap(knap, async () => {
        try {
          await api('/indstillinger', { kode: data.kode });
        } catch (err) {
          return renderLogin(err.message);
        }
        state.kode = data.kode;
        gem.set('kode', data.kode);
        state.view = 'idag';
        render();
        hent();
      });
    case 'opsaet':
      if (data.kode !== data.kode2) return renderOpsaet('De to koder er ikke ens.');
      return medKnap(knap, async () => {
        const token = decodeURIComponent(location.hash.slice('#opsaet='.length));
        try {
          await api('/opsaet', { method: 'POST', body: { token, kode: data.kode }, kode: null });
        } catch (err) {
          return renderOpsaet(err.message);
        }
        history.replaceState(null, '', location.pathname);
        state.kode = data.kode;
        gem.set('kode', data.kode);
        gaa('indstillinger');
      });
    case 'fi':
      return medKnap(knap, async () => {
        const r = await api('/foraeldreintra', { method: 'POST', body: data });
        toast(`ForældreIntra er forbundet${r.børn?.length ? ': ' + r.børn.join(', ') : ''}`, 5000);
        await hentIndstillinger();
        setTimeout(hent, 15000);
      });
    case 'hs':
      return medKnap(knap, async () => {
        const r = await api('/holdsport', { method: 'POST', body: data });
        toast(`Holdsport forbundet${r.hold?.length ? ': ' + r.hold.join(', ') : ''}`, 5000);
        form.reset();
        await hentIndstillinger();
        setTimeout(hent, 8000);
      });
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelector('.slør')?.click();
});

let sidstHentet = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - sidstHentet > 3 * 60_000) {
    sidstHentet = Date.now();
    hent();
  } else if (document.visibilityState === 'hidden' && state.view === 'idag') {
    markerSet();
  }
});

window.addEventListener('hashchange', () => {
  const m = location.hash.match(/#item=(.+)/);
  if (m) visItem(decodeURIComponent(m[1]));
});

// ---------- start ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (location.hash === '#indstillinger') state.view = 'indstillinger';
render();
if (state.kode) {
  hent();
  if (state.view === 'indstillinger') hentIndstillinger();
}
