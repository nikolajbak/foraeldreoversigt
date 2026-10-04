-- Synkronisering: hvert kvarter kl. ca. 6–23 dansk tid, ellers hver time.
-- pg_cron kører i UTC. Hemmeligheden læses fra foraeldre.config ved hver kørsel.
create or replace function foraeldre.kald_synk() returns void
language sql security definer set search_path = '' as $$
  select net.http_post(
    url := 'https://gjycsqshkvkcupdnvgvf.supabase.co/functions/v1/foraeldre-api/sync',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select value #>> '{}' from foraeldre.config where key = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000);
$$;
revoke all on function foraeldre.kald_synk() from public, anon, authenticated;

select cron.schedule('foraeldre-synk-dag', '*/15 4-21 * * *', 'select foraeldre.kald_synk()');
select cron.schedule('foraeldre-synk-nat', '0 0-3,22,23 * * *', 'select foraeldre.kald_synk()');
