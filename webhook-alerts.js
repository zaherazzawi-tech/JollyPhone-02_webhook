// ============================================================
// webhook-alerts.js
// Drop next to vapi-intake-webhook.js in 02_webhook.
//
// One job: when anything in the delivery chain fails (email send,
// Slack post, database store, unrecognized payload), tell the OWNER
// immediately — so a lost intake is never silent.
//
// Design rules:
//   - never throws (an alert failure must not break call handling)
//   - rate-limited per failure type (max 1 alert per 10 min per key,
//     so an outage sends one alert, not five hundred)
//   - tries email first (Resend), then owner Slack as fallback
//   - if both channels are down, logs loudly and gives up
//
// Env (Railway):
//   RESEND_API_KEY      (already set)
//   ALERT_EMAIL_TO      where alerts go — falls back to INTAKE_EMAIL_TO
//   INTAKE_EMAIL_FROM   (already set) used as the sender
//   SLACK_WEBHOOK_URL   (already set) fallback channel
// ============================================================

const RESEND_KEY = process.env.RESEND_API_KEY;
const ALERT_TO   = process.env.ALERT_EMAIL_TO || process.env.INTAKE_EMAIL_TO;
const ALERT_FROM = process.env.INTAKE_EMAIL_FROM || 'Jolly Phone <calls@jollyphone.com>';
const SLACK_URL  = process.env.SLACK_WEBHOOK_URL;

const WINDOW_MS = 10 * 60 * 1000;
const lastSent = new Map();   // key -> timestamp

function throttled(key) {
  const prev = lastSent.get(key) || 0;
  if (Date.now() - prev < WINDOW_MS) return true;
  lastSent.set(key, Date.now());
  return false;
}

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

/**
 * Alert the owner that part of call delivery failed.
 * Fire-and-forget; never throws; safe to call from any catch block.
 *
 * @param {string} kind    short machine key, e.g. 'email_failed', 'store_failed'
 * @param {object} info    { clientId, callId, error, note } — all optional
 */
export async function alertOwner(kind, info = {}) {
  try {
    const key = `${kind}:${info.clientId || 'unknown'}`;
    console.error(`[alert] ${key}`, info.error || info.note || '');
    if (throttled(key)) return;

    const subject = `⚠️ Jolly Phone: ${kind.replace(/_/g, ' ')}` +
      (info.clientId ? ` — ${info.clientId}` : '');
    const lines = [
      `<b>What failed:</b> ${escapeHtml(kind)}`,
      info.clientId ? `<b>Client:</b> ${escapeHtml(info.clientId)}` : null,
      info.callId ? `<b>Vapi call:</b> ${escapeHtml(info.callId)}` : null,
      info.error ? `<b>Error:</b> <code>${escapeHtml(String(info.error).slice(0, 500))}</code>` : null,
      info.note ? `<b>Note:</b> ${escapeHtml(info.note)}` : null,
      `<b>When:</b> ${new Date().toISOString()}`,
      `<br/>Check Railway logs for the full picture. If this was an email failure, ` +
      `the intake may still be in Supabase and on the client's dashboard.`
    ].filter(Boolean);

    let emailed = false;
    if (RESEND_KEY && ALERT_TO) {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: ALERT_FROM,
            to: [ALERT_TO],
            subject,
            html: `<div style="font-family:sans-serif;line-height:1.6">
              <div style="background:#b3261e;color:#fff;padding:10px 14px;border-radius:8px 8px 0 0;font-weight:700">
                DELIVERY PROBLEM</div>
              <div style="border:1px solid #ddd;border-top:0;padding:14px;border-radius:0 0 8px 8px">
                ${lines.join('<br/>')}
              </div></div>`
          })
        });
        emailed = res.ok;
        if (!res.ok) console.error('[alert] resend refused:', res.status, await res.text().catch(()=> ''));
      } catch (e) { console.error('[alert] email send threw:', e.message); }
    }

    if (!emailed && SLACK_URL) {
      try {
        await fetch(SLACK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `:warning: *Jolly Phone delivery problem* — ${kind}` +
              (info.clientId ? ` (client: ${info.clientId})` : '') +
              (info.error ? `\n\`${String(info.error).slice(0, 300)}\`` : '') +
              `\nCheck Railway logs.`
          })
        });
      } catch (e) { console.error('[alert] slack fallback threw:', e.message); }
    }
  } catch (e) {
    // Alerts must never take the webhook down with them.
    console.error('[alert] alertOwner itself failed:', e.message);
  }
}
