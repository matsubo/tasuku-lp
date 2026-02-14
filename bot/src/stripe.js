import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// TODO: 実際のprice IDに置き換え
const PRICE_ID = "price_ai_hisho_standard_monthly";

/**
 * Stripe Checkout Sessionを作成
 */
export async function createCheckoutSession(teamId, email) {
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: PRICE_ID, quantity: 1 }],
    success_url: "https://ai-hisho.teraren.com/success?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "https://ai-hisho.teraren.com/",
    client_reference_id: teamId,
    customer_email: email,
    metadata: { teamId },
  });
  return session.url;
}

/**
 * Stripe Webhookハンドラ
 */
export async function handleWebhook(rawBody, signature) {
  const event = stripe.webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const teamId = session.metadata.teamId;
      console.log(`✅ New subscription for team: ${teamId}`);
      // TODO: DBにテナント作成 & ステータス更新
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object;
      console.log(`❌ Subscription canceled: ${sub.id}`);
      // TODO: テナントを無効化
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      console.log(`⚠️ Payment failed: ${invoice.id}`);
      // TODO: ユーザーに通知
      break;
    }
  }

  return { received: true };
}
