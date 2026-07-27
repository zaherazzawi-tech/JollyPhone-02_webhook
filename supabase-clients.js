// ============================================================
// supabase-clients.js
// Drop next to vapi-intake-webhook.js in 02_webhook.
//
// Replaces the hardcoded CLIENTS registry with a database lookup,
// so adding a client no longer needs a code change and a deploy.
//
// RESILIENCE, in order of preference:
//   1. in-memory cache (60s)      — no network on most calls
//   2. Supabase clients table     — the source of truth
//   3. last known good cache      — even if expired, when the DB is down
//   4. the hardcoded FALLBACK map — if the DB has never answered
//   5. null -> caller uses its own default inbox
//
// A database outage must never lose an intake. It degrades to the
// old behaviour instead.
// ============================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let sb = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

// Safety net only. New clients go in the database, not here.
const FALLBACK = {
  // azzawi: { name: 'Azzawi & Associates', email_to: '...', slackEnv: 'SLACK_AZZAWI' }
};

const TTL_MS = 60 * 1000;
const cache = new Map();   // client_id -> { row, at }

function fromCache(clientId, allowStale) {
  const hit = cache.get(clientId);
  if (!hit) return null;
  if (!allowStale && Date.now() - hit.at > TTL_MS) return null;
  return hit.row;
}

/**
 * Resolve a client's delivery config.
 * @param {string} clientId
 * @returns {Promise<object|null>} { id, name, email_to, slack_webhook_url, agent_type, timezone, status }
 *                                 or null when unknown. Never throws.
 */
export async function getClient(clientId) {
  if (!clientId) return null;
  const id = String(clientId).trim();
  if (!id) return null;

  const fresh = fromCache(id, false);
  if (fresh !== null) return fresh;

  if (sb) {
    try {
      const { data, error } = await sb
        .from('clients')
        .select('id,name,email_to,slack_webhook_url,agent_type,timezone,status')
        .eq('id', id)
        .maybeSingle();

      if (!error) {
        // Cache misses too, so a bad client_id doesn't hammer the DB every call.
        cache.set(id, { row: data || null, at: Date.now() });
        if (data && data.status && data.status !== 'active') {
          console.warn(`[clients] '${id}' is status=${data.status} — still delivering`);
        }
        return data || FALLBACK[id] || null;
      }
      console.error('[clients] lookup failed:', error.message);
    } catch (err) {
      console.error('[clients] lookup threw:', err.message);
    }
  }

  // DB unreachable — prefer a stale-but-real answer over nothing.
  const stale = fromCache(id, true);
  if (stale) {
    console.warn(`[clients] using stale cache for '${id}'`);
    return stale;
  }

  if (FALLBACK[id]) {
    console.warn(`[clients] using hardcoded fallback for '${id}'`);
    return FALLBACK[id];
  }

  return null;
}

/**
 * Slack URL for a client. Prefers the database, falls back to a
 * per-client env var so existing SLACK_* secrets keep working.
 */
export function slackUrlFor(client, clientId) {
  if (client && client.slack_webhook_url) return client.slack_webhook_url;
  if (clientId) {
    const envName = 'SLACK_' + String(clientId).toUpperCase().replace(/[^A-Z0-9]/g, '_');
    if (process.env[envName]) return process.env[envName];
  }
  return process.env.SLACK_WEBHOOK_URL || null;
}

/** Called by the admin endpoint after creating a client, so routing is instant. */
export function invalidate(clientId) {
  if (clientId) cache.delete(String(clientId).trim());
  else cache.clear();
}
