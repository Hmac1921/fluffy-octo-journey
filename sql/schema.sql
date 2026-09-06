-- Enable extension if you want gen_random_uuid()
-- create extension if not exists pgcrypto;

-- Teams
create table if not exists teams (
  id text primary key,          -- e.g. "team-a"
  name text not null,
  slack_channel_id text          -- optional Slack channel ID to post to
);

-- Who can edit
create table if not exists roles (
  slack_user_id text primary key,
  role text not null check (role in ('admin','coach','member'))
);

-- Events (single row per event or recurring series)
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  timezone text not null default 'Europe/Stockholm',
  location text,
  notes text,
  rrule text,
  external_source text,
  external_uid text,
  cancelled boolean not null default false,
  created_by text,
  updated_at timestamptz not null default now()
);

alter table events add column if not exists external_source text;
alter table events add column if not exists external_uid text;

create unique index if not exists events_external_source_uid_idx
  on events (external_source, external_uid)
  where external_source is not null and external_uid is not null;

-- Many-to-many tagging (multi-team events)
create table if not exists event_teams (
  event_id uuid references events(id) on delete cascade,
  team_id text references teams(id) on delete cascade,
  primary key (event_id, team_id)
);

-- Tokenized ICS access:
create table if not exists ics_tokens (
  token text primary key,
  team_id text not null,         -- "team-a" or "*"
  created_at timestamptz not null default now()
);

-- Attendance records for event occurrences
create table if not exists attendance (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id) on delete cascade,
  occurrence_start timestamptz,
  user_id text not null,
  user_name text,
  status text not null check (status in ('yes','no','maybe')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table attendance add column if not exists occurrence_start timestamptz;
alter table attendance add column if not exists user_name text;
alter table attendance add column if not exists updated_at timestamptz not null default now();

create table if not exists slack_event_posts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id) on delete cascade,
  occurrence_start timestamptz not null,
  channel_id text not null,
  message_ts text,
  content_hash text not null,
  posted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, occurrence_start, channel_id)
);
