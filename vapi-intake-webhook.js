// Vapi intake webhook v2 — handles BOTH agent types, routes by client.
//   • Immigration agent  (fields: matter_type, matter_summary, detained, ...)
//   • General/Demo agents (fields: reason, summary, call_language, ...)
// Reads a `client_id` from the call and sends results to THAT client's
// email + Slack (looked up in Supabase — see ./supabase-clients.js).
// One webhook serves every client.
//
// Deploy to Railway/Render, paste public URL + /vapi-intake into each
// assistant's Server URL. Env vars:
//   RESEND_API_KEY, INTAKE_EMAIL_FROM   (shared — the sender)
//   VAPI_SECRET                         (optional shared secret)
//   INTAKE_EMAIL_TO, SLACK_WEBHOOK_URL  (fallback if a client has no entry below)

import express from "express";
import { storeCall } from "./supabase-store.js";
import { getClient, slackUrlFor } from "./supabase-clients.js";
import { alertOwner } from "./webhook-alerts.js";
import { createCloverOrder, cloverStatusHtml, cloverStatusSlack } from "./clover.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const {
  RESEND_API_KEY,
  INTAKE_EMAIL_FROM,
  VAPI_SECRET,
  INTAKE_EMAIL_TO,      // fallback destination
  SLACK_WEBHOOK_URL,    // fallback destination
} = process.env;

// ─────────────────────────────────────────────────────────────
// CLIENT REGISTRY — SUPERSEDED by the `clients` table in Supabase.
// Routing now goes through getClient() in ./supabase-clients.js.
// Kept here, unused, as a reference for the old destinations.
// Add new clients to the database, not to this object.
// ─────────────────────────────────────────────────────────────
const CLIENTS = {
  azzawi: {
    name: "Azzawi & Associates",
    emailTo: "intake@azzawilaw.com",
    slack: process.env.SLACK_AZZAWI || SLACK_WEBHOOK_URL,
  },
  demo: {
    name: "Jolly Phone Demo",
    emailTo: process.env.DEMO_EMAIL_TO || INTAKE_EMAIL_TO,
    slack: process.env.SLACK_DEMO || SLACK_WEBHOOK_URL,
  },
  // parkdental: { name: "Park Dental", emailTo: "front@parkdental.com", slack: process.env.SLACK_PARKDENTAL },
};

// Resolve a client_id (sent from Vapi) to its destination, with a safe fallback.
// Looks the client up in Supabase; getClient() never throws and degrades through
// its own cache/fallback layers, so a DB outage can't lose an intake.
async function resolveClient(clientId) {
  const c = await getClient(clientId);
  if (c) {
    return {
      name: c.name || clientId,
      emailTo: c.email_to || INTAKE_EMAIL_TO,
      slack: slackUrlFor(c, clientId),
    };
  }
  // Unknown / missing client_id → fall back to your own inbox so nothing is lost.
  alertOwner("unknown_client", { clientId, note: "fell back to default inbox" }).catch(() => {});
  return { name: clientId || "Unrouted", emailTo: INTAKE_EMAIL_TO, slack: slackUrlFor(null, clientId) };
}

const MATTER_LABELS = {
  family_based: "Family-based",
  employment: "Employment-based",
  removal_defense: "Removal / Deportation Defense",
  asylum: "Asylum / Humanitarian",
  naturalization: "Naturalization / Citizenship",
  adjustment: "Green Card / Adjustment of Status",
  other: "Other",
};

app.post("/vapi-intake", async (req, res) => {
  // Hoisted out of the try so the catch below can attribute a crash to a call.
  let clientId = null;
  let callId = null;

  try {
    if (VAPI_SECRET && req.headers["x-vapi-secret"] !== VAPI_SECRET) {
      return res.status(401).send("unauthorized");
    }

    const message = req.body?.message ?? req.body;
    if (message?.type !== "end-of-call-report") {
      return res.status(200).send("ignored");
    }

    const data = extractData(message);
    const recordingUrl =
      message?.recordingUrl ?? message?.artifact?.recordingUrl ?? "";
    const transcript =
      message?.transcript ?? message?.artifact?.transcript ?? "";
    const assistantName =
      message?.assistant?.name ?? message?.call?.assistantId ?? "";
    callId = message?.call?.id ?? message?.id ?? null;

    // ---- which client is this? ----
    // Set `client_id` as assistant metadata / a variable value in Vapi.
    // We look in the common places Vapi surfaces it.
    const payloadClientId =
      message?.assistant?.metadata?.client_id ??
      message?.call?.assistantOverrides?.variableValues?.client_id ??
      message?.assistant?.variableValues?.client_id ??
      data.client_id ??
      null;

    // Fallback: ?client_id=... on the Server URL, for assistants that can't
    // set metadata. Payload always wins; blank/whitespace counts as missing.
    const cleanId = (v) => {
      const s = Array.isArray(v) ? v[0] : v;
      return s == null ? "" : String(s).trim();
    };
    const fromPayload = cleanId(payloadClientId);
    const fromQuery = cleanId(req.query?.client_id);
    clientId = fromPayload || fromQuery || null;

    console.log(
      clientId
        ? `[client] resolved '${clientId}' from ${fromPayload ? "payload" : "query"}`
        : "[client] no client_id in payload or query — using fallback destination"
    );

    const client = await resolveClient(clientId);

    // ---- which agent type sent this ----
    // Order payloads carry `summary` too, so they must be checked BEFORE
    // the general branch or they'd be misfiled as ordinary calls.
    const kind = data.matter_type || data.matter_summary ? "immigration"
               : Array.isArray(data.order_items) || data.order_confirmed !== undefined ? "order"
               : data.reason || data.summary ? "general"
               : "unknown";

    if (kind === "unknown") {
      alertOwner("unrecognized_payload", { clientId, callId }).catch(() => {});
    }

    // Push to the POS before notifying, so the email can report what happened.
    // createCloverOrder never throws and refuses rather than guessing.
    let cloverResult = null;
    if (kind === "order") {
      cloverResult = await createCloverOrder(clientId, data);
      if (!cloverResult.ok) {
        alertOwner("clover_not_sent", { clientId, callId, reason: cloverResult.reason }).catch(() => {});
      }
    }

    // An order that didn't reach the POS needs a human now — treat it as urgent.
    const isUrgent =
      String(data.urgency || "").toUpperCase() === "URGENT" ||
      (kind === "order" && cloverResult && !cloverResult.ok);

    const [slackResult, emailResult] = await Promise.allSettled([
      sendSlack({ client, kind, data, isUrgent, recordingUrl, assistantName, cloverResult }),
      sendEmail({ client, kind, data, isUrgent, recordingUrl, transcript, assistantName, cloverResult }),
    ]);

    // allSettled already swallowed these — alert, but never fail the request.
    if (slackResult.status === "rejected") {
      alertOwner("slack_failed", { clientId, callId, error: slackResult.reason }).catch(() => {});
    }
    if (emailResult.status === "rejected") {
      alertOwner("email_failed", { clientId, callId, error: emailResult.reason }).catch(() => {});
    }

    // Additive: persist the call. Never throws; email/Slack above are unaffected.
    await storeCall({ message, data, clientId, agentType: kind });

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook error:", err);
    alertOwner("webhook_error", { clientId, callId, error: err }).catch(() => {});
    return res.status(200).send("error-logged");
  }
});

function extractData(msg) {
  const so =
    msg?.artifact?.structuredOutputs ??
    msg?.structuredOutputs ??
    msg?.analysis?.structuredOutputs;
  if (so && typeof so === "object") {
    const first = Object.values(so)[0];
    if (first?.result) return first.result;
  }
  return msg?.analysis?.structuredData ?? msg?.structuredData ?? {};
}

/* ============================ SLACK ============================ */

// "2x Gyro Plate — no onions" per line, for Slack/email order listings.
function orderItemLines(data) {
  return (data.order_items || []).map((i) => {
    const mods = (i.modifiers || []).join(", ");
    const size = i.size ? ` (${i.size})` : "";
    return `${i.quantity || 1}x ${i.item_name || "—"}${size}${mods ? ` — ${mods}` : ""}`;
  });
}

async function sendSlack({ client, kind, data, isUrgent, recordingUrl, assistantName, cloverResult }) {
  const slackUrl = client?.slack;
  if (!slackUrl) return;

  let lines;
  if (kind === "immigration") {
    const matter = MATTER_LABELS[data.matter_type] || data.matter_type || "Unknown";
    lines = [
      isUrgent ? ":rotating_light: *URGENT INTAKE* :rotating_light:" : ":inbox_tray: New intake",
      `*Name:* ${data.caller_name || "—"}`,
      `*Callback:* ${data.callback_number || "—"}`,
      `*Matter:* ${matter}`,
      data.detained ? "*Detained:* YES" : null,
      data.alien_number ? `*A-number:* ${data.alien_number}` : null,
      data.hearing_or_deadline_date ? `*Hearing/Deadline:* ${data.hearing_or_deadline_date}` : null,
      data.existing_client ? "*Existing client*" : "*New matter*",
      "",
      `*Summary:* ${data.matter_summary || "—"}`,
      recordingUrl ? `<${recordingUrl}|Listen to recording>` : null,
    ];
  } else if (kind === "order") {
    const items = orderItemLines(data);
    lines = [
      cloverResult && !cloverResult.ok
        ? ":rotating_light: *ORDER NEEDS MANUAL ENTRY* :rotating_light:"
        : ":shallow_pan_of_food: New order",
      `*Name:* ${data.caller_name || "—"}`,
      `*Callback:* ${data.callback_number || "—"}`,
      `*Type:* ${data.order_type || "pickup"}${data.pickup_time_minutes ? ` — ~${data.pickup_time_minutes} min` : ""}`,
      "",
      items.length ? items.map((l) => `• ${l}`).join("\n") : "_no items captured_",
      data.order_total ? `*Quoted total:* $${Number(data.order_total).toFixed(2)}` : null,
      data.special_instructions ? `*Kitchen notes:* ${data.special_instructions}` : null,
      (data.unmatched_requests || []).length
        ? `:warning: *Unmatched:* ${data.unmatched_requests.join(", ")}`
        : null,
      data.order_confirmed === false ? ":warning: *Caller never confirmed the read-back*" : null,
      "",
      cloverStatusSlack(cloverResult),
      recordingUrl ? `<${recordingUrl}|Listen to recording>` : null,
    ];
  } else if (kind === "general") {
    lines = [
      isUrgent ? ":rotating_light: *URGENT — new call* :rotating_light:" : ":telephone_receiver: New call",
      assistantName ? `*Agent:* ${assistantName}` : null,
      `*Name:* ${data.caller_name || "—"}`,
      `*Callback:* ${data.callback_number || "—"}`,
      `*Reason:* ${data.reason || "—"}`,
      data.call_language && data.call_language.toLowerCase() !== "english"
        ? `*Language:* ${data.call_language}` : null,
      "",
      `*Summary:* ${data.summary || "—"}`,
      recordingUrl ? `<${recordingUrl}|Listen to recording>` : null,
    ];
  } else {
    lines = [
      ":grey_question: Call received — unrecognized data shape",
      assistantName ? `*Agent:* ${assistantName}` : null,
      "```" + JSON.stringify(data, null, 2).slice(0, 1500) + "```",
      recordingUrl ? `<${recordingUrl}|Listen to recording>` : null,
    ];
  }

  const payload = {
    text: isUrgent ? "<!here> 🚨 URGENT" : "New call",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: lines.filter(Boolean).join("\n") } }],
  };

  const resp = await fetch(slackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  // A dropped Slack post answers non-2xx rather than throwing. Surface it so
  // the caller can alert; Promise.allSettled above keeps it off the request path.
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`slack ${resp.status} ${body}`.trim());
  }
}

/* ============================ EMAIL ============================ */

const row = (label, val) =>
  val
    ? `<tr><td style="padding:4px 12px 4px 0;color:#666;">${label}</td><td style="padding:4px 0;font-weight:600;">${val}</td></tr>`
    : "";

async function sendEmail({ client, kind, data, isUrgent, recordingUrl, transcript, assistantName, cloverResult }) {
  const emailTo = client?.emailTo;
  if (!RESEND_API_KEY || !emailTo || !INTAKE_EMAIL_FROM) return;

  let subject, html;

  if (kind === "immigration") {
    const matter = MATTER_LABELS[data.matter_type] || data.matter_type || "Unknown";
    const rawQ = data.open_questions_for_attorney;
    const questions = Array.isArray(rawQ) ? rawQ : rawQ ? [rawQ] : [];

    subject =
      (isUrgent ? "[URGENT] " : "") +
      `New intake — ${matter} — ${data.caller_name || "Unknown caller"}`;

    html = `
    <div style="font-family:system-ui,Arial,sans-serif;max-width:640px;color:#111;">
      ${isUrgent ? `<div style="background:#b00020;color:#fff;padding:10px 14px;border-radius:6px;font-weight:700;margin-bottom:16px;">🚨 URGENT — screen for detention / hearing / deadline</div>` : ""}
      <h2 style="margin:0 0 4px;">New Intake — ${matter}</h2>
      <table style="border-collapse:collapse;margin:12px 0;">
        ${row("Name", data.caller_name)}
        ${row("Callback", data.callback_number)}
        ${row("Email", data.email)}
        ${row("Calling for", data.calling_for_self === false ? `Someone else${data.on_behalf_of ? " — " + data.on_behalf_of : ""}` : "Themselves")}
        ${row("Client status", data.existing_client ? "Existing client" : "New matter")}
        ${row("Detained", data.detained ? "YES" : "")}
        ${row("A-number", data.alien_number)}
        ${row("Hearing / deadline", data.hearing_or_deadline_date)}
      </table>
      <h3 style="margin:16px 0 4px;">Summary</h3>
      <p style="margin:0;line-height:1.5;">${data.matter_summary || "—"}</p>
      ${data.qualifying_answers ? `<h3 style="margin:16px 0 4px;">Qualifying details</h3><p style="margin:0;line-height:1.5;">${data.qualifying_answers}</p>` : ""}
      ${questions.length ? `<h3 style="margin:16px 0 4px;">Open questions for attorney</h3><ul>${questions.map((q) => `<li>${q}</li>`).join("")}</ul>` : ""}
      ${data.final_note ? `<h3 style="margin:16px 0 4px;">Caller's closing note</h3><p style="margin:0;line-height:1.5;">${data.final_note}</p>` : ""}
      ${recordingUrl ? `<p style="margin:16px 0 0;"><a href="${recordingUrl}">Listen to recording</a></p>` : ""}
      ${transcript ? `<details style="margin-top:16px;"><summary style="cursor:pointer;color:#666;">Full transcript</summary><pre style="white-space:pre-wrap;font-size:13px;color:#333;">${transcript}</pre></details>` : ""}
    </div>`;
  } else if (kind === "order") {
    const items = orderItemLines(data);
    const needsHuman = cloverResult && !cloverResult.ok;

    subject =
      (needsHuman ? "[ACTION NEEDED] " : "") +
      `Phone order — ${data.caller_name || "Unknown caller"}` +
      (data.pickup_time_minutes ? ` — ${data.pickup_time_minutes} min` : "");

    html = `
    <div style="font-family:system-ui,Arial,sans-serif;max-width:640px;color:#111;">
      ${cloverStatusHtml(cloverResult)}
      <h2 style="margin:0 0 4px;">Phone Order — ${data.caller_name || "Unknown caller"}</h2>
      <table style="border-collapse:collapse;margin:12px 0;">
        ${row("Callback", data.callback_number)}
        ${row("Type", data.order_type || "pickup")}
        ${row("Ready in", data.pickup_time_minutes ? `${data.pickup_time_minutes} min` : "")}
        ${row("Quoted total", data.order_total ? `$${Number(data.order_total).toFixed(2)}` : "")}
      </table>
      <h3 style="margin:16px 0 4px;">Items</h3>
      ${items.length
        ? `<ul style="margin:0;padding-left:20px;line-height:1.7;">${items.map((l) => `<li>${l}</li>`).join("")}</ul>`
        : `<p style="margin:0;color:#666;">No items captured.</p>`}
      ${data.special_instructions
        ? `<h3 style="margin:16px 0 4px;">Kitchen notes</h3><p style="margin:0;line-height:1.5;">${data.special_instructions}</p>`
        : ""}
      ${(data.unmatched_requests || []).length
        ? `<div style="margin:16px 0;padding:10px 14px;background:#fdecea;border-left:4px solid #b00020;">
             <strong style="color:#b00020;">Could not match these requests — call the customer</strong>
             <ul style="margin:6px 0 0;padding-left:20px;">${data.unmatched_requests.map((u) => `<li>${u}</li>`).join("")}</ul>
           </div>`
        : ""}
      ${data.order_confirmed === false
        ? `<p style="margin:12px 0;color:#b00020;font-weight:600;">⚠ The caller never confirmed the read-back — verify before preparing.</p>`
        : ""}
      <h3 style="margin:16px 0 4px;">Summary</h3>
      <p style="margin:0;line-height:1.5;">${data.summary || "—"}</p>
      ${recordingUrl ? `<p style="margin:16px 0 0;"><a href="${recordingUrl}">Listen to recording</a></p>` : ""}
      ${transcript ? `<details style="margin-top:16px;"><summary style="cursor:pointer;color:#666;">Full transcript</summary><pre style="white-space:pre-wrap;font-size:13px;color:#333;">${transcript}</pre></details>` : ""}
    </div>`;
  } else if (kind === "general") {
    subject =
      (isUrgent ? "[URGENT] " : "") +
      `New call — ${data.reason || "General"} — ${data.caller_name || "Unknown caller"}`;

    html = `
    <div style="font-family:system-ui,Arial,sans-serif;max-width:640px;color:#111;">
      ${isUrgent ? `<div style="background:#b00020;color:#fff;padding:10px 14px;border-radius:6px;font-weight:700;margin-bottom:16px;">🚨 URGENT</div>` : ""}
      <h2 style="margin:0 0 4px;">New Call${assistantName ? ` — ${assistantName}` : ""}</h2>
      <table style="border-collapse:collapse;margin:12px 0;">
        ${row("Name", data.caller_name)}
        ${row("Callback", data.callback_number)}
        ${row("Reason", data.reason)}
        ${row("Language", data.call_language && data.call_language.toLowerCase() !== "english" ? data.call_language : "")}
      </table>
      <h3 style="margin:16px 0 4px;">Summary</h3>
      <p style="margin:0;line-height:1.5;">${data.summary || "—"}</p>
      ${data.details ? `<h3 style="margin:16px 0 4px;">Details</h3><p style="margin:0;line-height:1.5;">${data.details}</p>` : ""}
      ${recordingUrl ? `<p style="margin:16px 0 0;"><a href="${recordingUrl}">Listen to recording</a></p>` : ""}
      ${transcript ? `<details style="margin-top:16px;"><summary style="cursor:pointer;color:#666;">Full transcript</summary><pre style="white-space:pre-wrap;font-size:13px;color:#333;">${transcript}</pre></details>` : ""}
    </div>`;
  } else {
    subject = `New call — unrecognized data shape`;
    html = `
    <div style="font-family:system-ui,Arial,sans-serif;max-width:640px;color:#111;">
      <h2 style="margin:0 0 8px;">Call received — data shape not recognized</h2>
      <p style="color:#666;">The structured output didn't match the immigration or general schema. Raw data below.</p>
      <pre style="white-space:pre-wrap;font-size:13px;background:#f6f6f6;padding:12px;border-radius:8px;">${JSON.stringify(data, null, 2)}</pre>
      ${recordingUrl ? `<p><a href="${recordingUrl}">Listen to recording</a></p>` : ""}
      ${transcript ? `<details style="margin-top:12px;"><summary style="cursor:pointer;color:#666;">Full transcript</summary><pre style="white-space:pre-wrap;font-size:13px;color:#333;">${transcript}</pre></details>` : ""}
    </div>`;
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: INTAKE_EMAIL_FROM,
      to: emailTo.split(",").map((s) => s.trim()),
      subject,
      html,
    }),
  });

  // Resend rejects (bad key, unverified domain, bad address) with a 4xx body,
  // not an exception — that silent failure is the one worth alerting on.
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`resend ${resp.status} ${body}`.trim());
  }
}

/* ============================ HEALTH ============================ */

app.get('/health', (req,res)=>res.status(200).json({ ok:true, at:new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Intake webhook v2 listening on :${PORT}`));
