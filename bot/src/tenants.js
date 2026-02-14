/**
 * テナント管理 (JSON file-based MVP)
 * slack_team_id → tenant config mapping
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const DATA_DIR = process.env.DATA_DIR || "/data";
const TENANTS_FILE = `${DATA_DIR}/tenants.json`;

// In-memory cache
let tenants = {};

/** Load tenants from disk */
export function loadTenants() {
  try {
    if (existsSync(TENANTS_FILE)) {
      tenants = JSON.parse(readFileSync(TENANTS_FILE, "utf-8"));
    }
  } catch (err) {
    console.error("⚠️ Failed to load tenants:", err.message);
    tenants = {};
  }
  console.log(`📋 Loaded ${Object.keys(tenants).length} tenants`);
  return tenants;
}

/** Save tenants to disk */
function saveTenants() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TENANTS_FILE, JSON.stringify(tenants, null, 2));
  } catch (err) {
    console.error("⚠️ Failed to save tenants:", err.message);
  }
}

/**
 * Get tenant by Slack team_id
 * @param {string} teamId
 * @returns {object|null}
 */
export function getTenant(teamId) {
  return tenants[teamId] || null;
}

/**
 * Create or update a tenant
 * @param {string} teamId - Slack team_id
 * @param {object} data - Tenant data
 */
export function upsertTenant(teamId, data) {
  tenants[teamId] = {
    ...tenants[teamId],
    ...data,
    updated_at: new Date().toISOString(),
  };
  if (!tenants[teamId].created_at) {
    tenants[teamId].created_at = new Date().toISOString();
  }
  saveTenants();
  return tenants[teamId];
}

/**
 * Update specific fields on a tenant
 */
export function updateTenant(teamId, fields) {
  if (!tenants[teamId]) return null;
  Object.assign(tenants[teamId], fields, { updated_at: new Date().toISOString() });
  saveTenants();
  return tenants[teamId];
}

/**
 * List all tenants
 */
export function listTenants() {
  return { ...tenants };
}

/**
 * Tenant data shape:
 * {
 *   tenant_id: string,        // unique id (e.g. "t-abc123")
 *   team_id: string,          // Slack team_id
 *   team_name: string,        // Slack workspace name
 *   gateway_url: string,      // OpenClaw Gateway URL
 *   gateway_token: string,    // Gateway auth token
 *   gateway_port: number,     // Port number
 *   bot_token: string,        // Slack bot token for this workspace
 *   plan: "free"|"solo"|"team"|"business",
 *   status: "active"|"suspended"|"canceled",
 *   stripe_customer_id: string|null,
 *   stripe_subscription_id: string|null,
 *   total_messages: number,   // lifetime message count (for free tier)
 *   installed_by: string,     // Slack user_id who installed
 *   created_at: string,
 *   updated_at: string,
 * }
 */
