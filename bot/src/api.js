/**
 * HTTP API server for Slack OAuth + Stripe webhooks
 * Runs alongside the Socket Mode bot in the same process
 */
import express from "express";
import crypto from "node:crypto";
import { upsertTenant, getTenant } from "./tenants.js";
import { handleStripeWebhook, createPortalSession } from "./billing.js";

const app = express();
const PORT = process.env.API_PORT || 3800;
const BASE_URL = process.env.BASE_URL || "https://ai-hisho.teraren.com";

// Slack OAuth config
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const SLACK_SCOPES = "app_mentions:read,chat:write,im:history,im:read,im:write,reactions:read,reactions:write";
const SLACK_USER_SCOPES = "";

// ── Stripe webhook (raw body needed) ──
app.post("/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];
    const result = await handleStripeWebhook(req.body, sig);
    res.json(result);
  } catch (err) {
    console.error("❌ Stripe webhook error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// JSON body parser for other routes
app.use(express.json());

// ── Health check ──
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ── Slack OAuth: Install redirect ──
app.get("/slack/install", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  // In production, store state in session/cookie for CSRF protection
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", SLACK_CLIENT_ID);
  url.searchParams.set("scope", SLACK_SCOPES);
  url.searchParams.set("user_scope", SLACK_USER_SCOPES);
  url.searchParams.set("redirect_uri", `${BASE_URL}/slack/callback`);
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

// ── Slack OAuth: Callback ──
app.get("/slack/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    console.error("❌ Slack OAuth error:", error);
    return res.redirect(`${BASE_URL}/?error=slack_auth_failed`);
  }

  if (!code) {
    return res.redirect(`${BASE_URL}/?error=no_code`);
  }

  try {
    // Exchange code for token
    const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: SLACK_CLIENT_ID,
        client_secret: SLACK_CLIENT_SECRET,
        code,
        redirect_uri: `${BASE_URL}/slack/callback`,
      }),
    });

    const data = await tokenRes.json();
    if (!data.ok) {
      console.error("❌ Slack token exchange failed:", data.error);
      return res.redirect(`${BASE_URL}/?error=token_exchange_failed`);
    }

    const teamId = data.team.id;
    const teamName = data.team.name;
    const botToken = data.access_token;
    const installedBy = data.authed_user?.id;

    console.log(`✅ Slack OAuth success: team=${teamName} (${teamId})`);

    // Check if tenant already exists
    const existing = getTenant(teamId);
    if (existing) {
      // Update bot token (may have been re-installed)
      upsertTenant(teamId, { bot_token: botToken, installed_by: installedBy });
    } else {
      // Create new tenant record
      // Provisioning of OpenClaw Gateway will be triggered separately
      // For MVP, new tenants share the demo gateway
      const tenantId = `t-${teamId.toLowerCase()}`;
      upsertTenant(teamId, {
        tenant_id: tenantId,
        team_id: teamId,
        team_name: teamName,
        bot_token: botToken,
        gateway_url: process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:3801",
        gateway_token: process.env.OPENCLAW_GATEWAY_TOKEN || "demo-token-001",
        gateway_port: null, // Set after provisioning
        plan: "free",
        status: "active",
        stripe_customer_id: null,
        stripe_subscription_id: null,
        total_messages: 0,
        installed_by: installedBy,
      });

      console.log(`🆕 New tenant created: ${tenantId} for team ${teamName}`);

      // TODO: Trigger auto-provisioning of dedicated OpenClaw Gateway
      // For now, all tenants share the demo gateway
      // In production: spawn create-tenant.sh via SSH or queue
    }

    // Redirect to success page
    res.redirect(`${BASE_URL}/slack/success?team=${encodeURIComponent(teamName)}`);
  } catch (err) {
    console.error("❌ OAuth callback error:", err);
    res.redirect(`${BASE_URL}/?error=internal`);
  }
});

// ── Slack OAuth success page ──
app.get("/slack/success", (req, res) => {
  const teamName = req.query.team || "あなたのワークスペース";
  res.send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>インストール完了 — たすく</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f6f3ed;margin:0}
.card{text-align:center;padding:60px 40px;max-width:500px;background:#fff;border:1px solid #d4cfc5}
h1{font-size:2rem;margin-bottom:16px}p{color:#666;line-height:1.8;margin-bottom:24px}
a{color:#c4532a;font-weight:bold}</style></head>
<body><div class="card">
<h1>🎉 インストール完了！</h1>
<p><strong>${teamName}</strong> に「たすく」が追加されました。<br><br>
Slack で <code>@たすく</code> と話しかけてみてください。<br>
まずは無料で10回お試しいただけます。</p>
<a href="https://slack.com/app">Slack を開く →</a>
</div></body></html>`);
});

// ── Billing: Customer Portal redirect ──
app.get("/billing/:teamId", async (req, res) => {
  try {
    const url = await createPortalSession(req.params.teamId);
    if (!url) {
      return res.status(404).json({ error: "No billing info found" });
    }
    res.redirect(url);
  } catch (err) {
    console.error("❌ Portal session error:", err.message);
    res.status(500).json({ error: "Failed to create portal session" });
  }
});

// ── Billing success/cancel pages ──
app.get("/billing/success", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>お支払い完了 — たすく</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f6f3ed;margin:0}
.card{text-align:center;padding:60px 40px;max-width:500px;background:#fff;border:1px solid #d4cfc5}
h1{font-size:2rem;margin-bottom:16px}p{color:#666;line-height:1.8}</style></head>
<body><div class="card">
<h1>✅ ありがとうございます！</h1>
<p>プランが有効になりました。3日間の無料トライアルが開始されます。<br><br>
Slack で引き続き「たすく」をご利用ください。</p>
</div></body></html>`);
});

app.get("/billing/cancel", (req, res) => {
  res.redirect(BASE_URL);
});

/** Start API server */
export function startApiServer() {
  app.listen(PORT, () => {
    console.log(`🌐 API server running on port ${PORT}`);
  });
}
