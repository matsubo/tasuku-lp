import "dotenv/config";
import bolt from "@slack/bolt";
import { chat } from "./openclaw.js";
import { checkUsage, incrementUsage } from "./usage.js";

const { App } = bolt;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Helper: safe reaction add (may fail if no permission)
async function addReaction(channel, timestamp, name) {
  try {
    await app.client.reactions.add({
      token: process.env.SLACK_BOT_TOKEN,
      channel,
      timestamp,
      name,
    });
  } catch (err) {
    console.warn(`⚠️ reactions.add(${name}) failed:`, err.data?.error || err.message);
  }
}

// Helper: safe reaction remove
async function removeReaction(channel, timestamp, name) {
  try {
    await app.client.reactions.remove({
      token: process.env.SLACK_BOT_TOKEN,
      channel,
      timestamp,
      name,
    });
  } catch (err) {
    console.warn(`⚠️ reactions.remove(${name}) failed:`, err.data?.error || err.message);
  }
}

// Helper: chat with timeout
async function chatWithTimeout(text, sessionKey, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await chat(text, sessionKey);
  } finally {
    clearTimeout(timer);
  }
}

// Handle core reply logic
async function handleMessage({ event, say, isDM }) {
  const teamId = event.team;
  const userId = event.user;
  const threadTs = event.thread_ts || event.ts;

  // Strip mention text for channel messages
  const rawText = isDM ? event.text : event.text.replace(/<@[A-Z0-9]+>/g, "");
  const text = rawText?.trim();

  if (!text) {
    const msg = "何かお手伝いできることはありますか？🤖";
    await say(isDM ? msg : { text: msg, thread_ts: threadTs });
    return;
  }

  // Usage check
  const allowed = await checkUsage(teamId, userId);
  if (!allowed) {
    const msg = "⚠️ 本日のメッセージ上限に達しました。明日またご利用ください。";
    await say(isDM ? msg : { text: msg, thread_ts: threadTs });
    return;
  }

  // Thinking reaction (channels only)
  if (!isDM) {
    await addReaction(event.channel, event.ts, "thinking_face");
  }

  try {
    const sessionKey = isDM
      ? `tenant:${teamId}:user:${userId}:dm`
      : `tenant:${teamId}:user:${userId}:thread:${threadTs}`;

    const reply = await chatWithTimeout(text, sessionKey, 60000);
    await say(isDM ? reply : { text: reply, thread_ts: threadTs });
    await incrementUsage(teamId, userId);
  } catch (err) {
    console.error("Error handling message:", err);
    const errMsg = err.name === "AbortError"
      ? "⏱️ 応答に時間がかかりすぎました。もう一度お試しください。"
      : "申し訳ありません。エラーが発生しました。🙇";
    await say(isDM ? errMsg : { text: errMsg, thread_ts: threadTs });
  } finally {
    if (!isDM) {
      await removeReaction(event.channel, event.ts, "thinking_face");
    }
  }
}

// Channel mentions
app.event("app_mention", async ({ event, say }) => {
  console.log(`📨 app_mention | ch=${event.channel} | user=${event.user} | text=${event.text?.slice(0, 50)}`);
  await handleMessage({ event, say, isDM: false });
});

// DMs only (filter out channel messages, bot messages, subtypes)
app.event("message", async ({ event, say }) => {
  // Only handle DMs - ignore channels, bot messages, and message subtypes (edits, joins, etc.)
  if (event.channel_type !== "im") return;
  if (event.bot_id || event.subtype) return;

  console.log(`📨 message(DM) | ch=${event.channel} | user=${event.user} | text=${event.text?.slice(0, 50)}`);
  await handleMessage({ event, say, isDM: true });
});

(async () => {
  await app.start();
  console.log("⚡ AI秘書 Bot is running!");
})();
