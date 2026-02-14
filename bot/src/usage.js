/**
 * 使用量管理（MVP版: インメモリ）
 * TODO: Redis/DBに置き換え
 */

const DAILY_LIMIT = 100;
const MONTHLY_LIMIT = 3000;

// インメモリストア（MVP用）
const dailyCounts = new Map();  // "teamId:userId:YYYY-MM-DD" → count
const monthlyCounts = new Map(); // "teamId:userId:YYYY-MM" → count

function todayKey(teamId, userId) {
  return `${teamId}:${userId}:${new Date().toISOString().slice(0, 10)}`;
}

function monthKey(teamId, userId) {
  return `${teamId}:${userId}:${new Date().toISOString().slice(0, 7)}`;
}

export async function checkUsage(teamId, userId) {
  const dk = todayKey(teamId, userId);
  const mk = monthKey(teamId, userId);
  const daily = dailyCounts.get(dk) || 0;
  const monthly = monthlyCounts.get(mk) || 0;
  return daily < DAILY_LIMIT && monthly < MONTHLY_LIMIT;
}

export async function incrementUsage(teamId, userId) {
  const dk = todayKey(teamId, userId);
  const mk = monthKey(teamId, userId);
  dailyCounts.set(dk, (dailyCounts.get(dk) || 0) + 1);
  monthlyCounts.set(mk, (monthlyCounts.get(mk) || 0) + 1);
}

export async function getUsage(teamId, userId) {
  return {
    daily: dailyCounts.get(todayKey(teamId, userId)) || 0,
    monthly: monthlyCounts.get(monthKey(teamId, userId)) || 0,
    dailyLimit: DAILY_LIMIT,
    monthlyLimit: MONTHLY_LIMIT,
  };
}
