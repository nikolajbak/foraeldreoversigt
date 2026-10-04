// Direkte Postgres-forbindelse. Skemaet foraeldre er ikke eksponeret i
// PostgREST, så supabase-js kan ikke nå det — og det er meningen.
import postgres from 'npm:postgres@3.4.7';

export const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, {
  prepare: false,
  max: 3,
  idle_timeout: 20,
  onnotice: () => {},
});

export async function getConfig<T>(key: string): Promise<T | undefined> {
  const rows = await sql`select value from foraeldre.config where key = ${key}`;
  return rows[0]?.value as T | undefined;
}

export async function setConfig(key: string, value: unknown): Promise<void> {
  await sql`
    insert into foraeldre.config (key, value) values (${key}, ${sql.json(value as never)})
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

export async function deleteConfig(key: string): Promise<void> {
  await sql`delete from foraeldre.config where key = ${key}`;
}

export async function getCredential<T>(source: string): Promise<T | undefined> {
  const rows = await sql`select data from foraeldre.credentials where source = ${source}`;
  return rows[0]?.data as T | undefined;
}

export async function setCredential(source: string, data: unknown): Promise<void> {
  await sql`
    insert into foraeldre.credentials (source, data) values (${source}, ${sql.json(data as never)})
    on conflict (source) do update set data = excluded.data, updated_at = now()`;
}

export async function deleteCredential(source: string): Promise<void> {
  await sql`delete from foraeldre.credentials where source = ${source}`;
}

export async function listCredentialSources(prefix: string): Promise<string[]> {
  const rows = await sql`
    select source from foraeldre.credentials where source like ${prefix + '%'} order by source`;
  return rows.map((r) => r.source as string);
}

export interface SourceStatus {
  source: string;
  ok: boolean;
  message: string | null;
  needs_login: boolean;
  baseline_done: boolean;
  last_run: string;
}

export async function getStatus(source: string): Promise<SourceStatus | undefined> {
  const rows = await sql`select * from foraeldre.source_status where source = ${source}`;
  return rows[0] as SourceStatus | undefined;
}

export async function setStatus(
  source: string,
  s: { ok: boolean; message?: string | null; needs_login?: boolean; baseline_done?: boolean },
): Promise<void> {
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

export async function rememberChildren(names: string[]): Promise<void> {
  for (const name of names) {
    if (!name.trim()) continue;
    await sql`insert into foraeldre.children (name) values (${name.trim()}) on conflict do nothing`;
  }
}
