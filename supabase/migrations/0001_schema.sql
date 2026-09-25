-- Securities List: companies, normalized events, raw source items, and the
-- two read-only views the extension consumes. The anon role can read the
-- views, companies, events and firms; nothing else, and it can never write.

create extension if not exists pgcrypto;

create table companies (
  id uuid primary key default gen_random_uuid(),
  ticker text not null unique,
  exchange text,
  name text not null,
  aliases text[] not null default '{}',
  cik text unique,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Plaintiff firms, for matching release pages on the device ("1 of N").
create table firms (
  name text primary key
);

create table events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  category text not null check (category in ('enforcement', 'filing', 'short_report', 'investigation', 'lawsuit', 'news')),
  status text not null default 'open' check (status in ('investigation', 'filed', 'dismissed', 'settled', 'open', 'closed')),
  event_date date not null,
  severity text not null default 'medium' check (severity in ('low', 'medium', 'high')),
  title text not null,
  summary text not null,
  alleged_conduct text,
  -- source_urls[i] was published by firms[i] for investigation events.
  source_urls text[] not null default '{}',
  source_url_hashes text[] not null default '{}',
  firms text[] not null default '{}',
  class_period_start date,
  class_period_end date,
  lead_plaintiff_deadline date,
  court text,
  case_number text,
  dedupe_key text not null unique,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(source_urls) >= 1),
  check (cardinality(source_urls) = cardinality(source_url_hashes))
);
create index events_company_idx on events (company_id, event_date desc);

-- Unprocessed source records, kept for audit and reprocessing.
create table raw_items (
  id bigint generated always as identity primary key,
  source text not null,
  source_id text not null,
  url text,
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  processed_at timestamptz,
  event_id uuid references events (id) on delete set null,
  error text,
  unique (source, source_id)
);

-- Per-ingestor cursor (e.g. the newest EDGAR accession already seen).
create table ingest_state (
  source text primary key,
  cursor text,
  updated_at timestamptz not null default now()
);

-- ---------- Read-only views for the extension

create view flagged_index with (security_invoker = true) as
select
  c.ticker,
  c.exchange,
  c.name as company,
  array[c.name] || c.aliases as names,
  count(*)::int as count,
  (array['low', 'medium', 'high'])[max(case e.severity when 'low' then 1 when 'medium' then 2 else 3 end)] as max_severity,
  max(e.updated_at) as updated_at,
  coalesce(
    jsonb_agg(
      jsonb_build_object(
        'event_id', e.id,
        'firms', e.firms,
        'release_count', cardinality(e.source_urls),
        'release_hashes', e.source_url_hashes
      )
    ) filter (where e.category = 'investigation'),
    '[]'::jsonb
  ) as investigations
from companies c
join events e on e.company_id = c.id
where e.status not in ('dismissed', 'settled', 'closed')
group by c.id;

create view events_by_ticker with (security_invoker = true) as
select
  e.id,
  c.ticker,
  c.name as company,
  e.category,
  e.status,
  e.event_date,
  e.severity,
  e.title,
  e.summary,
  e.alleged_conduct,
  e.source_urls,
  e.firms,
  e.class_period_start,
  e.class_period_end,
  e.lead_plaintiff_deadline,
  e.court,
  e.case_number,
  e.first_seen_at,
  e.updated_at
from events e
join companies c on c.id = e.company_id;

-- ---------- Row-level security: public read, no public writes

alter table companies enable row level security;
alter table events enable row level security;
alter table firms enable row level security;
alter table raw_items enable row level security;
alter table ingest_state enable row level security;

create policy "public read" on companies for select to anon, authenticated using (true);
create policy "public read" on events for select to anon, authenticated using (true);
create policy "public read" on firms for select to anon, authenticated using (true);
-- raw_items and ingest_state: no policies, so only the service role (edge functions) can touch them.

revoke all on raw_items, ingest_state from anon, authenticated;
grant select on companies, events, firms, flagged_index, events_by_ticker to anon, authenticated;
