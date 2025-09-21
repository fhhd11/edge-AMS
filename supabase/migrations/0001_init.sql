-- Enable required extensions.
create extension if not exists pgmq;
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Core tables for Agent File management.
create table if not exists af_templates (
    id text primary key,
    created_at timestamptz not null default now()
);

create table if not exists af_versions (
    template_id text not null references af_templates(id) on delete cascade,
    version text not null,
    af_source text not null,
    checksum text not null,
    is_latest boolean not null default false,
    migrations jsonb,
    published_by uuid,
    published_at timestamptz not null default now(),
    constraint af_versions_pk primary key (template_id, version)
);

create index if not exists af_versions_latest_idx on af_versions(template_id) where is_latest;

create table if not exists agent_instances (
    agent_id text primary key,
    user_id uuid not null,
    template_id text not null references af_templates(id),
    version text not null,
    variables jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists agent_instances_user_idx on agent_instances(user_id);
create index if not exists agent_instances_template_idx on agent_instances(template_id);

create table if not exists agent_migrations (
    id uuid primary key default gen_random_uuid(),
    agent_id text not null,
    from_version text not null,
    to_version text not null,
    dry_run boolean not null default true,
    plan jsonb not null,
    diff jsonb,
    status text not null,
    error text,
    created_at timestamptz not null default now()
);

create index if not exists agent_migrations_agent_idx on agent_migrations(agent_id);

create table if not exists request_dedup (
    idempotency_key text primary key,
    checksum text not null,
    created_at timestamptz not null default now()
);

-- Provision the pgmq queue used for deferred upgrades.
select pgmq.create_queue('upgrade_jobs');

create or replace function ams_enqueue_upgrade(queue_name text, payload jsonb)
returns bigint
language plpgsql
as $$
declare
    result bigint;
begin
    result := pgmq.send(queue_name, payload);
    return result;
end;
$$;

-- Helper function for cron jobs to requeue stalled upgrades.
create or replace function ams_requeue_stalled_upgrades()
returns void
language plpgsql
as $$
begin
    perform pgmq.send('upgrade_jobs_deadletter', message)
    from pgmq.read('upgrade_jobs', 100, 600)
    as t(message_id bigint, vt timestamptz, message jsonb);
end;
$$;

-- Schedule periodic maintenance via pg_cron.
select cron.schedule(
    'ams-upgrade-requeue',
    '*/15 * * * *',
    $$select ams_requeue_stalled_upgrades();$$
) on conflict do nothing;
