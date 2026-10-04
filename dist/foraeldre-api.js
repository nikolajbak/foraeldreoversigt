// supabase/functions/foraeldre-api/db.ts
import postgres from "npm:postgres@3.4.7";
var sql = postgres(Deno.env.get("SUPABASE_DB_URL"), {
  prepare: false,
  max: 3,
  idle_timeout: 20,
  onnotice: () => {
  }
});
async function getConfig(key) {
  const rows = await sql`select value from foraeldre.config where key = ${key}`;
  return rows[0]?.value;
}
async function setConfig(key, value) {
  await sql`
    insert into foraeldre.config (key, value) values (${key}, ${sql.json(value)})
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}
async function deleteConfig(key) {
  await sql`delete from foraeldre.config where key = ${key}`;
}
async function getCredential(source) {
  const rows = await sql`select data from foraeldre.credentials where source = ${source}`;
  return rows[0]?.data;
}
async function setCredential(source, data) {
  await sql`
    insert into foraeldre.credentials (source, data) values (${source}, ${sql.json(data)})
    on conflict (source) do update set data = excluded.data, updated_at = now()`;
}
async function deleteCredential(source) {
  await sql`delete from foraeldre.credentials where source = ${source}`;
}
async function listCredentialSources(prefix) {
  const rows = await sql`
    select source from foraeldre.credentials where source like ${prefix + "%"} order by source`;
  return rows.map((r) => r.source);
}
async function getStatus(source) {
  const rows = await sql`select * from foraeldre.source_status where source = ${source}`;
  return rows[0];
}
async function setStatus(source, s) {
  await sql`
    insert into foraeldre.source_status (source, ok, message, needs_login, baseline_done, last_run)
    values (${source}, ${s.ok}, ${s.message ?? null}, ${s.needs_login ?? false},
            ${s.baseline_done ?? false}, now())
    on conflict (source) do update set
      ok = excluded.ok,
      message = excluded.message,
      needs_login = excluded.needs_login,
      baseline_done = foraeldre.source_status.baseline_done or excluded.baseline_done,
      last_run = now()`;
}
async function rememberChildren(names) {
  for (const name of names) {
    if (!name.trim()) continue;
    await sql`insert into foraeldre.children (name) values (${name.trim()}) on conflict do nothing`;
  }
}

// supabase/functions/foraeldre-api/types.ts
var NeedsLoginError = class extends Error {
  name = "NeedsLoginError";
};
function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6])>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, "\n\n").trim();
}
function toIso(v) {
  if (!v) return null;
  const fixed = v.replace(" ", "T").replace(/\.\d+/, "").replace(/([+-]\d\d)(\d\d)$/, "$1:$2");
  const d = new Date(fixed);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [
    ...new Uint8Array(buf)
  ].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// supabase/functions/foraeldre-api/aula.ts
var CLIENT_ID = "_99949a54b8b65423862aac1bf629599ed64231607a";
var SCOPE = "aula-sensitive";
var REDIRECT_URI = "https://app-private.aula.dk";
var AUTH_BASE = "https://login.aula.dk/simplesaml/module.php/oidc";
var API_HOST = "https://www.aula.dk";
var PORTAL = "https://www.aula.dk/portal/#";
var b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function startLogin() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  await setConfig("aula_pending", {
    verifier,
    state,
    created: Date.now()
  });
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: SCOPE,
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });
  return `${AUTH_BASE}/authorize.php?${qs}`;
}
async function finishLogin(pasted) {
  const pending = await getConfig("aula_pending");
  if (!pending || Date.now() - pending.created > 30 * 6e4) {
    throw new Error('Login-fors\xF8get er udl\xF8bet. Tryk "Log ind med MitID" igen.');
  }
  let code = pasted.trim();
  let state = null;
  const m = code.match(/[?&#]code=([^&#\s]+)/);
  if (m) {
    code = decodeURIComponent(m[1]);
    const s = pasted.match(/[?&#]state=([^&#\s]+)/)?.[1];
    if (s) state = decodeURIComponent(s);
  }
  if (!code || code.includes("://")) {
    throw new Error("Kunne ikke finde en kode i adressen. Kopi\xE9r hele adressen fra adresselinjen.");
  }
  if (state && state !== pending.state) {
    throw new Error("Adressen h\xF8rer til et \xE6ldre login-fors\xF8g. Start forfra.");
  }
  const res = await fetch(`${AUTH_BASE}/token.php`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: pending.verifier
    })
  });
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`Aula afviste koden (${res.status}). Koden virker kun f\xE5 minutter \u2013 pr\xF8v igen.`);
  }
  await setCredential("aula", parseTokens(text));
  await deleteConfig("aula_pending");
}
function parseTokens(body, fallbackRefresh) {
  const j = JSON.parse(body);
  const now = Math.floor(Date.now() / 1e3);
  const refresh2 = j.refresh_token ?? fallbackRefresh;
  if (!j.access_token || !refresh2) throw new Error("Aula svarede uden tokens");
  return {
    access_token: j.access_token,
    refresh_token: refresh2,
    expires_at: now + Number(j.expires_in ?? 3600),
    obtained_at: now
  };
}
async function refresh(tokens) {
  const res = await fetch(`${AUTH_BASE}/token.php`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CLIENT_ID
    })
  });
  const text = await res.text();
  if (res.status === 400 || res.status === 401) {
    throw new NeedsLoginError("Aula-adgangen er udl\xF8bet. Log ind med MitID igen.");
  }
  if (res.status !== 200) throw new Error(`Aula token-fornyelse fejlede (${res.status})`);
  const next = {
    ...parseTokens(text, tokens.refresh_token),
    last_refresh: Math.floor(Date.now() / 1e3)
  };
  await setCredential("aula", next);
  return next;
}
async function validTokens(force = false) {
  const tokens = await getCredential("aula");
  if (!tokens) throw new NeedsLoginError("Aula er ikke forbundet endnu.");
  const now = Math.floor(Date.now() / 1e3);
  const stale = now - (tokens.last_refresh ?? tokens.obtained_at) > 6 * 3600;
  if (force || stale || tokens.expires_at - 120 < now) return await refresh(tokens);
  return tokens;
}
async function isConnected() {
  return !!await getCredential("aula");
}
var AulaApi = class {
  tokens;
  cookies;
  version;
  contextReady;
  constructor(tokens) {
    this.tokens = tokens;
    this.cookies = /* @__PURE__ */ new Map();
    this.version = 22;
    this.contextReady = false;
  }
  cookieHeader() {
    return [
      ...this.cookies
    ].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  keepCookies(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  url(params) {
    params.set("access_token", this.tokens.access_token);
    return `${API_HOST}/api/v${this.version}/?${params}`;
  }
  async init() {
    const stored = await getConfig("aula_api_version");
    if (stored) this.version = stored;
    for (let v = this.version; v <= this.version + 8; v++) {
      this.version = v;
      const res = await this.raw(new URLSearchParams({
        method: "profiles.getProfilesByLogin"
      }));
      if (res.status === 200) {
        await res.body?.cancel();
        if (v !== stored) await setConfig("aula_api_version", v);
        return;
      }
      await res.body?.cancel();
      if (res.status === 401 || res.status === 403) throw new AuthFailed();
      if (res.status !== 410) throw new Error(`Aula svarede ${res.status} p\xE5 versionstjek`);
    }
    throw new Error("Fandt ingen gyldig Aula API-version");
  }
  async raw(params, init = {}) {
    const res = await fetch(this.url(params), {
      ...init,
      headers: {
        accept: "application/json",
        cookie: this.cookieHeader(),
        ...init.headers ?? {}
      },
      redirect: "manual"
    });
    this.keepCookies(res);
    return res;
  }
  async envelope(res) {
    const text = await res.text();
    if (res.status === 401) throw new AuthFailed();
    if (res.status !== 200) throw new Error(`Aula API ${res.status}: ${text.slice(0, 200)}`);
    const env = JSON.parse(text);
    const code = env?.status?.code;
    if (code === 448) throw new StepUpRequired();
    if (code && code !== 0) {
      if (code === 401 || code === 403) throw new StepUpRequired();
      throw new Error(`Aula API fejl ${code}: ${env?.status?.message ?? ""}`);
    }
    return env.data;
  }
  async get(method, query = {}, arrays = {}) {
    const params = new URLSearchParams({
      method,
      ...query
    });
    for (const [k, vs] of Object.entries(arrays)) for (const v of vs) params.append(`${k}[]`, String(v));
    return this.envelope(await this.raw(params));
  }
  async post(method, body) {
    if (!this.contextReady) {
      await this.get("profiles.getProfileContext", {
        portalrole: "guardian"
      });
      this.contextReady = true;
    }
    const headers = {
      "content-type": "application/json"
    };
    const csrf = this.cookies.get("Csrfp-Token");
    if (csrf) headers["csrfp-token"] = csrf;
    return this.envelope(await this.raw(new URLSearchParams({
      method
    }), {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    }));
  }
};
var AuthFailed = class extends Error {
};
var StepUpRequired = class extends Error {
};
function aulaTs(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Copenhagen",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset"
  }).formatToParts(d).map((x) => [
    x.type,
    x.value
  ]));
  const off = p.timeZoneName.replace("GMT", "").replace(":", "") || "+0000";
  const hour = p.hour === "24" ? "00" : p.hour;
  return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute}:${p.second}.0000${off}`;
}
async function syncAula(known, hashOf2) {
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
      if (e2 instanceof AuthFailed) throw new NeedsLoginError("Aula afviser adgangen. Log ind med MitID igen.");
      throw e2;
    }
  }
  const profiles = await api.get("profiles.getProfilesByLogin");
  const guardian = profiles.profiles.find((p) => (p.portalRole ?? "guardian") === "guardian") ?? profiles.profiles[0];
  const kids = guardian?.children ?? [];
  const kidIds = kids.map((k) => k.id);
  const nameById = new Map(kids.map((k) => [
    k.id,
    firstName(k.name)
  ]));
  const ctx = await api.get("profiles.getProfileContext", {
    portalrole: "guardian"
  });
  const guardianIds = (ctx?.institutionProfiles ?? guardian?.institutionProfiles ?? []).map((p) => p.id).filter(Boolean);
  const items = [];
  const threads = await api.get("messaging.getThreads", {
    sortOn: "date",
    orderDirection: "desc",
    page: "0"
  });
  let bodiesFetched = 0;
  for (const t of threads?.threads ?? []) {
    const latestId = t.latestMessage?.id ?? t.lastMessage?.id ?? t.latestMessage?.sendDateTime;
    const sent = t.latestMessage?.sendDateTime ?? t.lastMessage?.sendDateTime;
    const item = {
      id: `aula:besked:${t.id}`,
      source: "aula",
      kind: "besked",
      title: t.subject || "(uden emne)",
      sender: t.lastMessage?.sender?.fullName ?? t.latestMessage?.sender?.fullName ?? null,
      published_at: toIso(sent),
      url: `${PORTAL}/beskeder/${t.id}`,
      important: !t.read,
      body: stripHtml(t.lastMessage?.text?.html ?? t.lastMessage?.text ?? t.latestMessage?.text?.html ?? "") || null,
      hashParts: [
        latestId
      ]
    };
    const changed = known.get(item.id) !== await hashOf2(item);
    if (changed && bodiesFetched < 8) {
      bodiesFetched++;
      try {
        const data = await api.get("messaging.getMessagesForThread", {
          threadId: String(t.id),
          page: "0"
        });
        const msgs = data?.messages ?? [];
        const newest = msgs[0];
        if (newest) {
          item.body = stripHtml(newest.text?.html ?? newest.text ?? "") || item.body;
          item.sender = newest.sender?.fullName ?? item.sender;
        }
      } catch (e) {
        if (e instanceof StepUpRequired) item.body = "F\xF8lsom besked \u2013 \xE5bn den i Aula.";
        else throw e;
      }
    }
    items.push(item);
  }
  const posts = await api.get("posts.getAllPosts", {
    parent: "profile",
    index: "0",
    limit: "20",
    isUnread: "false"
  }, {
    institutionProfileIds: [
      .../* @__PURE__ */ new Set([
        ...guardianIds,
        ...kidIds
      ])
    ]
  });
  for (const p of posts?.posts ?? []) {
    const body = stripHtml(p.content?.html);
    items.push({
      id: `aula:opslag:${p.id}`,
      source: "aula",
      kind: "opslag",
      title: p.title || "(opslag)",
      body: body.length > 1500 ? body.slice(0, 1500) + "\u2026" : body,
      sender: p.ownerProfile?.fullName ?? p.ownerProfile?.name ?? null,
      published_at: toIso(p.timestamp ?? p.publishAt),
      important: !!p.isImportant,
      url: `${PORTAL}/overblik`,
      hashParts: [
        p.title,
        body.slice(0, 500)
      ]
    });
  }
  if (kidIds.length) {
    const start = /* @__PURE__ */ new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 45 * 864e5);
    const events = await api.post("calendar.getEventsByProfileIdsAndResourceIds", {
      instProfileIds: kidIds,
      resourceIds: [],
      start: aulaTs(start),
      end: aulaTs(end)
    });
    for (const ev of events ?? []) {
      if (ev.type === "lesson") continue;
      const who = (ev.belongsToProfiles ?? []).map((id) => nameById.get(id)).filter(Boolean).join(", ");
      items.push({
        id: `aula:begivenhed:${ev.id ?? `${ev.title}|${ev.startDateTime}`}`,
        source: "aula",
        kind: "begivenhed",
        child: who || null,
        title: ev.title || "Begivenhed",
        body: ev.primaryResource?.name ? `Sted: ${ev.primaryResource.name}` : null,
        starts_at: toIso(ev.startDateTime),
        ends_at: toIso(ev.endDateTime),
        url: `${PORTAL}/kalender`,
        hashParts: [
          ev.title,
          ev.startDateTime,
          ev.endDateTime,
          ev.primaryResource?.name
        ]
      });
    }
  }
  return {
    items,
    children: kids.map((k) => firstName(k.name))
  };
}
function firstName(full) {
  return (full ?? "").trim().split(/\s+/)[0] ?? full;
}

// supabase/functions/foraeldre-api/fskintra/auth/errors.ts
var FskintraAuthError = class extends Error {
  name = "FskintraAuthError";
  cause;
  constructor(message2, options) {
    super(message2);
    this.cause = options?.cause;
  }
};
var RedirectLoopError = class extends FskintraAuthError {
  hops;
  lastUrl;
  name;
  constructor(hops, lastUrl) {
    super(`Exceeded ${hops} redirect hops; stuck at ${lastUrl}`), this.hops = hops, this.lastUrl = lastUrl, this.name = "RedirectLoopError";
  }
};
var InvalidCredentialsError = class extends FskintraAuthError {
  name = "InvalidCredentialsError";
};
var UniLoginNotSupportedError = class extends FskintraAuthError {
  host;
  name;
  constructor(host) {
    super(`The school redirected to UNI-Login (${host}). This client supports ordinary For\xE6ldreIntra login only.`), this.host = host, this.name = "UniLoginNotSupportedError";
  }
};
var ConfirmContactsRequiredError = class extends FskintraAuthError {
  url;
  pageText;
  name;
  constructor(url, pageText) {
    super(`For\xE6ldreIntra requires you to confirm your contact details before continuing (${url}).`), this.url = url, this.pageText = pageText, this.name = "ConfirmContactsRequiredError";
  }
};
var NotLoggedInError = class extends FskintraAuthError {
  name = "NotLoggedInError";
  constructor(message2 = "No For\xE6ldreIntra session. Run `fskintra login` first.") {
    super(message2);
  }
};

// supabase/functions/foraeldre-api/fskintra/auth/child-link.ts
var CHILD_LINK_RE = /^(?:https?:\/\/[^/]+)?(?:\/[^/]*){3}\/Index\/?$/i;
function isChildLink(href) {
  if (href == null) return false;
  const pathOnly = href.split(/[?#]/, 1)[0] ?? href;
  return CHILD_LINK_RE.test(pathOnly);
}

// supabase/functions/foraeldre-api/fskintra/auth/cookies.ts
import { Cookie, CookieJar } from "npm:tough-cookie@^6.0.2";

// supabase/functions/foraeldre-api/fskintra/auth/logger.ts
var silentLogger = {
  debug() {
  },
  info() {
  },
  warn() {
  },
  error() {
  }
};

// supabase/functions/foraeldre-api/fskintra/auth/cookies.ts
var FskintraCookieJar = class _FskintraCookieJar {
  jar;
  logger;
  constructor(opts = {}) {
    if (opts instanceof CookieJar) {
      this.jar = opts;
      this.logger = silentLogger;
    } else {
      this.jar = opts.jar ?? new CookieJar();
      this.logger = opts.logger ?? silentLogger;
    }
  }
  /** Parse and store every Set-Cookie header from a response. */
  async storeFromResponse(headers, requestUrl) {
    for (const sc of headers.getSetCookie()) {
      const parsed = Cookie.parse(sc);
      if (!parsed) {
        this.logger.warn("cookies.parse_failed", {
          snippet: sc.slice(0, 80),
          requestUrl
        });
        continue;
      }
      try {
        await this.jar.setCookie(parsed, requestUrl);
      } catch (e) {
        this.logger.warn("cookies.set_failed", {
          name: parsed.key,
          domain: parsed.domain ?? "<implicit>",
          requestUrl,
          error: e.message
        });
      }
    }
  }
  /** Cookie header value to send with a request, or empty string if none apply. */
  async cookieHeader(url) {
    return this.jar.getCookieString(url);
  }
  /** Look up a single cookie by name — handy for anti-forgery tokens. */
  async getCookieValue(url, name) {
    const cookies = await this.jar.getCookies(url);
    return cookies.find((c) => c.key === name)?.value;
  }
  /** Serialize the entire jar — for persistence across CLI invocations. */
  async serialize() {
    return JSON.stringify(await this.jar.serialize());
  }
  /** Restore a previously-serialized jar. */
  static async deserialize(serialized) {
    const jar = await CookieJar.deserialize(JSON.parse(serialized));
    return new _FskintraCookieJar(jar);
  }
};

// supabase/functions/foraeldre-api/fskintra/auth/crypto.ts
import { Buffer as Buffer2 } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash, randomBytes as nodeRandomBytes } from "node:crypto";

// supabase/functions/foraeldre-api/fskintra/auth/encoding.ts
import { Buffer } from "node:buffer";

// supabase/functions/foraeldre-api/fskintra/auth/html.ts
import * as cheerio from "npm:cheerio@^1.2.0";
function parse(html) {
  return cheerio.load(html);
}
function clean(text) {
  return (text ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}
function textOf($, el) {
  if (!el) return "";
  const node = "length" in el ? el : $(el);
  const clone = node.clone();
  clone.find("br").replaceWith("\n");
  clone.find("p, div, li, tr, h1, h2, h3, h4, h5, h6").append("\n");
  return clone.text().replace(/ /g, " ").split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).filter((line) => line !== "").join("\n").trim();
}
function serializeForm($, form, overrides = {}) {
  const fields = new URLSearchParams();
  form.find("input, select, textarea").each((_, raw) => {
    const el = $(raw);
    const name = el.attr("name");
    if (!name || el.attr("disabled") !== void 0) return;
    const tag = raw.tagName?.toLowerCase();
    if (tag === "select") {
      const selected = el.find("option[selected]").first();
      const option = selected.length ? selected : el.find("option").first();
      fields.append(name, option.attr("value") ?? clean(option.text()));
      return;
    }
    if (tag === "textarea") {
      fields.append(name, el.text());
      return;
    }
    const type = (el.attr("type") ?? "text").toLowerCase();
    if (type === "submit" || type === "button" || type === "image" || type === "file") return;
    if ((type === "checkbox" || type === "radio") && el.attr("checked") === void 0) return;
    fields.append(name, el.attr("value") ?? "");
  });
  for (const [name, value] of Object.entries(overrides)) {
    fields.delete(name);
    fields.append(name, value);
  }
  return {
    action: form.attr("action") ?? "",
    method: (form.attr("method") ?? "GET").toUpperCase() === "POST" ? "POST" : "GET",
    fields
  };
}
function findFormWithField($, ...names) {
  for (const name of names) {
    const control = $(`form [name="${name}"]`).first();
    if (control.length) {
      const form = control.closest("form");
      if (form.length) return form;
    }
  }
  return void 0;
}
var MONTHS = {
  jan: 1,
  januar: 1,
  feb: 2,
  februar: 2,
  mar: 3,
  mars: 3,
  marts: 3,
  apr: 4,
  april: 4,
  maj: 5,
  jun: 6,
  juni: 6,
  jul: 7,
  juli: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  okt: 10,
  oktober: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12
};
function parseDanishDateTime(input, now = /* @__PURE__ */ new Date()) {
  const text = clean(input).toLowerCase().replace(/\bkl\.?\b/g, " ");
  const time = /(\d{1,2})[:.](\d{2})/.exec(text);
  const hh = time ? Number(time[1]) : 12;
  const mm = time ? Number(time[2]) : 0;
  const relative = /\bi\s*(dag|går|morgen)\b/.exec(text);
  if (relative) {
    const shift = relative[1] === "g\xE5r" ? -1 : relative[1] === "morgen" ? 1 : 0;
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + shift, hh, mm);
    return toIsoLocal(day);
  }
  const named = /(\d{1,2})\.?\s+([a-zæøå]+)\.?\s+(\d{4})/.exec(text);
  if (named) {
    const month = MONTHS[named[2] ?? ""];
    if (month) return toIsoLocal(new Date(Number(named[3]), month - 1, Number(named[1]), hh, mm));
  }
  const numeric = /(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/.exec(text);
  if (numeric) {
    const year = Number(numeric[3]);
    return toIsoLocal(new Date(year < 100 ? 2e3 + year : year, Number(numeric[2]) - 1, Number(numeric[1]), hh, mm));
  }
  return void 0;
}
function toIsoLocal(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// supabase/functions/foraeldre-api/fskintra/auth/wire-tracer.ts
import { Buffer as Buffer3 } from "node:buffer";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
var noopTracer = {
  record() {
  }
};
var SECRET_HEADERS = /* @__PURE__ */ new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "__requestverificationtoken"
]);
var SECRET_BODY_FIELDS = /* @__PURE__ */ new Set([
  "password",
  "passwd",
  "pass",
  "pwd",
  "__requestverificationtoken",
  "samlresponse",
  "relaystate",
  "token",
  "access_token",
  "refresh_token",
  "code",
  "code_verifier"
]);
var SECRET_URL_PARAMS = /* @__PURE__ */ new Set([
  "password",
  "token",
  "access_token",
  "refresh_token",
  "code",
  "code_verifier",
  "state",
  "__requestverificationtoken",
  "ticket"
]);
function redacted(value) {
  return `<redacted ${value.length} chars>`;
}
function sanitizeHeaders(headers) {
  const out = {};
  const entries = headers instanceof Headers ? [
    ...headers.entries()
  ] : Object.entries(headers ?? {});
  for (const [rawKey, value] of entries) {
    const key = rawKey.toLowerCase();
    out[key] = SECRET_HEADERS.has(key) ? redacted(value) : value;
  }
  return out;
}
function sanitizeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  for (const [key, value] of [
    ...parsed.searchParams.entries()
  ]) {
    if (SECRET_URL_PARAMS.has(key.toLowerCase())) {
      parsed.searchParams.set(key, redacted(value));
    }
  }
  return parsed.toString();
}
function sanitizeRequestBody(body) {
  if (body == null || body === "") return null;
  if (body.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(body);
      for (const key of Object.keys(parsed)) {
        if (SECRET_BODY_FIELDS.has(key.toLowerCase())) {
          parsed[key] = redacted(String(parsed[key]));
        }
      }
      return JSON.stringify(parsed);
    } catch {
    }
  }
  if (body.includes("=")) {
    const params = new URLSearchParams(body);
    const out = new URLSearchParams();
    for (const [key, value] of params.entries()) {
      out.append(key, SECRET_BODY_FIELDS.has(key.toLowerCase()) ? redacted(value) : value);
    }
    return out.toString();
  }
  return redacted(body);
}
var MAX_RESPONSE_CHARS = 4096;
function sanitizeResponseBody(body) {
  const bytes = Buffer3.byteLength(body, "utf8");
  if (body.length <= MAX_RESPONSE_CHARS) return {
    text: body,
    bytes
  };
  return {
    text: `${body.slice(0, MAX_RESPONSE_CHARS)}
\u2026<truncated, ${bytes} bytes total>`,
    bytes
  };
}

// supabase/functions/foraeldre-api/fskintra/auth/http.ts
var DEFAULT_HEADERS = Object.freeze({
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "sec-ch-ua": '"Google Chrome";v="126", "Chromium";v="126", "Not-A.Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "upgrade-insecure-requests": "1",
  "accept-language": "da-DK,da;q=0.9,en;q=0.8",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
});
var REDIRECT_STATUSES = /* @__PURE__ */ new Set([
  301,
  302,
  303,
  307,
  308
]);
var FskintraHttpClient = class {
  tracer;
  _jar;
  logger;
  defaultHeaders;
  seq = 0;
  constructor(options = {}) {
    this.logger = options.logger ?? silentLogger;
    this._jar = options.jar ?? new FskintraCookieJar({
      logger: this.logger
    });
    this.tracer = options.tracer ?? noopTracer;
    this.defaultHeaders = {
      ...DEFAULT_HEADERS,
      ...options.defaultHeaders ?? {}
    };
  }
  get jar() {
    return this._jar;
  }
  /**
   * Swap in a jar deserialized from the session store. Replacing the jar
   * (rather than merging into the current one) is deliberate: a resumed
   * session should start from exactly the cookies that were persisted, with
   * no leftovers from a previous attempt in this process.
   */
  async restoreJar(serialized) {
    this._jar = await FskintraCookieJar.deserialize(serialized);
  }
  /** Drop all cookies — `logout`, and the retry path after a dead session. */
  resetJar() {
    this._jar = new FskintraCookieJar({
      logger: this.logger
    });
  }
  /** One request, no redirect following. Cookies in and out are handled. */
  async request(url, options = {}) {
    const method = (options.method ?? "GET").toUpperCase();
    const headers = options.noDefaultHeaders ? {
      ...options.headers ?? {}
    } : {
      ...this.defaultHeaders,
      ...options.headers ?? {}
    };
    const cookie = await this._jar.cookieHeader(url);
    if (cookie) headers["cookie"] = cookie;
    const body = options.body instanceof URLSearchParams ? options.body.toString() : options.body;
    if (body != null && !headers["content-type"]) {
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    const startedAt = Date.now();
    this.logger.debug("http.request", {
      method,
      url: sanitizeUrl(url)
    });
    const response = await fetch(url, {
      method,
      headers,
      ...body == null ? {} : {
        body
      },
      redirect: "manual"
    });
    await this._jar.storeFromResponse(response.headers, url);
    const text = await response.text();
    const durationMs = Date.now() - startedAt;
    const sanitizedResponse = sanitizeResponseBody(text);
    this.seq += 1;
    this.tracer.record({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      seq: this.seq,
      method,
      url: sanitizeUrl(url),
      requestHeaders: sanitizeHeaders(headers),
      requestBody: sanitizeRequestBody(body ?? null),
      status: response.status,
      responseHeaders: sanitizeHeaders(response.headers),
      responseBody: sanitizedResponse.text,
      responseBodyBytes: sanitizedResponse.bytes,
      durationMs
    });
    return {
      status: response.status,
      headers: response.headers,
      body: text,
      url
    };
  }
  /**
   * Walk the redirect chain manually, collecting cookies at every hop.
   * 303 always becomes GET; 301/302 do too, matching what browsers actually
   * do with form POSTs. 307/308 preserve the method and body.
   */
  async follow(url, options = {}) {
    const maxHops = options.maxHops ?? 12;
    const history = [];
    const { body: _initialBody, maxHops: _maxHops, method: _method, ...perRequest } = options;
    let current = url;
    let method = options.method ?? "GET";
    let body = options.body;
    for (let hop = 0; hop < maxHops; hop++) {
      const response = await this.request(current, {
        ...perRequest,
        method,
        ...body == null ? {} : {
          body
        }
      });
      history.push({
        url: current,
        status: response.status
      });
      const location = response.headers.get("location");
      if (!REDIRECT_STATUSES.has(response.status) || !location) {
        return {
          history,
          final: {
            ...response,
            url: current
          }
        };
      }
      current = new URL(location, current).toString();
      if (response.status !== 307 && response.status !== 308) {
        method = "GET";
        body = void 0;
      }
    }
    throw new RedirectLoopError(maxHops, current);
  }
  /** Fetch a binary resource (attachment, photo) with the session's cookies. */
  async requestBinary(url) {
    const cookie = await this._jar.cookieHeader(url);
    const response = await fetch(url, {
      headers: {
        ...this.defaultHeaders,
        ...cookie ? {
          cookie
        } : {}
      },
      redirect: "follow"
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${sanitizeUrl(url)}`);
    }
    return {
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      data: new Uint8Array(await response.arrayBuffer())
    };
  }
};

// supabase/functions/foraeldre-api/fskintra/auth/login-client.ts
var INDEX_RE = /\/parent\/[^/]+\/[^/]*\/Index\/?$/i;
var LANDING_FALLBACK = "/";
var MAX_ROUNDS = 8;
var ENTRY_PATHS = [
  "/Fi/",
  "/Account/IdpLogin"
];
function normalizeHostname(input) {
  return input.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
}
var FskintraLoginClient = class {
  http;
  logger;
  autoConfirmContacts;
  constructor(options = {}) {
    this.logger = options.logger ?? silentLogger;
    this.http = options.http ?? new FskintraHttpClient({
      logger: this.logger
    });
    this.autoConfirmContacts = options.autoConfirmContacts ?? false;
  }
  absUrl(hostname, url) {
    if (/^https?:\/\//i.test(url)) return url;
    return `https://${hostname}${url.startsWith("/") ? "" : "/"}${url}`;
  }
  /**
   * Restore a previous session's cookies and check whether they still work by
   * fetching the cached front page. Returns undefined when there is nothing to
   * restore or the session is dead — the caller then runs a full `login()`.
   *
   * This is the cheap path, and the common one: it is a single GET.
   */
  async resume(record) {
    if (!record.cookies || !record.indexUrl) return void 0;
    await this.http.restoreJar(record.cookies);
    this.logger.debug("login.resume_attempt", {
      indexUrl: record.indexUrl
    });
    let response;
    try {
      const followed = await this.http.follow(record.indexUrl);
      response = followed.final;
    } catch (error) {
      this.logger.info("login.resume_failed", {
        error: error.message
      });
      return void 0;
    }
    const doc = parse(response.body);
    if (response.status !== 200 || !this.isFrontPage(doc, new URL(response.url))) {
      this.logger.info("login.resume_rejected", {
        url: response.url,
        status: response.status
      });
      return void 0;
    }
    return {
      doc,
      indexUrl: response.url,
      cookies: await this.http.jar.serialize()
    };
  }
  /** Full login from credentials. */
  async login(credentials) {
    const hostname = normalizeHostname(credentials.hostname);
    this.logger.info("login.start", {
      hostname,
      username: credentials.username
    });
    let response = await this.openEntryPage(hostname);
    const triedLandings = /* @__PURE__ */ new Set();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const doc = parse(response.body);
      const url = new URL(response.url);
      this.logger.debug("login.step", {
        round: round + 1,
        url: response.url,
        status: response.status
      });
      if (response.body.length > 0 && INDEX_RE.test(url.pathname)) {
        this.logger.info("login.success", {
          indexUrl: response.url
        });
        return {
          doc,
          indexUrl: response.url,
          cookies: await this.http.jar.serialize()
        };
      }
      if (url.hostname.endsWith("emu.dk") || /unilogin/i.test(url.hostname)) {
        throw new UniLoginNotSupportedError(url.hostname);
      }
      if (/\/ConfirmContacts\/?$/i.test(url.pathname)) {
        response = await this.handleConfirmContacts(doc, response.url);
        continue;
      }
      const relay = this.findRelayForm(doc, url) ?? void 0;
      if (relay?.explicit) {
        this.logger.debug("login.relay", {
          action: relay.action || response.url
        });
        response = (await this.http.follow(new URL(relay.action || response.url, response.url).toString(), {
          method: relay.method,
          ...relay.method === "POST" ? {
            body: relay.fields
          } : {}
        })).final;
        continue;
      }
      if (/\/Account\/(IdpLogin|Login)\/?$/i.test(url.pathname)) {
        response = await this.submitCredentials(doc, response.url, credentials);
        continue;
      }
      if (response.body.length > 0 && this.hasChildLinks(doc)) {
        this.logger.info("login.success", {
          indexUrl: response.url
        });
        return {
          doc,
          indexUrl: response.url,
          cookies: await this.http.jar.serialize()
        };
      }
      if (relay && response.status < 400) {
        this.logger.debug("login.relay_generic", {
          action: relay.action || response.url
        });
        response = (await this.http.follow(new URL(relay.action || response.url, response.url).toString(), {
          method: relay.method,
          ...relay.method === "POST" ? {
            body: relay.fields
          } : {}
        })).final;
        continue;
      }
      const recovered = await this.followLandingFallback(response, hostname, triedLandings);
      if (!recovered) break;
      response = recovered;
    }
    throw new FskintraAuthError(`Login did not reach the For\xE6ldreIntra front page after ${MAX_ROUNDS} rounds. Last URL: ${response.url}. Re-run with --debug for a wire transcript.`);
  }
  /**
   * Walk ENTRY_PATHS until one of them yields a page. A 404 means this
   * installation does not have that door, not that login is impossible, so it
   * is a reason to try the next path rather than to give up.
   */
  async openEntryPage(hostname) {
    const attempts = [];
    let unreachable = 0;
    let firstCause;
    for (const path of ENTRY_PATHS) {
      const url = this.absUrl(hostname, path);
      let response;
      try {
        response = (await this.http.follow(url)).final;
      } catch (cause) {
        firstCause ??= cause;
        unreachable += 1;
        attempts.push(`${url} \u2192 ${cause.message}`);
        this.logger.debug("login.entry_unreachable", {
          url,
          error: cause.message
        });
        continue;
      }
      if (response.status >= 400) {
        attempts.push(`${url} \u2192 HTTP ${response.status}`);
        this.logger.debug("login.entry_missing", {
          url,
          status: response.status
        });
        continue;
      }
      this.logger.debug("login.entry", {
        url,
        landedOn: response.url,
        status: response.status
      });
      return response;
    }
    if (unreachable === ENTRY_PATHS.length) {
      throw new FskintraAuthError(`Could not reach https://${hostname}. Check the hostname and your connection.`, {
        cause: firstCause
      });
    }
    throw new FskintraAuthError(`No For\xE6ldreIntra login page on https://${hostname}. Tried:
  ${attempts.join("\n  ")}`, firstCause ? {
      cause: firstCause
    } : void 0);
  }
  /**
   * Is this the logged-in front page? By URL shape first, by the child links
   * it carries second. Used by `resume`, where either signal is enough to
   * trust a restored session.
   */
  isFrontPage(doc, url) {
    if (INDEX_RE.test(url.pathname)) return true;
    return this.hasChildLinks(doc);
  }
  /** Does the page carry at least one child link? The content-only test. */
  hasChildLinks(doc) {
    return doc("a[href]").toArray().some((el) => isChildLink(doc(el).attr("href")));
  }
  /**
   * Retry a dead landing at the site root — first on the host we ended up on,
   * then on the one the user typed, since the flow can change hosts. Each
   * candidate is tried at most once per login, so a root that is itself a dead
   * end fails the login instead of looping on it.
   */
  async followLandingFallback(from, hostname, tried) {
    const candidates = [
      new URL(LANDING_FALLBACK, from.url).toString(),
      this.absUrl(hostname, LANDING_FALLBACK)
    ];
    for (const candidate of candidates) {
      if (tried.has(candidate)) continue;
      tried.add(candidate);
      this.logger.debug("login.landing_fallback", {
        from: from.url,
        status: from.status,
        to: candidate
      });
      try {
        return (await this.http.follow(candidate)).final;
      } catch (error) {
        this.logger.debug("login.landing_fallback_failed", {
          to: candidate,
          error: error.message
        });
      }
    }
    return void 0;
  }
  async submitCredentials(doc, currentUrl, credentials) {
    const pageText = textOf(doc, doc("body")).toLowerCase();
    if (pageText.includes("ikke adgang") || pageText.includes("forkert brugernavn")) {
      throw new InvalidCredentialsError("For\xE6ldreIntra rejected the credentials. Check the username and password.");
    }
    const form = findFormWithField(doc, "UserName", "Username", "username");
    if (!form) {
      if (doc('a[href*="RedirectToUniLogin"]').length) {
        throw new UniLoginNotSupportedError(new URL(currentUrl).hostname);
      }
      throw new FskintraAuthError(`No ordinary login form at ${currentUrl}. The page layout may have changed, or JavaScript-based login protection is active.`);
    }
    const userField = form.find('[name="UserName"], [name="Username"], [name="username"]').attr("name") ?? "UserName";
    const passField = form.find('[name="Password"], [name="password"]').attr("name") ?? "Password";
    const spec = serializeForm(doc, form, {
      [userField]: credentials.username,
      [passField]: credentials.password
    });
    this.logger.debug("login.submit_credentials", {
      action: spec.action || currentUrl
    });
    return (await this.http.follow(new URL(spec.action || currentUrl, currentUrl).toString(), {
      method: "POST",
      body: spec.fields
    })).final;
  }
  /**
   * The "Bekræft kontaktoplysninger" interstitial. fskintra clicks it
   * automatically; we don't, unless asked. Confirming tells the school the
   * details on file are correct, which is a statement the user should make,
   * not their MCP server.
   */
  async handleConfirmContacts(doc, currentUrl) {
    const form = doc(".sk-l-content-wrapper form, form").filter((_, el) => /Confirm\/?$/i.test(doc(el).attr("action") ?? "")).first();
    const pageText = textOf(doc, doc(".sk-l-content-wrapper").first()) || textOf(doc, doc("body"));
    if (!form.length) {
      throw new ConfirmContactsRequiredError(currentUrl, pageText.slice(0, 2e3));
    }
    if (!this.autoConfirmContacts) {
      throw new ConfirmContactsRequiredError(currentUrl, pageText.slice(0, 2e3));
    }
    const spec = serializeForm(doc, form);
    this.logger.warn("login.auto_confirming_contacts", {
      url: currentUrl
    });
    return (await this.http.follow(new URL(spec.action, currentUrl).toString(), {
      method: "POST",
      body: spec.fields
    })).final;
  }
  /**
   * SSO relay pages carry exactly one form that a browser would auto-submit
   * via JavaScript.
   *
   * `explicit` marks the two shapes fskintra actually observed — a form named
   * `relay`, or a page under `/sso/ssocomplete`. Those are safe to submit
   * before anything else. A lone unnamed form is the general case and is only
   * tried once the known branches have been ruled out, because the login page
   * is also a lone form.
   */
  findRelayForm(doc, url) {
    const forms = doc("form");
    if (forms.length !== 1) return void 0;
    const form = forms.first();
    const explicit = url.pathname.toLowerCase().includes("/sso/ssocomplete") || (form.attr("name") ?? "").toLowerCase() === "relay";
    return {
      ...serializeForm(doc, form),
      explicit
    };
  }
};

// supabase/functions/foraeldre-api/fskintra/auth/session-store.ts
import { Buffer as Buffer4 } from "node:buffer";
import { chmod, mkdir as mkdir2, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname as dirname2, join } from "node:path";
var MemorySessionStore = class {
  record;
  async load() {
    return this.record;
  }
  async save(record) {
    this.record = record;
  }
  async clear() {
    this.record = void 0;
  }
};

// supabase/functions/foraeldre-api/fskintra/client/errors.ts
var FskintraClientError = class extends FskintraAuthError {
  name = "FskintraClientError";
};
var SectionUnavailableError = class extends FskintraClientError {
  section;
  name;
  constructor(section, message2) {
    super(message2 ?? `This school does not use ${section}, or your account has no access to it.`), this.section = section, this.name = "SectionUnavailableError";
  }
};
var SectionParseError = class extends FskintraClientError {
  section;
  url;
  name;
  constructor(section, url, detail) {
    super(`Could not parse ${section} at ${url}: ${detail}`), this.section = section, this.url = url, this.name = "SectionParseError";
  }
};
var SessionExpiredError = class extends FskintraClientError {
  url;
  name;
  constructor(url) {
    super(`The For\xE6ldreIntra session expired while fetching ${url}.`), this.url = url, this.name = "SessionExpiredError";
  }
};

// supabase/functions/foraeldre-api/fskintra/client/client.ts
function credentialsFromEnv() {
  const hostname = process.env.FSKINTRA_HOSTNAME?.trim();
  const username = process.env.FSKINTRA_USERNAME?.trim();
  const password = process.env.FSKINTRA_PASSWORD;
  if (!hostname || !username || !password) return void 0;
  return {
    hostname: normalizeHostname(hostname),
    username,
    password
  };
}
var LOGIN_PATH_RE = /\/Account\/(IdpLogin|Login)/i;
var FskintraClient = class {
  http;
  store;
  /** Public so section modules can record swallowed, non-fatal failures. */
  logger;
  login;
  overrideCredentials;
  record;
  indexDoc;
  indexUrl;
  children;
  /** Shared across concurrent callers so a re-login fires once. */
  authPromise;
  constructor(options = {}) {
    this.logger = options.logger ?? silentLogger;
    this.store = options.store ?? new MemorySessionStore();
    this.http = new FskintraHttpClient({
      logger: this.logger,
      ...options.tracer ? {
        tracer: options.tracer
      } : {}
    });
    this.login = new FskintraLoginClient({
      http: this.http,
      logger: this.logger,
      autoConfirmContacts: options.autoConfirmContacts ?? false
    });
    this.overrideCredentials = options.credentials;
  }
  /** The hostname this client is talking to, once authenticated. */
  get hostname() {
    return this.record?.hostname;
  }
  get username() {
    return this.record?.username;
  }
  /** Unix epoch seconds of the last time the session was confirmed live. */
  get verifiedAt() {
    return this.record?.verified_at;
  }
  absUrl(url) {
    if (/^https?:\/\//i.test(url)) return url;
    const hostname = this.record?.hostname;
    if (!hostname) throw new NotLoggedInError();
    return `https://${hostname}${url.startsWith("/") ? "" : "/"}${url}`;
  }
  /**
   * Ensure we have a live session. Resumes from stored cookies when possible;
   * falls back to a full login. Concurrent callers share one attempt.
   */
  async authenticate(force = false) {
    if (this.indexDoc && !force) return;
    if (!this.authPromise) {
      this.authPromise = this.doAuthenticate(force).finally(() => {
        this.authPromise = void 0;
      });
    }
    return this.authPromise;
  }
  async doAuthenticate(force) {
    let record;
    if (!this.overrideCredentials) {
      this.record ??= await this.store.load();
      record = this.record;
    }
    const credentials = this.overrideCredentials ?? (record?.password ? {
      hostname: record.hostname,
      username: record.username,
      password: record.password
    } : credentialsFromEnv());
    if (!force && record?.cookies && record.indexUrl) {
      const resumed = await this.login.resume(record);
      if (resumed) {
        this.logger.info("client.session_resumed", {
          indexUrl: resumed.indexUrl
        });
        this.indexDoc = resumed.doc;
        this.indexUrl = resumed.indexUrl;
        this.children = void 0;
        await this.persist({
          ...record,
          cookies: resumed.cookies,
          indexUrl: resumed.indexUrl
        });
        return;
      }
    }
    if (!credentials) {
      throw new NotLoggedInError(record ? "The stored For\xE6ldreIntra session expired and no password was saved. Run `fskintra login` again." : "No For\xE6ldreIntra session. Run `fskintra login`, or set FSKINTRA_HOSTNAME, FSKINTRA_USERNAME and FSKINTRA_PASSWORD.");
    }
    this.http.resetJar();
    const result = await this.login.login(credentials);
    this.indexDoc = result.doc;
    this.indexUrl = result.indexUrl;
    this.children = void 0;
    await this.persist({
      version: 1,
      hostname: normalizeHostname(credentials.hostname),
      username: credentials.username,
      // Only carry the password forward if it was already being stored (or the
      // caller supplied it explicitly). We never start storing it on our own.
      ...record?.password || this.overrideCredentials ? {
        password: credentials.password
      } : {},
      ...record?.meta ? {
        meta: record.meta
      } : {},
      cookies: result.cookies,
      indexUrl: result.indexUrl,
      saved_at: 0
    });
  }
  async persist(next) {
    const now = Math.floor(Date.now() / 1e3);
    this.record = {
      ...next,
      saved_at: now,
      verified_at: now
    };
    try {
      await this.store.save(this.record);
    } catch (error) {
      this.logger.warn("client.session_persist_failed", {
        error: error.message
      });
    }
  }
  /** Forget the cached session in this process. Does not touch the store. */
  invalidate() {
    this.indexDoc = void 0;
    this.indexUrl = void 0;
    this.children = void 0;
  }
  /** The logged-in front page. */
  async getIndexDoc(force = false) {
    await this.authenticate(force);
    if (!this.indexDoc) throw new NotLoggedInError();
    return this.indexDoc;
  }
  /**
   * Fetch a page as the logged-in parent.
   *
   * Retries once through a full re-login when the response is really the login
   * screen. ForældreIntra returns 200 for that, so a status check alone would
   * hand the caller a page of navigation chrome and call it success.
   */
  async fetchPage(url, options = {}) {
    const body = await this.fetchRaw(url, options);
    return parse(body);
  }
  /** Same retry semantics as `fetchPage`, but returns the raw body. */
  async fetchRaw(url, options = {}) {
    await this.authenticate();
    const target = this.absUrl(url);
    let response = await this.http.follow(target, {
      ...options.method ? {
        method: options.method
      } : {},
      ...options.body ? {
        body: options.body
      } : {}
    });
    if (isLoginResponse(response.final.url, response.final.status)) {
      this.logger.info("client.session_expired_retrying", {
        url: target
      });
      this.invalidate();
      await this.authenticate(true);
      response = await this.http.follow(target, {
        ...options.method ? {
          method: options.method
        } : {},
        ...options.body ? {
          body: options.body
        } : {}
      });
      if (isLoginResponse(response.final.url, response.final.status)) {
        throw new SessionExpiredError(target);
      }
    }
    return response.final.body;
  }
  /**
   * Fetch and JSON-parse an endpoint (the conversations UI serves several).
   *
   * `fetchRaw` has already ruled out the login-page case, so a body that will
   * not parse means the endpoint changed shape — a parser bug, not an auth
   * problem, and it should be reported as one.
   */
  async fetchJson(url) {
    const target = this.absUrl(url);
    const body = await this.fetchRaw(url);
    try {
      return JSON.parse(body);
    } catch {
      throw new FskintraClientError(`Expected JSON from ${target} but got ${body.length} bytes starting with ${JSON.stringify(body.slice(0, 60))}.`);
    }
  }
  /** Download an attachment or document with the session's cookies. */
  async download(url) {
    await this.authenticate();
    return this.http.requestBinary(this.absUrl(url));
  }
  // ------------------------------------------------------------- children ---
  async getChildren(force = false) {
    if (this.children && !force) return this.children;
    const doc = await this.getIndexDoc(force);
    this.children = parseChildren(doc, (url) => this.absUrl(url));
    this.logger.info("client.children_found", {
      count: this.children.length,
      names: this.children.map((c) => c.name)
    });
    return this.children;
  }
  /**
   * Resolve a child by name (case-insensitive, prefix then substring) or id.
   * With no argument, returns the only child — or fails listing the options,
   * which is what an agent needs to ask a useful follow-up question.
   */
  async resolveChild(nameOrId) {
    const all = await this.getChildren();
    if (all.length === 0) {
      throw new Error("No children found on the For\xE6ldreIntra front page.");
    }
    if (!nameOrId) {
      if (all.length === 1) return all[0];
      throw new Error(`More than one child on this account; specify one of: ${all.map((c) => c.name).join(", ")}`);
    }
    const needle = nameOrId.trim().toLowerCase();
    const match = all.find((c) => c.id === needle || c.name.toLowerCase() === needle) ?? all.find((c) => c.name.toLowerCase().startsWith(needle)) ?? all.find((c) => c.name.toLowerCase().includes(needle));
    if (!match) {
      throw new Error(`No child matching ${JSON.stringify(nameOrId)}. Known: ${all.map((c) => c.name).join(", ")}`);
    }
    return match;
  }
};
function childUrl(child, suffix) {
  if (!suffix.startsWith("/") && !suffix.startsWith("item/")) {
    throw new Error(`childUrl suffix must start with "/" or "item/": ${suffix}`);
  }
  return child.urlPrefix + suffix;
}
function parseChildren(doc, absUrl) {
  const selectedName = doc("#sk-personal-menu-button").first().text().replace(/\s+/g, " ").trim();
  const byPrefix = /* @__PURE__ */ new Map();
  doc("a[href]").each((_, el) => {
    const href = doc(el).attr("href");
    if (!href || !isChildLink(href)) return;
    const urlPrefix = absUrl(href.replace(/\/Index\/?(?:[?#][\s\S]*)?$/i, ""));
    if (byPrefix.has(urlPrefix)) return;
    const name = doc(el).text().replace(/\s+/g, " ").trim() || selectedName;
    if (!name) return;
    byPrefix.set(urlPrefix, {
      name,
      id: new URL(urlPrefix).pathname.split("/")[2] ?? "",
      urlPrefix
    });
  });
  return [
    ...byPrefix.values()
  ].sort((a, b) => a.name.localeCompare(b.name, "da"));
}
function isLoginResponse(url, status) {
  if (status === 401) return true;
  try {
    return LOGIN_PATH_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// supabase/functions/foraeldre-api/fskintra/client/sections/news.ts
async function getFrontpage(client, child, options = {}) {
  const doc = await client.fetchPage(childUrl(child, "/Index"));
  const frontpage = parseFrontpage(doc, child.name, (url) => client.absUrl(url));
  if (options.includeComments) {
    for (const item of frontpage.news) {
      if (item.commentCount > 0 && item.id) {
        item.comments = await getComments(client, child, item.id, item.commentCount);
      }
    }
  }
  return frontpage;
}
function parseFrontpage(doc, childName, absUrl) {
  const reminders = [];
  doc("ul.sk-reminders-container > li").each((_, li) => {
    const text = clean(doc(li).text());
    if (text && !/der er aktiviteter i dag/i.test(text)) reminders.push(text);
  });
  const news = doc("div.sk-news-item").toArray().map((el) => parseNewsItem(doc, el, absUrl));
  return {
    child: childName,
    reminders,
    news
  };
}
function parseNewsItem(doc, el, absUrl) {
  const item = doc(el);
  const content = item.find("div.sk-news-item-content").first().clone();
  content.find(".sk-attachments-list, .sk-news-item-comments").remove();
  const body = textOf(doc, content);
  const author = item.find("div.sk-news-item-author").first();
  const authorName = clean(author.find("span").first().text());
  const recipientLine = author.clone();
  recipientLine.find("span").first().remove();
  recipientLine.find(".sk-news-item-for, a.sk-news-show-more-link").remove();
  recipientLine.find(".sk-news-item-and").replaceWith(", ");
  const recipients = clean(recipientLine.text()).split(/\s*(?:,|\bog\b)\s*/).map((r) => r.trim()).filter(Boolean);
  const dateText = (clean(item.find("div.sk-news-item-timestamp").text()).split(/\(?\s*opdateret/i)[0] ?? "").trim();
  const attachments = [];
  item.find("div.sk-attachments-list a[href]").each((_, a) => {
    const href = doc(a).attr("href");
    if (href) attachments.push({
      name: clean(doc(a).text()),
      url: absUrl(href)
    });
  });
  const commentsBlock = item.find("div.sk-news-item-comments");
  const commentCount = Number(/vis (\d+) kommentar/i.exec(clean(commentsBlock.text()))?.[1] ?? 0);
  const date = parseDanishDateTime(dateText);
  return {
    id: item.attr("data-feed-item-id") ?? "",
    title: (body.split("\n")[0] ?? "").replace(/[ .]+$/, "").trim(),
    author: authorName,
    recipients,
    ...date ? {
      date
    } : {},
    dateText,
    body,
    attachments,
    commentCount
  };
}
async function getComments(client, child, itemId, count) {
  const doc = await client.fetchPage(childUrl(child, `/news/pins/${itemId}/comments`), {
    method: "POST",
    body: new URLSearchParams({
      _: String(count)
    })
  });
  const comments = [];
  doc(".sk-comments-container .sk-comment, .sk-comments-container li").each((_, el) => {
    const text = textOf(doc, doc(el));
    if (text) comments.push(text);
  });
  if (comments.length === 0) {
    const all = textOf(doc, doc(".sk-comments-container"));
    if (all) comments.push(all);
  }
  return comments;
}

// supabase/functions/foraeldre-api/fskintra/client/sections/messages.ts
var uiCache = /* @__PURE__ */ new WeakMap();
async function detectMessageUi(client) {
  const cached = uiCache.get(client);
  if (cached) return cached;
  const doc = await client.getIndexDoc();
  let found;
  doc("a[href]").each((_, a) => {
    if (found) return false;
    if (!/besked/i.test(clean(doc(a).text()))) return void 0;
    const href = doc(a).attr("href");
    const last = href?.replace(/\/$/, "").split("/").pop();
    if (last === "conversations" || last === "inbox") found = last;
    return void 0;
  });
  const ui = found ?? "conversations";
  uiCache.set(client, ui);
  return ui;
}
async function listConversations(client, child) {
  const ui = await detectMessageUi(client);
  return ui === "conversations" ? listFromConversations(client, child) : listFromTrays(client, child);
}
async function listFromConversations(client, child) {
  const url = childUrl(child, "/messages/conversations");
  const doc = await client.fetchPage(url);
  const conversations = findConversationsJson(doc);
  if (!conversations) {
    throw new SectionParseError("messages", url, 'no conversation JSON on the page (looked for a data attribute containing "message")');
  }
  return conversations.filter((c) => c.LatestMessageId).map((c) => ({
    threadId: c.ThreadId ?? "",
    latestMessageId: String(c.LatestMessageId),
    subject: clean(c.Subject) || "(uden emne)",
    sender: clean(c.SenderName),
    dateText: clean(c.SentReceivedDateText),
    unread: c.ShowUnreadIndication === true
  }));
}
function findConversationsJson(doc) {
  let result;
  doc(".sk-l-content-wrapper div").each((_, el) => {
    if (result) return false;
    for (const [name, value] of Object.entries(el.attribs ?? {})) {
      if (!name.toLowerCase().includes("message") || value.length < 100) continue;
      try {
        const parsed = JSON.parse(value);
        if (parsed && Array.isArray(parsed.Conversations)) {
          result = parsed.Conversations;
          return false;
        }
      } catch {
      }
    }
    return void 0;
  });
  return result;
}
async function listFromTrays(client, child) {
  const out = [];
  for (const tray of [
    "inbox",
    "outbox"
  ]) {
    const doc = await client.fetchPage(childUrl(child, `/messages/${tray}`));
    doc(".sk-message-list-item").each((_, el) => {
      const item = doc(el);
      const href = item.find("a[href]").first().attr("href") ?? "";
      const id = /\/message\/(\d+)/.exec(href)?.[1];
      if (!id) return;
      const sender = clean(item.find(".sk-message-senderrecipient-name").first().text()).replace(/\s*\(.*\)$/, "");
      out.push({
        threadId: "",
        latestMessageId: id,
        subject: clean(item.find(".sk-message-title").first().text()) || "(uden emne)",
        sender,
        dateText: clean(item.find(".sk-message-send-date").first().text()),
        unread: item.hasClass("sk-message-unread") || item.find(".sk-unread").length > 0
      });
    });
  }
  return out;
}

// supabase/functions/foraeldre-api/fskintra/client/sections/weekplans.ts
function assertAuthorized(doc, section) {
  if (/ikke autoriseret/i.test(doc("body").text())) {
    throw new SectionUnavailableError(section);
  }
}

// supabase/functions/foraeldre-api/fskintra/client/sections/homework.ts
async function getHomework(client, child) {
  const doc = await client.fetchPage(childUrl(child, "item/weeklyplansandhomework/diary/"));
  const columns = doc("li.ccl-rwgm-column-1-2.sk-grid-priority-column");
  if (!columns.length) {
    assertAuthorized(doc, "lektier (homework)");
    return [];
  }
  const classUrls = /* @__PURE__ */ new Set();
  columns.find("a[href]").each((_, a) => {
    const href = doc(a).attr("href");
    if (href) classUrls.add(client.absUrl(href));
  });
  const result = [];
  for (const classUrl of classUrls) {
    const classDoc = await client.fetchPage(classUrl);
    const viewAll = classDoc("a#sk-diary-notes-view-all[href]").first().attr("href");
    if (!viewAll) continue;
    const url = `${client.absUrl(viewAll)}/NextMonth`;
    const notes = await client.fetchPage(url);
    const groups = [];
    notes("ul.sk-list > li").each((_, li) => {
      const item = notes(li);
      const due = clean(item.find("div.sk-white-box > b").first().text());
      if (!due) return;
      const entries = [];
      item.find("table tbody tr").each((__, tr) => {
        const cells = notes(tr).children("td, th");
        if (cells.length < 2) return;
        const subject = clean(cells.eq(0).text());
        const text = textOf(notes, cells.eq(1));
        if (subject && text) entries.push({
          subject,
          text
        });
      });
      if (entries.length) groups.push({
        due,
        entries
      });
    });
    if (groups.length) {
      result.push({
        title: clean(classDoc("h3").first().text()),
        url,
        groups
      });
    }
  }
  return result;
}

// supabase/functions/foraeldre-api/foraeldreintra.ts
var SOURCE = "for\xE6ldreintra";
var DbStore = class {
  async load() {
    return await getCredential(SOURCE);
  }
  async save(record) {
    await setCredential(SOURCE, record);
  }
  async clear() {
    const rec = await this.load();
    if (rec) await setCredential(SOURCE, {
      ...rec,
      cookies: void 0,
      indexUrl: void 0
    });
  }
};
function explain(e) {
  if (e instanceof UniLoginNotSupportedError) {
    throw new NeedsLoginError("Skolen sender login videre til UniLogin. Det underst\xF8ttes ikke \u2013 der skal bruges skolens eget for\xE6ldrelogin.");
  }
  if (e instanceof InvalidCredentialsError) {
    throw new NeedsLoginError("For\xE6ldreIntra afviser brugernavn eller adgangskode.");
  }
  if (e instanceof ConfirmContactsRequiredError) {
    throw new NeedsLoginError("For\xE6ldreIntra vil have jer til at bekr\xE6fte kontaktoplysninger. Log ind \xE9n gang p\xE5 skolens side og bekr\xE6ft dem.");
  }
  throw e;
}
async function connect(hostname, username, password) {
  const client = new FskintraClient({
    store: new DbStore(),
    credentials: {
      hostname,
      username,
      password
    }
  });
  try {
    await client.authenticate(true);
    const kids = await client.getChildren(true);
    return kids.map((k) => k.name);
  } catch (e) {
    explain(e);
  }
}
async function isConnected2() {
  return !!await getCredential(SOURCE);
}
async function syncForaeldreIntra() {
  const client = new FskintraClient({
    store: new DbStore()
  });
  const items = [];
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
        kind: "opslag",
        child: name,
        title: n.title || "(opslag)",
        body: n.body.length > 1500 ? n.body.slice(0, 1500) + "\u2026" : n.body,
        sender: n.author || null,
        published_at: n.date ? new Date(n.date).toISOString() : null,
        url: base,
        hashParts: [
          n.title,
          n.body.slice(0, 500)
        ]
      });
    }
    for (const r of front.reminders) {
      items.push({
        id: `${SOURCE}:p\xE5mindelse:${child.id}:${(await sha256Hex(r)).slice(0, 16)}`,
        source: SOURCE,
        kind: "p\xE5mindelse",
        child: name,
        title: r.length > 120 ? r.slice(0, 117) + "\u2026" : r,
        body: r.length > 120 ? r : null,
        url: base,
        hashParts: [
          r
        ]
      });
    }
    try {
      for (const c of await listConversations(client, child)) {
        items.push({
          id: `${SOURCE}:besked:${c.threadId}`,
          source: SOURCE,
          kind: "besked",
          child: name,
          title: c.subject || "(uden emne)",
          sender: c.sender || null,
          body: c.dateText ? `Sendt ${c.dateText}` : null,
          important: c.unread,
          url: base,
          hashParts: [
            c.latestMessageId
          ]
        });
      }
    } catch (e) {
      client.logger.warn("fi.messages_failed", {
        error: String(e)
      });
    }
    try {
      for (const hw of await getHomework(client, child)) {
        for (const g of hw.groups) {
          const body = g.entries.map((x) => `${x.subject}: ${x.text}`).join("\n");
          if (!body) continue;
          items.push({
            id: `${SOURCE}:lektier:${child.id}:${(await sha256Hex(g.due)).slice(0, 12)}`,
            source: SOURCE,
            kind: "lektier",
            child: name,
            title: `Lektier til ${g.due}`,
            body,
            url: base,
            hashParts: [
              body
            ]
          });
        }
      }
    } catch (e) {
      client.logger.warn("fi.homework_failed", {
        error: String(e)
      });
    }
  }
  return {
    items,
    children: kids.map((k) => k.name.split(/\s+/)[0])
  };
}

// supabase/functions/foraeldre-api/holdsport.ts
var API = "https://api.holdsport.dk/v1";
async function call(login, path) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      accept: "application/json",
      authorization: "Basic " + btoa(unescape(encodeURIComponent(`${login.username}:${login.password}`)))
    }
  });
  if (res.status === 401) {
    await res.body?.cancel();
    throw new NeedsLoginError(`Holdsport afviser login for ${login.child}. Tjek brugernavn og adgangskode.`);
  }
  if (!res.ok) throw new Error(`Holdsport ${res.status} p\xE5 ${path}`);
  return await res.json();
}
async function testLogin(login) {
  const teams = await call(login, "/teams");
  return teams.map((t) => t.name);
}
async function syncHoldsport() {
  const items = [];
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  for (const source of await listCredentialSources("holdsport:")) {
    const login = await getCredential(source);
    if (!login) continue;
    const teams = await call(login, "/teams");
    for (const team of teams) {
      const acts = await call(login, `/teams/${team.id}/activities?date=${today}&per_page=40`);
      for (const a of acts) {
        const details = [
          a.place && `Sted: ${a.place}`,
          a.pickup_time && `M\xF8detid: ${fmtTime(a.pickup_time)}${a.pickup_place ? ` (${a.pickup_place})` : ""}`,
          a.status && `Status: ${a.status}`,
          a.comment
        ].filter(Boolean);
        items.push({
          id: `holdsport:aktivitet:${a.id}`,
          source: "holdsport",
          kind: "aktivitet",
          child: login.child,
          title: a.name || "Aktivitet",
          sender: team.name,
          body: details.join("\n") || null,
          starts_at: a.starttime || null,
          ends_at: a.endtime || null,
          url: "https://www.holdsport.dk/",
          // Tilmeldingsstatus er udeladt: den ændrer man selv, det skal ikke give besked.
          hashParts: [
            a.name,
            a.starttime,
            a.endtime,
            a.place,
            a.pickup_time,
            a.comment
          ]
        });
      }
    }
  }
  return items;
}
function fmtTime(v) {
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  return d.toLocaleTimeString("da-DK", {
    timeZone: "Europe/Copenhagen",
    hour: "2-digit",
    minute: "2-digit"
  });
}

// supabase/functions/foraeldre-api/push.ts
import webpush from "npm:web-push@3.6.7";
var SUBJECT = "https://nikolajbak.github.io/foraeldreoversigt/";
async function vapidPublicKey() {
  return (await vapid()).publicKey;
}
async function vapid() {
  let keys = await getConfig("vapid");
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    await setConfig("vapid", keys);
  }
  return keys;
}
async function subscribe(sub, device) {
  const host = new URL(sub.endpoint).hostname;
  const allowed = [
    "web.push.apple.com",
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com"
  ];
  if (!allowed.some((h) => host === h || host.endsWith("." + h) || host.endsWith(".notify.windows.com"))) {
    throw new Error("Ukendt push-tjeneste");
  }
  await sql`
    insert into foraeldre.push_subscriptions (endpoint, keys, device)
    values (${sub.endpoint}, ${sql.json(sub.keys)}, ${device ?? null})
    on conflict (endpoint) do update set keys = excluded.keys, device = excluded.device`;
}
async function unsubscribe(endpoint) {
  await sql`delete from foraeldre.push_subscriptions where endpoint = ${endpoint}`;
}
async function sendToAll(msg, itemId) {
  const keys = await vapid();
  webpush.setVapidDetails(SUBJECT, keys.publicKey, keys.privateKey);
  const subs = await sql`select endpoint, keys from foraeldre.push_subscriptions`;
  let delivered = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({
        endpoint: s.endpoint,
        keys: s.keys
      }, JSON.stringify(msg), {
        TTL: 6 * 3600,
        urgency: "normal"
      });
      delivered++;
      await sql`update foraeldre.push_subscriptions set last_ok = now() where endpoint = ${s.endpoint}`;
    } catch (e) {
      const code = e.statusCode;
      if (code === 404 || code === 410) await unsubscribe(s.endpoint);
      else console.error("push fejlede", code, String(e).slice(0, 200));
    }
  }
  await sql`
    insert into foraeldre.notifications (item_id, title, body, delivered)
    values (${itemId ?? null}, ${msg.title}, ${msg.body}, ${delivered})`;
  return delivered;
}

// supabase/functions/foraeldre-api/sync.ts
var LABEL = {
  aula: "Aula",
  holdsport: "Holdsport",
  "for\xE6ldreintra": "For\xE6ldreIntra"
};
var hashOf = (i) => sha256Hex(JSON.stringify(i.hashParts));
async function takeLock() {
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
async function runSync() {
  if (!await takeLock()) return {
    l\u00E5s: {
      ok: false,
      spring: "En anden synkronisering k\xF8rer allerede"
    }
  };
  const report = {};
  const pending = [];
  try {
    const jobs = [
      [
        "aula",
        async () => await isConnected() ? await syncAula(await knownHashes("aula"), hashOf) : null
      ],
      [
        "holdsport",
        async () => (await listCredentialSources("holdsport:")).length ? {
          items: await syncHoldsport()
        } : null
      ],
      [
        "for\xE6ldreintra",
        async () => await isConnected2() ? await syncForaeldreIntra() : null
      ]
    ];
    for (const [source, job] of jobs) {
      const before = await getStatus(source);
      try {
        const result = await job();
        if (!result) {
          report[source] = {
            ok: true,
            spring: "ikke forbundet"
          };
          continue;
        }
        if (result.children) await rememberChildren(result.children);
        const { nye, \u00E6ndrede } = await store(source, result.items);
        const baseline = before?.baseline_done ?? false;
        await setStatus(source, {
          ok: true,
          baseline_done: true
        });
        report[source] = {
          ok: true,
          items: result.items.length,
          nye: nye.length,
          \u00E6ndrede: \u00E6ndrede.length
        };
        if (baseline) {
          for (const item of nye) if (worthNotifying(item, "ny")) pending.push({
            item,
            change: "ny"
          });
          for (const item of \u00E6ndrede) if (worthNotifying(item, "\xE6ndret")) pending.push({
            item,
            change: "\xE6ndret"
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(source, e);
        if (e instanceof NeedsLoginError) {
          await setStatus(source, {
            ok: false,
            message: msg,
            needs_login: true
          });
          if (!before?.needs_login) {
            await sendToAll({
              title: `${LABEL[source]} skal logges ind igen`,
              body: msg,
              tag: `login-${source}`,
              url: "./#indstillinger"
            });
          }
        } else {
          await setStatus(source, {
            ok: false,
            message: msg.slice(0, 300)
          });
        }
        report[source] = {
          ok: false,
          fejl: msg.slice(0, 300)
        };
      }
    }
    await notify(pending);
    await sql`select foraeldre.oprydning()`;
  } finally {
    await releaseLock();
  }
  return report;
}
async function knownHashes(source) {
  const rows = await sql`select id, hash from foraeldre.items where source = ${source}`;
  return new Map(rows.map((r) => [
    r.id,
    r.hash
  ]));
}
async function store(source, items) {
  const known = await knownHashes(source);
  const nye = [];
  const \u00E6ndrede = [];
  const seen = /* @__PURE__ */ new Set();
  for (const i of items) {
    if (seen.has(i.id)) continue;
    seen.add(i.id);
    const hash = await hashOf(i);
    const prev = known.get(i.id);
    if (prev === void 0) nye.push(i);
    else if (prev !== hash) \u00E6ndrede.push(i);
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
  const ids = [
    ...seen
  ];
  await sql`
    update foraeldre.items set seen_in_last_sync = false
     where source = ${source} and not (id = any(${ids}))`;
  return {
    nye,
    \u00E6ndrede
  };
}
function worthNotifying(i, change) {
  const now = Date.now();
  const age = i.published_at ? now - Date.parse(i.published_at) : 0;
  switch (i.kind) {
    case "besked":
      return age < 7 * 864e5;
    case "opslag":
    case "p\xE5mindelse":
    case "lektier":
      return change === "ny" && age < 7 * 864e5;
    case "begivenhed":
    case "aktivitet":
      if (!i.starts_at || Date.parse(i.starts_at) < now) return false;
      return change === "ny" || Date.parse(i.starts_at) - now < 14 * 864e5;
  }
}
function fmtWhen(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("da-DK", {
    timeZone: "Europe/Copenhagen",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}
function message(i, change) {
  const who = i.child ? `${i.child} \xB7 ` : "";
  const src = LABEL[i.source];
  const titles = {
    besked: change === "ny" ? "Ny besked" : "Nyt svar",
    opslag: "Nyt opslag",
    p\u00E5mindelse: "P\xE5mindelse",
    lektier: "Nye lektier",
    begivenhed: change === "ny" ? "Ny begivenhed" : "\xC6ndret begivenhed",
    aktivitet: change === "ny" ? "Ny aktivitet" : "\xC6ndret aktivitet"
  };
  const lines = [
    i.title,
    i.starts_at ? fmtWhen(i.starts_at) : i.sender ?? "",
    (i.body ?? "").split("\n")[0].slice(0, 140)
  ].filter(Boolean);
  return {
    title: `${who}${titles[i.kind]} (${src})`,
    body: lines.join("\n"),
    tag: i.id,
    url: `./#item=${encodeURIComponent(i.id)}`
  };
}
async function notify(pending) {
  if (!pending.length) return;
  if (pending.length > 5) {
    const sources = [
      ...new Set(pending.map((p) => LABEL[p.item.source]))
    ].join(", ");
    await sendToAll({
      title: `${pending.length} nye ting om b\xF8rnene`,
      body: `Fra ${sources}. \xC5bn oversigten for at se dem.`,
      tag: "samlet",
      url: "./"
    });
    return;
  }
  for (const { item, change } of pending) await sendToAll(message(item, change), item.id);
}

// supabase/functions/foraeldre-api/index.ts
var ORIGINS = [
  "https://nikolajbak.github.io"
];
function cors(req) {
  const o = req.headers.get("origin") ?? "";
  const ok = ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return {
    "access-control-allow-origin": ok ? o : ORIGINS[0],
    "access-control-allow-headers": "content-type, x-familiekode",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    vary: "origin"
  };
}
var HttpError = class extends Error {
  status;
  constructor(status, message2) {
    super(message2), this.status = status;
  }
};
async function codeHash(code, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(code), "PBKDF2", false, [
    "deriveBits"
  ]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: new TextEncoder().encode(salt),
    iterations: 1e5
  }, key, 256);
  return [
    ...new Uint8Array(bits)
  ].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function requireFamily(req) {
  const fails = await getConfig("auth_fails") ?? {
    n: 0,
    since: Date.now()
  };
  if (fails.n >= 20 && Date.now() - fails.since < 15 * 6e4) {
    throw new HttpError(429, "For mange forkerte fors\xF8g. Vent et kvarter.");
  }
  const stored = await getConfig("family_code");
  const given = req.headers.get("x-familiekode") ?? "";
  if (!stored) throw new HttpError(403, "Appen er ikke sat op endnu.");
  if (!given || !same(await codeHash(given, stored.salt), stored.hash)) {
    const fresh = Date.now() - fails.since > 15 * 6e4;
    await setConfig("auth_fails", fresh ? {
      n: 1,
      since: Date.now()
    } : {
      n: fails.n + 1,
      since: fails.since
    });
    throw new HttpError(401, "Forkert familiekode.");
  }
}
async function isCron(req) {
  const given = req.headers.get("x-cron-secret");
  if (!given) return false;
  const secret = await getConfig("cron_secret");
  return !!secret && same(given, secret);
}
var slug = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9æøå]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "barn";
var background = (p) => EdgeRuntime.waitUntil(p.catch((e) => console.error("baggrundssynk", e)));
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
  return {
    items,
    status,
    children: children.map((c) => c.name),
    hentet: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function settings() {
  const holdsportSources = await listCredentialSources("holdsport:");
  const hs = [];
  for (const s of holdsportSources) {
    const rows = await sql`select data->>'child' child, data->>'username' username from foraeldre.credentials where source = ${s}`;
    hs.push({
      id: s,
      child: rows[0]?.child,
      username: rows[0]?.username
    });
  }
  const fiRow = await sql`select data->>'hostname' hostname, data->>'username' username from foraeldre.credentials where source = 'forældreintra'`;
  const devices = await sql`select count(*)::int n from foraeldre.push_subscriptions`;
  const aulaTok = await sql`select data->>'last_refresh' lr, data->>'obtained_at' ob from foraeldre.credentials where source = 'aula'`;
  return {
    aula: aulaTok.length ? {
      forbundet: true,
      fornyet: Number(aulaTok[0].lr ?? aulaTok[0].ob)
    } : {
      forbundet: false
    },
    holdsport: hs,
    for\u00E6ldreintra: fiRow[0] ?? null,
    enheder: devices[0].n
  };
}
async function route(req, path) {
  const m = req.method;
  const body = m === "POST" ? await req.json().catch(() => ({})) : {};
  if (m === "GET" && path === "/status") {
    return {
      opsat: !!await getConfig("family_code")
    };
  }
  if (m === "POST" && path === "/opsaet") {
    if (await getConfig("family_code")) throw new HttpError(409, "Appen er allerede sat op.");
    const tokenHash = await getConfig("setup_token_hash");
    if (!tokenHash || !same(await sha256Hex(String(body.token ?? "")), tokenHash)) {
      throw new HttpError(403, "Ops\xE6tningslinket er ugyldigt.");
    }
    const code = String(body.kode ?? "");
    if (code.length < 6) throw new HttpError(400, "Familiekoden skal v\xE6re mindst 6 tegn.");
    const salt = crypto.randomUUID();
    await setConfig("family_code", {
      salt,
      hash: await codeHash(code, salt)
    });
    await deleteConfig("setup_token_hash");
    return {
      ok: true
    };
  }
  if (m === "POST" && path === "/sync") {
    if (!await isCron(req)) await requireFamily(req);
    return await runSync();
  }
  await requireFamily(req);
  switch (`${m} ${path}`) {
    case "GET /oversigt":
      return await overview();
    case "GET /indstillinger":
      return await settings();
    case "GET /push/noegle":
      return {
        key: await vapidPublicKey()
      };
    case "POST /push/tilmeld":
      await subscribe(body.subscription, String(body.device ?? "").slice(0, 80));
      return {
        ok: true
      };
    case "POST /push/frameld":
      await unsubscribe(String(body.endpoint ?? ""));
      return {
        ok: true
      };
    case "POST /push/test":
      return {
        leveret: await sendToAll({
          title: "For\xE6ldreoversigt",
          body: "Notifikationer virker \u{1F44D}",
          tag: "test",
          url: "./"
        })
      };
    case "POST /aula/start":
      return {
        url: await startLogin()
      };
    case "POST /aula/afslut":
      await finishLogin(String(body.adresse ?? ""));
      await sql`update foraeldre.source_status set needs_login = false, ok = true, message = null where source = 'aula'`;
      background(runSync());
      return {
        ok: true
      };
    case "POST /aula/frakobl":
      await deleteCredential("aula");
      return {
        ok: true
      };
    case "POST /holdsport": {
      const login = {
        child: String(body.child ?? "").trim(),
        username: String(body.username ?? "").trim(),
        password: String(body.password ?? "")
      };
      if (!login.child || !login.username || !login.password) throw new HttpError(400, "Udfyld barn, brugernavn og adgangskode.");
      const teams = await testLogin(login);
      await setCredential(`holdsport:${slug(login.child)}`, login);
      background(runSync());
      return {
        ok: true,
        hold: teams
      };
    }
    case "POST /holdsport/fjern":
      if (!String(body.id ?? "").startsWith("holdsport:")) throw new HttpError(400, "Ukendt Holdsport-login");
      await deleteCredential(String(body.id));
      await sql`delete from foraeldre.items where source = 'holdsport' and child = ${String(body.child ?? "")}`;
      return {
        ok: true
      };
    case "POST /for\xE6ldreintra":
    case "POST /foraeldreintra": {
      const host = String(body.hostname ?? "").trim();
      const user = String(body.username ?? "").trim();
      const pass = String(body.password ?? "");
      if (!host || !user || !pass) throw new HttpError(400, "Udfyld skolens adresse, brugernavn og adgangskode.");
      const kids = await connect(host, user, pass);
      background(runSync());
      return {
        ok: true,
        b\u00F8rn: kids
      };
    }
    case "POST /foraeldreintra/frakobl":
      await deleteCredential("for\xE6ldreintra");
      return {
        ok: true
      };
  }
  throw new HttpError(404, "Ukendt adresse");
}
Deno.serve(async (req) => {
  const headers = {
    ...cors(req),
    "content-type": "application/json; charset=utf-8"
  };
  if (req.method === "OPTIONS") return new Response(null, {
    headers
  });
  const path = decodeURIComponent(new URL(req.url).pathname).replace(/^.*\/foraeldre-api/, "") || "/";
  try {
    return new Response(JSON.stringify(await route(req, path)), {
      headers
    });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e instanceof NeedsLoginError ? 422 : 500;
    const msg = e instanceof Error ? e.message : String(e);
    if (status === 500) console.error(path, e);
    return new Response(JSON.stringify({
      fejl: msg
    }), {
      status,
      headers
    });
  }
});
