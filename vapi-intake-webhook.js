// Vapi intake webhook — receives end-of-call report, sends email + Slack alert.
// Deploy to Vercel/Railway, then paste the public URL into Vapi:
//   Assistant → Advanced → Server URL (or Server Messages webhook)
//
// Required env vars:
//   RESEND_API_KEY        - from resend.com
//   INTAKE_EMAIL_TO       - who at the firm gets intake (comma-separated ok)
//   INTAKE_EMAIL_FROM     - a verified sender on your Resend domain, e.g. intake@yourfirm.com
//   SLACK_WEBHOOK_URL     - Slack incoming webhook for #intake
//   VAPI_SECRET           - (optional) a shared secret you also set in Vapi to verify calls

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const {
  RESEND_API_KEY,
  INTAKE_EMAIL_TO,
  INTAKE_EMAIL_FROM,
  SLACK_WEBHOOK_URL,
  VAPI_SECRET,
} = process.env;

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
  try {
    // Optional shared-secret check
    if (VAPI_SECRET && req.headers["x-vapi-secret"] !== VAPI_SECRET) {
      return res.status(401).send("unauthorized");
    }

    const message = req.body?.message ?? req.body;

    // Only act on the final end-of-call report
    if (message?.type !== "end-of-call-report") {
      return res.status(200).send("ignored");
    }

    // Vapi puts parsed structured output under analysis.structuredData
    const data =
      message?.analysis?.structuredData ??
      message?.structuredData ??
      {};

    const recordingUrl =
      message?.recordingUrl ?? message?.artifact?.recordingUrl ?? "";
    const transcript =
      message?.transcript ?? message?.artifact?.transcript ?? "";

    const isUrgent = String(data.urgency).toUpperCase() === "URGENT";
    const matter = MATTER_LABELS[data.matter_type] || data.matter_type || "Unknown";

    // Fire both in parallel; don't let one failure block the other
    await Promise.allSettled([
      sendSlack({ data, matter, isUrgent, recordingUrl }),
      sendEmail({ data, matter, isUrgent, recordingUrl, transcript }),
    ]);

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook error:", err);
    // Still 200 so Vapi doesn't retry-storm; we've logged it.
    return res.status(200).send("error-logged");
  }
});

async function sendSlack({ data, matter, isUrgent, recordingUrl }) {
  if (!SLACK_WEBHOOK_URL) return;

  const header = isUrgent
    ? ":rotating_light: *URGENT INTAKE* :rotating_light:"
    : ":inbox_tray: New intake";

  const lines = [
    header,
    `*Name:* ${data.caller_name || "—"}`,
    `*Callback:* ${data.callback_number || "—"}`,
    `*Matter:* ${matter}`,
    data.detained ? "*Detained:* YES" : null,
    data.hearing_or_deadline_date
      ? `*Hearing/Deadline:* ${data.hearing_or_deadline_date}`
      : null,
    data.existing_client ? "*Existing client*" : "*New matter*",
    "",
    `*Summary:* ${data.matter_summary || "—"}`,
    recordingUrl ? `<${recordingUrl}|Listen to recording>` : null,
  ].filter(Boolean);

  const payload = {
    text: isUrgent ? "🚨 URGENT INTAKE" : "New intake",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    ],
  };
  if (isUrgent) payload.text = "<!here> 🚨 URGENT INTAKE";

  await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function sendEmail({ data, matter, isUrgent, recordingUrl, transcript }) {
  if (!RESEND_API_KEY || !INTAKE_EMAIL_TO || !INTAKE_EMAIL_FROM) return;

  const questions = Array.isArray(data.open_questions_for_attorney)
    ? data.open_questions_for_attorney
    : [];

  const subject =
    (isUrgent ? "[URGENT] " : "") +
    `New intake — ${matter} — ${data.caller_name || "Unknown caller"}`;

  const row = (label, val) =>
    val ? `<tr><td style="padding:4px 12px 4px 0;color:#666;">${label}</td><td style="padding:4px 0;font-weight:600;">${val}</td></tr>` : "";

  const html = `
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

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: INTAKE_EMAIL_FROM,
      to: INTAKE_EMAIL_TO.split(",").map((s) => s.trim()),
      subject,
      html,
    }),
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Intake webhook listening on :${PORT}`));
