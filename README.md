# AMS v2 (Supabase Edge)

This repository packages a single Supabase Edge Function that implements the
Agent Management Service (AMS) for Letta agents. The service publishes immutable
Agent Files (`.af`), creates Letta agents with the mandatory Zuplo billing
proxy, and executes dry-run/apply upgrades without touching agent memory.

## Repository layout

```
├── docs/                # API specification and Zuplo integration guide
├── scripts/             # Smoke/E2E automation
├── supabase/config/     # Environment templates and RLS policies
├── supabase/functions/  # Edge Function source code
└── supabase/migrations/ # Database + queue migrations
```

## Getting started

1. **Bootstrap Supabase**
   ```bash
   supabase start
   supabase db reset --db-url "$SUPABASE_DB_URL" --env-file supabase/config/env.example
   supabase db push
   ```

2. **Seed secrets**
   Store the following secrets using `supabase secrets set` so they are available
   to the Edge Function:

   | Key | Description |
   | --- | --- |
   | `SUPABASE_SERVICE_ROLE_KEY` | service role key for database access |
   | `ZUPLO_BASE_URL` | Zuplo gateway URL without trailing slash |
   | `LETTA_API_BASE_URL` | Base URL for Letta API (defaults to official) |
   | `LETTA_API_KEY` | API token for Letta |

3. **Serve the Edge Function locally**
   ```bash
   supabase functions serve ams --env-file supabase/config/env.example
   ```

4. **Run smoke tests**
   ```bash
   npm install
   node --loader ts-node/esm scripts/smoke.ts
   ```

   The script covers publish → create → `/me` profile fetch → upgrade (dry-run)
   and asserts that the Zuplo billing endpoints are applied.

## Key behaviours

- **Single function router** keeps cold starts minimal and leverages Persistent
  Storage (bucket `af-templates`) to cache `.af` payloads.
- **SemVer enforcement** rejects regressive versions and ensures immutability.
- **Idempotency** supported through the `request_dedup` table.
- **Supabase Queues** integration is exposed via the `ams_enqueue_upgrade`
  helper to fan-out upgrades for large cohorts.
- **Billing invariant**: both `model_endpoint` and `embedding_endpoint` are
  forced to `"{ZUPLO_BASE_URL}/api/v1/agents/{user_id}/messages"` during create
  and upgrade operations.
- **Profile synchronisation**: successful agent creation records the resulting
  `letta_agent_id` in `user_profiles` so `/me` can expose the active binding.

## Cron & Queues

The database migration enables `pgmq`, `pg_cron`, and `pg_net`. A default cron
job requeues stalled upgrade attempts, ensuring mass upgrade jobs eventually
settle. Use `select * from pgmq.read('upgrade_jobs', 10, 60);` to inspect the
queue while debugging.

## Acceptance coverage

- `.af` validation and publish semantics.
- Agent creation verifying Zuplo endpoints and user profile linkage.
- Dry-run upgrade diff generation.
- Queue-based upgrade scheduling via `pgmq`.

## Additional notes

- Provision a Supabase Storage bucket named `af-templates` to allow the cache to
  work without permission errors.
- Upload `docs/openapi.yaml` to Zuplo and configure policy scripts as described
  in `docs/zuplo-guide.md`.
