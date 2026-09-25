-- Schedules the ingestors. Before applying, store two Vault secrets
-- (SQL editor, once):
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<random string>', 'cron_secret');
-- and set the same CRON_SECRET on the functions:
--   supabase secrets set CRON_SECRET=<random string>

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.invoke_ingestor(fn text)
returns void
language sql
security definer
set search_path = ''
as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/' || fn,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
$$;
revoke all on function public.invoke_ingestor(text) from public, anon, authenticated;

select cron.schedule('ingest-wires', '*/3 * * * *', $$select public.invoke_ingestor('ingest-wires')$$);
select cron.schedule('ingest-edgar', '*/5 * * * *', $$select public.invoke_ingestor('ingest-edgar')$$);
