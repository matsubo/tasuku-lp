import "dotenv/config";
import bolt from "@slack/bolt";
import { chat } from "./openclaw.js";
import { checkUsage, incrementUsage } from "./usage.js";
import { loadTenants, getTenant, upsertTenant } from "./tenants.js";
import { getUpgradeMessage } from "./billing.js";
import { startApiServer } from "./api.js";

const { App } = bolt;

// Load tenant registry
loadTenants();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Helper: get bot token for a team (multi-tenant support)
function getBotToken(teamId) {
  const tenant = getTenant(teamId);
  return tenant?.bot_token || process.env.SLACK_BOT_TOKEN;
}

// Helper: safe reaction add
async function addReaction(channel, timestamp, name, teamId) {
  try {
    await app.client.reactions.add({
      token: getBotToken(teamId),
      channel,
      timestamp,
      name,
    });
  } catch (err) {
    console.warn(`⚠️ reactions.add(${name}) failed:`, err.data?.error || err.message);
  }
}

// Helper: safe reaction remove
async function removeReaction(channel, timestamp, name, teamId) {
  try {
    await app.client.reactions.remove({
      token: getBotToken(teamId),
      channel,
      timestamp,
      name,
    });
  } catch (err) {
    console.warn(`⚠️ reactions.remove(${name}) failed:`, err.data?.error || err.message);
  }
}

// Handle core reply logic
async function handleMessage({ event, say, isDM }) {
  const teamId = event.team;
  const userId = event.user;
  const threadTs = event.thread_ts || event.ts;

  // Auto-register tenant if not known (installed before this version)
  if (!getTenant(teamId)) {
    upsertTenant(teamId, {
      tenant_id: `t-${teamId.toLowerCase()}`,
      team_id: teamId,
      plan: "free",
      status: "active",
      total_messages: 0,
      gateway_url: process.env.OPENCLAW_GATEWAY_URL,
      gateway_token: process.env.OPENCLAW_GATEWAY_TOKEN,
    });
  }

  // Strip mention text for channel messages
  const rawText = isDM ? event.text : event.text.replace(/<@[A-Z0-9]+>/g, "");
  const text = rawText?.trim();

  if (!text) {
    const msg = "何かお手伝いできることはありますか？🤖";
    await say(isDM ? msg : { text: msg, thread_ts: threadTs });
    return;
  }

  // Usage check
  const usage = await checkUsage(teamId, userId);
  if (!usage.allowed) {
    let msg;
    if (usage.reason === "free_limit") {
      // Free tier exhausted — show upgrade options
      try {
        msg = await getUpgradeMessage(teamId);
      } catch (err) {
        console.error("Failed to generate upgrade message:", err.message);
        msg = "⚠️ 無料枠（10回）を超えました。プランを選択して続けてください。\n詳細: https://ai-hisho.teraren.com/#pricing";
      }
    } else if (usage.reason === "daily_limit") {
      msg = "⚠️ 本日のメッセージ上限（100回）に達しました。明日またご利用ください。";
    } else if (usage.reason === "monthly_limit") {
      msg = "⚠️ 今月のメッセージ上限（3,000回）に達しました。来月またご利用ください。";
    } else {
      msg = "⚠️ 現在ご利用いただけません。サポートにお問い合わせください。";
    }
    await say(isDM ? msg : { text: msg, thread_ts: threadTs });
    return;
  }

  // Thinking reaction (channels only)
  if (!isDM) {
    await addReaction(event.channel, event.ts, "thinking_face", teamId);
  }

  try {
    const sessionKey = isDM
      ? `tenant:${teamId}:user:${userId}:dm`
      : `tenant:${teamId}:user:${userId}:thread:${threadTs}`;

    const reply = await chat(text, sessionKey, teamId);
    await say(isDM ? reply : { text: reply, thread_ts: threadTs });
    await incrementUsage(teamId, userId);
  } catch (err) {
    console.error("Error handling message:", err);
    const errMsg =
      err.name === "AbortError"
        ? "⏱️ 応答に時間がかかりすぎました。もう一度お試しください。"
        : "申し訳ありません。エラーが発生しました。🙇";
    await say(isDM ? errMsg : { text: errMsg, thread_ts: threadTs });
  } finally {
    if (!isDM) {
      await removeReaction(event.channel, event.ts, "thinking_face", teamId);
    }
  }
}

// Channel mentions
app.event("app_mention", async ({ event, say }) => {
  console.log(`📨 app_mention | team=${event.team} | ch=${event.channel} | user=${event.user}`);
  await handleMessage({ event, say, isDM: false });
});

// DMs only
app.event("message", async ({ event, say }) => {
  if (event.channel_type !== "im") return;
  if (event.bot_id || event.subtype) return;
  console.log(`📨 message(DM) | team=${event.team} | user=${event.user}`);
  await handleMessage({ event, say, isDM: true });
});

(async () => {
  await app.start();
  console.log("⚡ たすく Bot is running!");

  // Start HTTP API server
  startApiServer();
})();
