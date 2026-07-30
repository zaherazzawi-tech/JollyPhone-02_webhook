// ============================================================
// supabase-store.js
// Drop this file next to vapi-intake-webhook.js in the Law_firm repo.
//
// PRINCIPLE: this is ADDITIVE. If Supabase is down, slow, or
// misconfigured, email and Slack must still go out. Every failure
// in here is caught and logged, never thrown.
// ============================================================

import { createClient } from '@supabase/supabase-js';
import { alertOwner } from './webhook-alerts.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  console.log('[supabase] client ready');
} else {
  console.warn('[supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — storage disabled');
}

function pick(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

function toISO(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Store one completed call.
 *
 * @param {object} opts
 * @param {object} opts.message    - the Vapi message object (body.message)
 * @param {object} opts.data       - the extracted structured output result
 * @param {string} opts.clientId   - resolved client_id
 * @param {string} opts.agentType  - 'immigration' | 'general' | 'unknown'
 * @returns {Promise<boolean>} true if stored, false otherwise. Never throws.
 */
export async function storeCall({ message = {}, data = {}, clientId, agentType = 'unknown' }) {
  if (!supabase) return false;

  if (!clientId) {
    console.warn('[supabase] no client_id — skipping insert');
    return false;
  }

  try {
    const call = message.call || {};
    const artifact = message.artifact || {};

    const isImmigration = agentType === 'immigration';

    const row = {
      client_id: clientId,
      vapi_call_id: pick(call.id, message.id),

      started_at: toISO(pick(message.startedAt, call.startedAt, call.createdAt)),
      ended_at: toISO(pick(message.endedAt, call.endedAt)),
      duration_seconds: pick(message.durationSeconds, message.duration) || null,

      caller_name: pick(data.caller_name, data.name),
      callback_number: pick(data.callback_number, data.phone, call.customer && call.customer.number),

      // reason/details/summary differ per agent shape
      reason: isImmigration
        ? pick(data.matter_type, data.reason)
        : pick(data.reason, data.matter_type),
      details: isImmigration
        ? pick(data.matter_summary, data.details)
        : pick(data.details, data.matter_summary),
      summary: pick(data.summary, data.matter_summary, data.final_note),

      urgency: pick(data.urgency),
      call_language: pick(data.call_language, data.language),
      agent_type: agentType,

      recording_url: pick(
        message.recordingUrl,
        message.stereoRecordingUrl,
        artifact.recordingUrl
      ),
      transcript: pick(message.transcript, artifact.transcript),

      // everything, verbatim — nothing is ever lost
      raw: data || {}
    };

    // Idempotent: Vapi retries webhooks. Without this you get duplicates.
    const { error } = await supabase
      .from('calls')
      .upsert(row, { onConflict: 'vapi_call_id', ignoreDuplicates: true });

    if (error) {
      console.error('[supabase] insert failed:', error.message);
      alertOwner('store_failed', {
        clientId,
        callId: row.vapi_call_id,
        error: error.message
      }).catch(() => {});
      return false;
    }

    console.log(`[supabase] stored call ${row.vapi_call_id} for ${clientId}`);
    return true;

  } catch (err) {
    console.error('[supabase] unexpected error:', err.message);
    alertOwner('store_failed', {
      clientId,
      callId: (message.call && message.call.id) || message.id || null,
      error: err.message
    }).catch(() => {});
    return false;
  }
}
