-- Event lifecycle and the SEC enforcement schedule.

-- Date of the newest source behind an event (event_date is the earliest).
alter table events add column latest_source_date date;
update events set latest_source_date = event_date where latest_source_date is null;

-- Closed events drop out of flagged_index but stay readable in event detail.
--   investigation: no new firm release for 120 days
--   filing (8-K 4.01/4.02, NT 10-K/10-Q): one year after filing
--   enforcement: two years after the release
-- Filed lawsuits stay open; the ingestors can't yet see dismissals or settlements.
create or replace function public.close_stale_events()
returns integer
language sql
security definer
set search_path = ''
as $$
  with closed as (
    update public.events
    set status = 'closed', updated_at = now()
    where status in ('investigation', 'open')
      and (
        (category = 'investigation' and coalesce(latest_source_date, event_date) < current_date - 120)
        or (category = 'filing' and event_date < current_date - 365)
        or (category = 'enforcement' and event_date < current_date - 730)
      )
    returning 1
  )
  select count(*)::int from closed;
$$;
revoke all on function public.close_stale_events() from public, anon, authenticated;

select cron.schedule('close-stale-events', '15 6 * * *', $$select public.close_stale_events()$$);
select cron.schedule('ingest-sec-enforcement', '7 * * * *', $$select public.invoke_ingestor('ingest-sec-enforcement')$$);
