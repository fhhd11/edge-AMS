/**
 * Minimal smoke tests for the AMS Edge function. These tests assume the
 * function is running locally via `supabase functions serve --env-file ...`.
 */

import assert from "node:assert/strict";

const BASE_URL = process.env.AMS_BASE_URL ?? "http://localhost:54321/functions/v1/ams/api/v1";
const ZUPLO_BASE_URL = process.env.ZUPLO_BASE_URL ?? "https://gateway.example.com";
const USER_ID = process.env.TEST_USER_ID ?? "00000000-0000-0000-0000-000000000000";

async function main() {
  console.log("Running AMS smoke tests against", BASE_URL);

  await healthCheck();
  const publishResult = await publishTemplate();
  const agent = await createAgent(publishResult.template_id, publishResult.version);
  await upgradeDryRun(agent.agent.id);
  console.log("All smoke tests passed");
}

async function healthCheck() {
  const res = await fetch(`${BASE_URL}/health`);
  assert.equal(res.status, 200, "health endpoint should return 200");
  const json = await res.json();
  assert.equal(json.status, "ok");
}

function sampleAgentFile(version: string) {
  return `af_version: "1.0"
template:
  id: "sample-support-agent"
  name: "Sample Support Agent"
  version: "${version}"
compat:
  letta_min: "0.1.0"
engine:
  model: "gpt-4o"
  embedding: "text-embedding-3-large"
persona:
  system_prompt: |
    You are a helpful assistant.
  variables_schema:
    type: object
    required: []
init_messages: []
`;
}

async function publishTemplate() {
  const version = `1.0.${Date.now()}`;
  const body = sampleAgentFile(version);
  const res = await fetch(`${BASE_URL}/templates/publish`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-yaml",
      "Idempotency-Key": `publish-${version}`,
    },
    body,
  });
  const json = await res.json();
  assert.equal(res.status, 200, `publish failed: ${JSON.stringify(json)}`);
  assert.equal(json.version, version);
  return json;
}

async function createAgent(templateId: string, version: string) {
  const res = await fetch(`${BASE_URL}/agents/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": USER_ID,
      "Idempotency-Key": `create-${version}`,
    },
    body: JSON.stringify({ template_id: templateId, version, variables: {} }),
  });
  const json = await res.json();
  assert.equal(res.status, 200, `create failed: ${JSON.stringify(json)}`);
  const endpoint = `${ZUPLO_BASE_URL}/api/v1/agents/${USER_ID}/messages`;
  assert.equal(json.agent.model_endpoint, endpoint, "model endpoint must use Zuplo proxy");
  assert.equal(json.agent.embedding_endpoint, endpoint, "embedding endpoint must use Zuplo proxy");
  return json;
}

async function upgradeDryRun(agentId: string) {
  const res = await fetch(`${BASE_URL}/agents/${agentId}/upgrade`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": USER_ID,
      "Idempotency-Key": `upgrade-${Date.now()}`,
    },
    body: JSON.stringify({ dry_run: true, use_latest: true }),
  });
  const json = await res.json();
  assert.equal(res.status, 200, `upgrade dry run failed: ${JSON.stringify(json)}`);
  assert.equal(json.dry_run, true);
  const endpoint = `${ZUPLO_BASE_URL}/api/v1/agents/${USER_ID}/messages`;
  const endpointOp = json.diff.find((d: any) => d.path === "/model_endpoint");
  assert(endpointOp, "dry-run diff should include model endpoint override");
  assert.equal(endpointOp.value, endpoint);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
