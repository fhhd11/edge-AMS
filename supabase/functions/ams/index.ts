// Supabase Edge Function implementing the AMS routing logic.
// The function is intentionally implemented as a single entry point with
// an internal router to minimise cold starts, as required by the spec.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { Status } from "https://deno.land/std@0.224.0/http/http_status.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import YAML from "npm:yaml@2.3.4";
import { applyPatch } from "npm:fast-json-patch@3.1.1";
import semver from "npm:semver@7.6.2";

interface AgentFile {
  af_version: string;
  template: {
    id: string;
    name: string;
    version: string;
    description?: string;
  };
  compat: {
    letta_min: string;
    models?: string[];
    embeddings?: string[];
    mcp?: string[];
  };
  engine: {
    model: string;
    embedding: string;
    hyperparams?: Record<string, unknown>;
  };
  persona: {
    system_prompt: string;
    variables_schema?: Record<string, unknown>;
  };
  memory_layout?: unknown;
  tools?: unknown;
  init_messages?: unknown;
  migrations?: Array<MigrationSpec>;
}

interface MigrationSpec {
  from: string;
  to: string;
  steps: MigrationStep[];
}

interface MigrationStep {
  type: "json_patch" | "script";
  description?: string;
  patch?: unknown;
  script?: {
    language: "js";
    code: string;
  };
}

interface PublishResponse {
  template_id: string;
  version: string;
  checksum: string;
  is_latest: boolean;
}

interface CreateAgentInput {
  template_id: string;
  version?: string;
  use_latest?: boolean;
  variables?: Record<string, unknown>;
  agent_name?: string;
}

interface UpgradeAgentInput {
  target_version?: string;
  use_latest?: boolean;
  allow_minor_auto?: boolean;
  dry_run?: boolean;
  use_queue?: boolean;
}

interface LettaAgentConfig {
  id?: string;
  name?: string;
  model: string;
  embedding: string;
  model_endpoint: string;
  embedding_endpoint: string;
  hyperparams?: Record<string, unknown>;
  system_prompt: string;
  tools?: unknown;
  init_messages?: unknown;
}

interface UserProfile {
  id: string;
  email?: string | null;
  litellm_key?: string | null;
  letta_agent_id?: string | null;
  agent_status?: string | null;
  created_at?: string;
  updated_at?: string;
  name?: string | null;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ZUPLO_BASE_URL = Deno.env.get("ZUPLO_BASE_URL");
const LETTA_API_BASE_URL = Deno.env.get("LETTA_API_BASE_URL") ?? "https://api.letta.com";
const LETTA_API_KEY = Deno.env.get("LETTA_API_KEY");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing Supabase configuration");
}

if (!ZUPLO_BASE_URL) {
  console.error("Missing ZUPLO_BASE_URL configuration");
}

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })
  : null;

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/?api\/v1\//, "");
    const method = req.method.toUpperCase();

    if (path === "health" && method === "GET") {
      return await handleHealth();
    }

    if (!supabase) {
      return jsonResponse({ error: "Supabase client not initialised" }, Status.InternalServerError);
    }

    if (path === "templates/validate" && method === "POST") {
      const bodyText = await req.text();
      return await handleValidateTemplate(bodyText);
    }

    if (path === "templates/publish" && method === "POST") {
      const idempotencyKey = req.headers.get("Idempotency-Key") ?? undefined;
      const bodyText = await req.text();
      return await handlePublishTemplate(bodyText, idempotencyKey);
    }

    if (path === "agents/create" && method === "POST") {
      const idempotencyKey = req.headers.get("Idempotency-Key") ?? undefined;
      const payload: CreateAgentInput = await req.json();
      const userId = req.headers.get("X-User-Id") ?? payload["user_id" as keyof CreateAgentInput] as string | undefined;
      if (!userId) {
        return jsonResponse({ error: "Missing user context" }, Status.BadRequest);
      }
      return await handleCreateAgent(payload, userId, idempotencyKey);
    }

    if (path === "me" && method === "GET") {
      const userId = req.headers.get("X-User-Id") ?? undefined;
      if (!userId) {
        return jsonResponse({ error: "Missing user context" }, Status.Unauthorized);
      }
      return await handleGetProfile(userId);
    }

    const upgradeMatch = path.match(/^agents\/(.+?)\/upgrade$/);
    if (upgradeMatch && method === "POST") {
      const idempotencyKey = req.headers.get("Idempotency-Key") ?? undefined;
      const payload: UpgradeAgentInput = await req.json();
      const userId = req.headers.get("X-User-Id") ?? undefined;
      const agentId = upgradeMatch[1];
      return await handleUpgradeAgent(agentId, payload, userId, idempotencyKey);
    }

    return jsonResponse({ error: "Not Found" }, Status.NotFound);
  } catch (error) {
    console.error("Unhandled error", error);
    return jsonResponse({ error: "Internal Server Error" }, Status.InternalServerError);
  }
});

async function handleHealth() {
  const checks: Record<string, string> = {};

  if (supabase) {
    const { error } = await supabase.from("af_templates").select("id").limit(1);
    checks["database"] = error ? `error: ${error.message}` : "ok";
  } else {
    checks["database"] = "uninitialised";
  }

  if (ZUPLO_BASE_URL) {
    checks["zuplo_base_url"] = "ok";
  } else {
    checks["zuplo_base_url"] = "missing";
  }

  if (LETTA_API_KEY) {
    checks["letta_api_key"] = "ok";
  } else {
    checks["letta_api_key"] = "missing";
  }

  return jsonResponse({ status: "ok", checks });
}

async function handleValidateTemplate(rawBody: string) {
  try {
    const { agentFile, format } = parseAgentFile(rawBody);
    const validation = await validateAgentFile(agentFile);
    return jsonResponse({ format, validation });
  } catch (error) {
    return jsonResponse({ error: error.message ?? String(error) }, Status.BadRequest);
  }
}

async function handlePublishTemplate(rawBody: string, idempotencyKey?: string): Promise<Response> {
  if (!supabase) {
    return jsonResponse({ error: "Supabase client not initialised" }, Status.InternalServerError);
  }

  try {
    const { agentFile, raw, format } = parseAgentFile(rawBody);
    await ensureIdempotency(idempotencyKey, rawBody);

    const validation = await validateAgentFile(agentFile);
    if (!validation.valid) {
      return jsonResponse({ error: "Validation failed", details: validation.errors }, Status.BadRequest);
    }

    const templateId = agentFile.template.id;
    const version = agentFile.template.version;

    const { data: existingVersions, error: listError } = await supabase
      .from("af_versions")
      .select("version")
      .eq("template_id", templateId);
    if (listError) throw listError;

    const semverResult = assessSemver(version, existingVersions?.map((v) => v.version) ?? []);
    if (!semverResult.allowed) {
      return jsonResponse({ error: semverResult.message }, Status.BadRequest);
    }

    const checksum = await sha256(raw);

    const { error: templateUpsertError } = await supabase.from("af_templates").upsert({
      id: templateId,
    });
    if (templateUpsertError) throw templateUpsertError;

    const { error: insertError } = await supabase.from("af_versions").insert({
      template_id: templateId,
      version,
      af_source: raw,
      checksum,
      is_latest: true,
      published_by: validation.publishedBy ?? null,
    });
    if (insertError) {
      if (insertError.code === "23505") {
        return jsonResponse({ error: "Version already exists" }, Status.Conflict);
      }
      throw insertError;
    }

    const { error: resetLatestError } = await supabase
      .from("af_versions")
      .update({ is_latest: false })
      .eq("template_id", templateId)
      .neq("version", version);
    if (resetLatestError) throw resetLatestError;

    await cacheAgentFile(templateId, version, raw);

    const response: PublishResponse = {
      template_id: templateId,
      version,
      checksum,
      is_latest: true,
    };
    return jsonResponse({ format, ...response });
  } catch (error) {
    if (error instanceof IdempotencyError) {
      return jsonResponse({ error: error.message }, Status.Conflict);
    }
    console.error("Publish error", error);
    return jsonResponse({ error: error.message ?? String(error) }, Status.InternalServerError);
  }
}

async function handleCreateAgent(payload: CreateAgentInput, userId: string, idempotencyKey?: string) {
  if (!supabase) {
    return jsonResponse({ error: "Supabase client not initialised" }, Status.InternalServerError);
  }
  if (!ZUPLO_BASE_URL) {
    return jsonResponse({ error: "Missing Zuplo base URL" }, Status.InternalServerError);
  }
  try {
    await ensureIdempotency(idempotencyKey, JSON.stringify({ payload, userId }));

    const { template, raw } = await resolveTemplateVersion(payload.template_id, payload.version, payload.use_latest ?? false);
    const variables = payload.variables ?? {};
    await validateTemplateVariables(template, variables);

    const config = buildAgentConfigFromTemplate(template, userId);
    if (payload.agent_name) {
      config.name = payload.agent_name;
    }

    const agent = await createLettaAgent(config);

    const { error: recordError } = await supabase.from("agent_instances").upsert({
      agent_id: agent.id,
      user_id: userId,
      template_id: template.template.id,
      version: template.template.version,
      variables,
    });
    if (recordError) throw recordError;

    await upsertUserProfileAgent(userId, agent.id);

    return jsonResponse({ agent, template_checksum: await sha256(raw) });
  } catch (error) {
    if (error instanceof IdempotencyError) {
      return jsonResponse({ error: error.message }, Status.Conflict);
    }
    console.error("Create agent error", error);
    return jsonResponse({ error: error.message ?? String(error) }, Status.InternalServerError);
  }
}

async function handleUpgradeAgent(agentId: string, payload: UpgradeAgentInput, userId?: string, idempotencyKey?: string) {
  if (!supabase) {
    return jsonResponse({ error: "Supabase client not initialised" }, Status.InternalServerError);
  }
  if (!ZUPLO_BASE_URL) {
    return jsonResponse({ error: "Missing Zuplo base URL" }, Status.InternalServerError);
  }

  try {
    await ensureIdempotency(idempotencyKey, JSON.stringify({ payload, agentId }));

    const { data: agentRecord, error: agentError } = await supabase
      .from("agent_instances")
      .select("agent_id, user_id, template_id, version, variables")
      .eq("agent_id", agentId)
      .maybeSingle();
    if (agentError) throw agentError;
    if (!agentRecord) {
      return jsonResponse({ error: "Agent not found" }, Status.NotFound);
    }

    if (userId && userId !== agentRecord.user_id) {
      return jsonResponse({ error: "Forbidden" }, Status.Forbidden);
    }

    const resolvedTarget = await resolveTemplateVersion(
      agentRecord.template_id,
      payload.target_version,
      payload.use_latest ?? true,
    );

    const plan = buildMigrationPlan(agentRecord.version, resolvedTarget.template.template.version, resolvedTarget.template.migrations ?? []);

    const currentConfig = await fetchLettaAgent(agentId);
    const dryRunResult = await performDryRun(plan, currentConfig, agentRecord.user_id);

    if (payload.dry_run ?? true) {
      await logMigration(agentId, agentRecord.version, resolvedTarget.template.template.version, true, plan, dryRunResult.diff);
      return jsonResponse({ plan, diff: dryRunResult.diff, warnings: dryRunResult.warnings, dry_run: true });
    }

    if (payload.use_queue) {
      await enqueueUpgradeJob({
        agent_id: agentId,
        user_id: agentRecord.user_id,
        from_version: agentRecord.version,
        to_version: resolvedTarget.template.template.version,
        plan,
      });
      return jsonResponse({ queued: true, plan });
    }

    const updatedConfig = dryRunResult.updatedConfig;
    const applied = await updateLettaAgent(agentId, updatedConfig);

    const { error: updateError } = await supabase.from("agent_instances").update({
      version: resolvedTarget.template.template.version,
      updated_at: new Date().toISOString(),
    }).eq("agent_id", agentId);
    if (updateError) throw updateError;

    await logMigration(agentId, agentRecord.version, resolvedTarget.template.template.version, false, plan, dryRunResult.diff);

    return jsonResponse({ agent: applied, plan, diff: dryRunResult.diff, dry_run: false });
  } catch (error) {
    if (error instanceof IdempotencyError) {
      return jsonResponse({ error: error.message }, Status.Conflict);
    }
    console.error("Upgrade agent error", error);
    return jsonResponse({ error: error.message ?? String(error) }, Status.InternalServerError);
  }
}

async function handleGetProfile(userId: string) {
  if (!supabase) {
    return jsonResponse({ error: "Supabase client not initialised" }, Status.InternalServerError);
  }

  try {
    const { data, error } = await supabase
      .from("user_profiles")
      .select("id, email, litellm_key, letta_agent_id, agent_status, created_at, updated_at, name")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw error;

    if (!data) {
      return jsonResponse({ profile: null });
    }

    const profile: UserProfile = data;
    return jsonResponse({ profile });
  } catch (error) {
    console.error("Get profile error", error);
    return jsonResponse({ error: error.message ?? String(error) }, Status.InternalServerError);
  }
}

function jsonResponse(body: unknown, status = Status.OK) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseAgentFile(rawBody: string): { raw: string; agentFile: AgentFile; format: "yaml" | "json" } {
  if (!rawBody) {
    throw new Error("Empty body");
  }
  let format: "yaml" | "json" = "json";
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
    format = "json";
  } catch (_jsonError) {
    parsed = YAML.parse(rawBody);
    format = "yaml";
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid Agent File content");
  }

  return { raw: rawBody, agentFile: parsed as AgentFile, format };
}

async function validateAgentFile(agentFile: AgentFile) {
  const errors: string[] = [];

  if (!agentFile.af_version) errors.push("af_version is required");
  if (!agentFile.template?.id) errors.push("template.id is required");
  if (!agentFile.template?.version) errors.push("template.version is required");
  if (!agentFile.persona?.system_prompt) errors.push("persona.system_prompt is required");
  if (!agentFile.engine?.model) errors.push("engine.model is required");
  if (!agentFile.engine?.embedding) errors.push("engine.embedding is required");

  if (agentFile.template?.version && !semver.valid(agentFile.template.version)) {
    errors.push(`template.version ${agentFile.template.version} is not valid SemVer`);
  }

  if (agentFile.migrations) {
    for (const migration of agentFile.migrations) {
      if (!migration.from || !migration.to) {
        errors.push("Migration entries must include from and to versions");
      }
      if (migration.steps) {
        for (const step of migration.steps) {
          if (step.type === "json_patch" && !step.patch) {
            errors.push(`Migration ${migration.from}->${migration.to} missing patch`);
          }
          if (step.type === "script" && !step.script?.code) {
            errors.push(`Migration ${migration.from}->${migration.to} missing script`);
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    publishedBy: undefined,
  };
}

function assessSemver(nextVersion: string, existing: string[]) {
  if (existing.includes(nextVersion)) {
    return { allowed: false, message: "Version already published" };
  }
  const sorted = existing.filter((v) => semver.valid(v)).sort(semver.rcompare);
  if (sorted.length === 0) {
    return { allowed: true };
  }
  const latest = sorted[0];
  if (semver.lt(nextVersion, latest)) {
    return { allowed: false, message: `Version ${nextVersion} is lower than latest ${latest}` };
  }
  return { allowed: true };
}

async function cacheAgentFile(templateId: string, version: string, raw: string) {
  if (!supabase) return;
  try {
    await supabase.storage.from("af-templates").upload(`${templateId}/${version}.af`, raw, {
      contentType: "application/x-yaml",
      upsert: true,
    });
  } catch (error) {
    console.warn("Failed to cache Agent File", error);
  }
}

async function resolveTemplateVersion(templateId: string, version?: string, useLatest = false) {
  if (!supabase) throw new Error("Supabase not initialised");

  let query = supabase.from("af_versions").select("template_id, version, af_source, migrations").eq("template_id", templateId);
  if (version) {
    query = query.eq("version", version);
  } else if (useLatest) {
    query = query.eq("is_latest", true);
  } else {
    throw new Error("Either version or use_latest must be provided");
  }
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Template version not found");

  const parsed = parseAgentFile(data.af_source).agentFile;
  return { template: parsed, raw: data.af_source };
}

function buildAgentConfigFromTemplate(agentFile: AgentFile, userId: string): LettaAgentConfig {
  if (!ZUPLO_BASE_URL) throw new Error("Missing Zuplo base URL");
  const endpoint = `${ZUPLO_BASE_URL}/api/v1/agents/${userId}/messages`;
  return {
    model: agentFile.engine.model,
    embedding: agentFile.engine.embedding,
    model_endpoint: endpoint,
    embedding_endpoint: endpoint,
    hyperparams: agentFile.engine.hyperparams ?? {},
    system_prompt: agentFile.persona.system_prompt,
    tools: agentFile.tools ?? [],
    init_messages: agentFile.init_messages ?? [],
  };
}

async function validateTemplateVariables(agentFile: AgentFile, variables: Record<string, unknown>) {
  if (!agentFile.persona?.variables_schema) return;
  const schema = agentFile.persona.variables_schema as { required?: string[] };
  if (schema?.required) {
    const missing = schema.required.filter((key) => !(key in variables));
    if (missing.length > 0) {
      throw new Error(`Missing required variables: ${missing.join(", ")}`);
    }
  }
}

async function createLettaAgent(config: LettaAgentConfig) {
  if (!LETTA_API_KEY) {
    throw new Error("Missing Letta API key");
  }
  const response = await fetch(`${LETTA_API_BASE_URL}/agents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LETTA_API_KEY}`,
    },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Letta create agent failed: ${response.status} ${text}`);
  }
  return await response.json();
}

async function fetchLettaAgent(agentId: string) {
  if (!LETTA_API_KEY) throw new Error("Missing Letta API key");
  const response = await fetch(`${LETTA_API_BASE_URL}/agents/${agentId}`, {
    headers: {
      Authorization: `Bearer ${LETTA_API_KEY}`,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch agent ${agentId}: ${response.status} ${text}`);
  }
  return await response.json();
}

async function updateLettaAgent(agentId: string, config: LettaAgentConfig) {
  if (!LETTA_API_KEY) throw new Error("Missing Letta API key");
  const response = await fetch(`${LETTA_API_BASE_URL}/agents/${agentId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LETTA_API_KEY}`,
    },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to update agent ${agentId}: ${response.status} ${text}`);
  }
  return await response.json();
}

function buildMigrationPlan(currentVersion: string, targetVersion: string, migrations: MigrationSpec[]): MigrationStep[] {
  if (currentVersion === targetVersion) {
    return [];
  }
  const path: MigrationStep[] = [];
  let version = currentVersion;
  const guard = new Set<string>();
  while (version !== targetVersion) {
    if (guard.has(version)) {
      throw new Error("Circular migration plan detected");
    }
    guard.add(version);
    const step = migrations.find((m) => m.from === version);
    if (!step) {
      throw new Error(`No migration step found from ${version} towards ${targetVersion}`);
    }
    path.push(...step.steps);
    version = step.to;
  }
  return path;
}

async function performDryRun(plan: MigrationStep[], currentConfig: LettaAgentConfig, userId: string) {
  const diff: Record<string, unknown>[] = [];
  let updatedConfig: LettaAgentConfig = { ...currentConfig };
  const warnings: string[] = [];
  for (const step of plan) {
    if (step.type === "json_patch") {
      updatedConfig = applyPatch(structuredClone(updatedConfig), step.patch ?? [], false, false).newDocument as LettaAgentConfig;
    } else if (step.type === "script") {
      warnings.push(`Script step executed in dry-run only: ${step.description ?? "no description"}`);
    }
  }
  const endpoint = `${ZUPLO_BASE_URL}/api/v1/agents/${userId}/messages`;
  updatedConfig.model_endpoint = endpoint;
  updatedConfig.embedding_endpoint = endpoint;
  diff.push({ op: "set", path: "/model_endpoint", value: endpoint });
  diff.push({ op: "set", path: "/embedding_endpoint", value: endpoint });
  return { diff, warnings, updatedConfig };
}

async function upsertUserProfileAgent(userId: string, agentId: string) {
  if (!supabase) return;

  const now = new Date().toISOString();

  const { data: existing, error: fetchError } = await supabase
    .from("user_profiles")
    .select("id")
    .eq("id", userId)
    .maybeSingle();
  if (fetchError) {
    throw fetchError;
  }

  if (existing) {
    const { error: updateError } = await supabase
      .from("user_profiles")
      .update({ letta_agent_id: agentId, updated_at: now })
      .eq("id", userId);
    if (updateError) {
      throw updateError;
    }
    return;
  }

  const { error: insertError } = await supabase.from("user_profiles").insert({
    id: userId,
    letta_agent_id: agentId,
    updated_at: now,
  });
  if (insertError) {
    throw insertError;
  }
}

async function logMigration(
  agentId: string,
  fromVersion: string,
  toVersion: string,
  dryRun: boolean,
  plan: MigrationStep[],
  diff: unknown,
) {
  if (!supabase) return;
  const { error } = await supabase.from("agent_migrations").insert({
    agent_id: agentId,
    from_version: fromVersion,
    to_version: toVersion,
    dry_run: dryRun,
    plan,
    diff,
    status: dryRun ? "dry_run" : "applied",
  });
  if (error) {
    console.warn("Failed to log migration", error);
  }
}

async function enqueueUpgradeJob(job: Record<string, unknown>) {
  if (!supabase) throw new Error("Supabase not initialised");
  const { error } = await supabase.rpc("ams_enqueue_upgrade", {
    queue_name: "upgrade_jobs",
    payload: job,
  });
  if (error) throw error;
}

async function ensureIdempotency(key: string | undefined, payloadHashSource: string) {
  if (!supabase) return;
  if (!key) return;
  const checksum = await sha256(payloadHashSource);
  const { data, error } = await supabase.from("request_dedup").select("checksum").eq("idempotency_key", key).maybeSingle();
  if (error && error.code !== "PGRST116") {
    throw error;
  }
  if (data) {
    if (data.checksum !== checksum) {
      throw new IdempotencyError("Idempotency key re-used with different payload");
    }
    throw new IdempotencyError("Duplicate request");
  }
  const { error: insertError } = await supabase.from("request_dedup").insert({
    idempotency_key: key,
    checksum,
  });
  if (insertError) throw insertError;
}

class IdempotencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyError";
  }
}

async function sha256(content: string) {
  const data = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
