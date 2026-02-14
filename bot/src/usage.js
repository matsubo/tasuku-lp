/**
 * 使用量管理（multi-tenant対応）
 *
 * Free tier: 10 total messages per workspace (lifetime)
 * Paid plans: 100 msg/day per user, 3000/month per workspace
 */
import { getTenant, updateTenant } from "./tenants.js";

const FREE_TOTAL_LIMIT = 10;
const DAILY_LIMIT_PER_USER = 100;
const MONTHLY_LIMIT_PER_WORKSPACE = 3000;

// In-memory counters (resets on restart for paid tiers — acceptable for MVP)
const dailyCounts = new Map();   // "teamId:userId:YYYY-MM-DD" → count
const monthlyCounts = new Map(); // "teamId:YYYY-MM" → count

function todayKey(teamId, userId) {
  return `${teamId}:${userId}:${new Date().toISOString().slice(0, 10)}`;
}
function monthKey(teamId) {
  return `${teamId}:${new Date().toISOString().slice(0, 7)}`;
}

/**
 * Check if user can send a message.
 * Returns { allowed: boolean, reason?: string }
 */
export async function checkUsage(teamId, userId) {
  const tenant = getTenant(teamId);

  // No tenant record yet — treat as free with 0 messages
  const plan = tenant?.plan || "free";
  const totalMessages = tenant?.total_messages || 0;

  if (plan === "free") {
    if (totalMessages >= FREE_TOTAL_LIMIT) {
      return { allowed: false, reason: "free_limit" };
    }
    return { allowed: true };
  }

  // Paid plan checks
  if (tenant?.status !== "active") {
    return { allowed: false, reason: "suspended" };
  }

  const dk = todayKey(teamId, userId);
  const mk = monthKey(teamId);
  const daily = dailyCounts.get(dk) || 0;
  const monthly = monthlyCounts.get(mk) || 0;

  if (daily >= DAILY_LIMIT_PER_USER) {
    return { allowed: false, reason: "daily_limit" };
  }
  if (monthly >= MONTHLY_LIMIT_PER_WORKSPACE) {
    return { allowed: false, reason: "monthly_limit" };
  }

  return { allowed: true };
}

/**
 * Increment usage counters after successful response
 */
export async function incrementUsage(teamId, userId) {
  const tenant = getTenant(teamId);
  const plan = tenant?.plan || "free";

  // Always increment total_messages (for free tier tracking)
  const newTotal = (tenant?.total_messages || 0) + 1;
  if (tenant) {
    updateTenant(teamId, { total_messages: newTotal });
  }

  // Increment daily/monthly for paid plans
  if (plan !== "free") {
    const dk = todayKey(teamId, userId);
    const mk = monthKey(teamId);
    dailyCounts.set(dk, (dailyCounts.get(dk) || 0) + 1);
    monthlyCounts.set(mk, (monthlyCounts.get(mk) || 0) + 1);
  }
}

/**
 * Get usage stats for a workspace
 */
export async function getUsage(teamId, userId) {
  const tenant = getTenant(teamId);
  const plan = tenant?.plan || "free";

  if (plan === "free") {
    return {
      plan: "free",
      total: tenant?.total_messages || 0,
      totalLimit: FREE_TOTAL_LIMIT,
    };
  }

  return {
    plan,
    daily: dailyCounts.get(todayKey(teamId, userId)) || 0,
    dailyLimit: DAILY_LIMIT_PER_USER,
    monthly: monthlyCounts.get(monthKey(teamId)) || 0,
    monthlyLimit: MONTHLY_LIMIT_PER_WORKSPACE,
  };
}
