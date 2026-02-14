/**
 * OpenClaw Gateway HTTP API client
 * Uses OpenAI-compatible /v1/chat/completions endpoint
 */

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:3801";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "demo-token-001";

/**
 * Send a chat message via OpenClaw Gateway HTTP API
 * @param {string} message - User message
 * @param {string} [sessionKey] - Session key for conversation continuity
 * @returns {Promise<string>} Assistant response text
 */
export async function chat(message, sessionKey) {
  const url = `${GATEWAY_URL}/v1/chat/completions`;
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
      "Authorization": `Bearer ${GATEWAY_TOKEN}`,
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
