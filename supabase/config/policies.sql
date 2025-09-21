-- Example RLS policies for AMS tables. Adjust roles to match your project roles.

alter table af_templates enable row level security;
alter table af_versions enable row level security;
alter table agent_instances enable row level security;
alter table agent_migrations enable row level security;
alter table request_dedup enable row level security;

-- Service role (edge function) has unrestricted access.
create policy "service-role-readwrite-af-templates" on af_templates
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "service-role-readwrite-af-versions" on af_versions
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "service-role-readwrite-agent-instances" on agent_instances
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "service-role-readwrite-agent-migrations" on agent_migrations
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "service-role-readwrite-request-dedup" on request_dedup
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Optional read-only policy for observability (authenticated users can see their own agents).
create policy "user-can-view-own-agent" on agent_instances
  for select
  using (auth.uid() = user_id);
