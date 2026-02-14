/**
 * OpenClaw Gateway HTTP API client (multi-tenant)
 */
import { getTenant } from "./tenants.js";

// Fallback for demo/dev
const DEFAULT_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:3801";
const DEFAULT_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "demo-token-001";

/**
 * Send a chat message via the tenant's OpenClaw Gateway
 * @param {string} message - User message
 * @param {string} sessionKey - Session key for conversation continuity
 * @param {string} [teamId] - Slack team_id to route to correct gateway
 * @returns {Promise<string>} Assistant response text
 */
export async function chat(message, sessionKey, teamId) {
  let gatewayUrl = DEFAULT_GATEWAY_URL;
  let gatewayToken = DEFAULT_GATEWAY_TOKEN;

  // Route to tenant-specific gateway if available
  if (teamId) {
    const tenant = getTenant(teamId);
    if (tenant?.gateway_url && tenant?.gateway_token) {
      gatewayUrl = tenant.gateway_url;
      gatewayToken = tenant.gateway_token;
    }
  }

  const url = `${gatewayUrl}/v1/chat/completions`;
  const body = {
    model: "openclaw:main",
    messages: [{ role: "user", content: message }],
  };
  if (sessionKey) {
    body.user = sessionKey;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${gatewayToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenClaw API error (${res.status}): ${err}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  return content || "応答を生成できませんでした。";
}
