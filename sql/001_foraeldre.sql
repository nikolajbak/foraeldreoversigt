-- Forældreoversigt: eget skema i "Vinted Automation"-projektet.
--
-- Skemaet eksponeres ikke i PostgREST, og anon/authenticated har ingen
-- rettigheder. Kun edge-funktionen foraeldre-api (via SUPABASE_DB_URL) og
-- cron-jobbet rører det. Intet her refererer til andre apps' skemaer.

create schema if not exists foraeldre;
revoke all on schema foraeldre from public, anon, authenticated;

-- Hemmeligheder og indstillinger: familiekode-hash, cron-hemmelighed,
-- VAPID-nøgler, ventende Aula-login (PKCE).
create table foraeldre.config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Login til kilderne. source: 'holdsport:<n>', 'forældreintra', 'aula'.
create table foraeldre.credentials (
  source text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Børnenes navne; bruges til at mærke og filtrere indhold.
create table foraeldre.children (
  id bigint generated always as identity primary key,
  name text not null unique,
  aliases text[] not null default '{}'
);

-- Alt hentet indhold, normaliseret. id = '<kilde>:<type>:<eksternt id>'.
create table foraeldre.items (
  id text primary key,
  source text not null,
  kind text not null,
  child text,
  title text not null,
  body text,
  url text,
  sender text,
  starts_at timestamptz,
  ends_at timestamptz,
  published_at timestamptz,
  important boolean not null default false,
  hash text not null,
  first_seen timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  seen_in_last_sync boolean not null default true
);
create index on foraeldre.items (source, kind);
create index on foraeldre.items (starts_at);
create index on foraeldre.items (published_at desc);

-- Status pr. kilde, så appen kan vise "Log ind i Aula igen" osv.
create table foraeldre.source_status (
  source text primary key,
  ok boolean not null,
  message text,
  needs_login boolean not null default false,
  baseline_done boolean not null default false,
  last_run timestamptz not null default now()
);

create table foraeldre.push_subscriptions (
  endpoint text primary key,
  keys jsonb not null,
  device text,
  created_at timestamptz not null default now(),
  last_ok timestamptz
);

-- Log over sendte notifikationer (til visning og fejlsøgning).
create table foraeldre.notifications (
  id bigint generated always as identity primary key,
  item_id text,
  title text not null,
  body text,
  sent_at timestamptz not null default now(),
  delivered int not null default 0
);

do $$
declare t text;
begin
  foreach t in array array['config','credentials','children','items','source_status','push_subscriptions','notifications'] loop
    execute format('alter table foraeldre.%I enable row level security', t);
    execute format('revoke all on foraeldre.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- Rydder op i gamle notifikationer og forældet indhold.
create or replace function foraeldre.oprydning() returns void
language sql security definer set search_path = '' as $$
  delete from foraeldre.notifications where sent_at < now() - interval '60 days';
  delete from foraeldre.items
   where coalesce(ends_at, starts_at, published_at, updated_at) < now() - interval '120 days';
$$;
revoke all on function foraeldre.oprydning() from public, anon, authenticated;
