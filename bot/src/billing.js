/**
 * Stripe 課金管理
 */
import Stripe from "stripe";
import { getTenant, updateTenant } from "./tenants.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Price IDs (set in .env or Stripe dashboard)
const PRICES = {
  solo: process.env.STRIPE_PRICE_SOLO,
  team: process.env.STRIPE_PRICE_TEAM,
  business: process.env.STRIPE_PRICE_BUSINESS,
};

const BASE_URL = process.env.BASE_URL || "https://ai-hisho.teraren.com";

/**
 * Create a Stripe Checkout session with 3-day free trial
 */
export async function createCheckoutSession(teamId, plan = "solo") {
  const priceId = PRICES[plan];
  if (!priceId) throw new Error(`Unknown plan: ${plan}`);

  const tenant = getTenant(teamId);
  const metadata = { team_id: teamId, plan };

  const params = {
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: 3,
      metadata,
    },
    success_url: `${BASE_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE_URL}/billing/cancel`,
    client_reference_id: teamId,
    metadata,
  };

  // Reuse existing Stripe customer if available
  if (tenant?.stripe_customer_id) {
    params.customer = tenant.stripe_customer_id;
  }

  const session = await stripe.checkout.sessions.create(params);
  return session.url;
}

/**
 * Generate upgrade message with checkout URLs for all plans
 */
export async function getUpgradeMessage(teamId) {
  const urls = {};
  for (const plan of ["solo", "team", "business"]) {
    try {
      urls[plan] = await createCheckoutSession(teamId, plan);
    } catch (err) {
      console.error(`Failed to create checkout for ${plan}:`, err.message);
    }
  }

  return (
    `🎉 無料トライアル（10回）をご利用いただきありがとうございます！\n\n` +
    `継続してご利用いただくには、プランをお選びください：\n\n` +
    `📌 *Solo* — ¥10,000/月（1ユーザー、100メッセージ/日）\n` +
    (urls.solo ? `→ <${urls.solo}|プランを選択>\n\n` : "\n") +
    `👥 *Team* — ¥25,000/月（3ユーザー、100メッセージ/日/人）\n` +
    (urls.team ? `→ <${urls.team}|プランを選択>\n\n` : "\n") +
    `🏢 *Business* — ¥40,000/月（5ユーザー、100メッセージ/日/人）\n` +
    (urls.business ? `→ <${urls.business}|プランを選択>\n\n` : "\n") +
    `すべてのプランに *3日間の無料トライアル* 付き。\n` +
    `ご質問は support@teraren.com まで 🙏`
  );
}

/**
 * Handle Stripe webhook events
 */
export async function handleStripeWebhook(rawBody, signature) {
  const event = stripe.webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );

  console.log(`🔔 Stripe webhook: ${event.type}`);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const teamId = session.metadata?.team_id || session.client_reference_id;
      if (teamId) {
        updateTenant(teamId, {
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          plan: session.metadata?.plan || "solo",
          status: "active",
        });
        console.log(`✅ Subscription activated for team ${teamId}`);
      }
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object;
      const teamId = sub.metadata?.team_id;
      if (teamId) {
        const status = sub.status === "active" || sub.status === "trialing" ? "active" : "suspended";
        updateTenant(teamId, { status });
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const teamId = sub.metadata?.team_id;
      if (teamId) {
        updateTenant(teamId, {
          plan: "free",
          status: "canceled",
          stripe_subscription_id: null,
        });
        console.log(`❌ Subscription canceled for team ${teamId}`);
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      console.log(`⚠️ Payment failed: ${invoice.id}`);
      // Could notify team via Slack bot here
      break;
    }
  }

  return { received: true };
}

/**
 * Create Stripe Customer Portal session
 */
export async function createPortalSession(teamId) {
  const tenant = getTenant(teamId);
  if (!tenant?.stripe_customer_id) return null;

  const session = await stripe.billingPortal.sessions.create({
    customer: tenant.stripe_customer_id,
    return_url: BASE_URL,
  });
  return session.url;
}
