-- Ensure the user_profiles table exists with the required columns.
create table if not exists public.user_profiles (
  id uuid not null,
  email text null,
  litellm_key text null,
  letta_agent_id text null,
  agent_status text null default 'active',
  created_at timestamptz null default now(),
  updated_at timestamptz null default now(),
  name text null,
  constraint user_profiles_pkey primary key (id),
  constraint user_profiles_letta_agent_id_key unique (letta_agent_id),
  constraint user_profiles_litellm_key_key unique (litellm_key),
  constraint user_profiles_id_fkey foreign key (id) references auth.users (id)
);

create index if not exists idx_user_profiles_letta_agent_id on public.user_profiles (letta_agent_id);
