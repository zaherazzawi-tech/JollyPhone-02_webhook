// clover.js — creates Clover POS orders from Vapi order_summary output.
//
// Design notes:
//  - Menu matching is EXACT (case-insensitive, whitespace-collapsed). No fuzzy
//    matching: the agent has the menu verbatim in its prompt, so a miss means
//    something genuinely went wrong and staff should see it, not a guess.
//  - Quantity is expanded into repeated line items — Clover's atomic_order
//    endpoint has no quantity field.
//  - Modifiers ride along as line-item notes, not Clover modifier objects
//    (those need per-item modifier group IDs the merchant may not have set up).
//  - Never throws. Returns a result object so email/Slack always still send.
//
// Env: CLOVER_ENV=production switches the base URL. Per-client token env vars
// are named in CLOVER_CLIENTS below.

const CLOVER_BASE =
  process.env.CLOVER_ENV === "production"
    ? "https://api.clover.com"
    : "https://apisandbox.dev.clover.com";

// Keyed by the same client_id the webhook already resolves.
// Menu keys must match the assistant prompt's menu exactly (lowercased here).
export const CLOVER_CLIENTS = {
  demo_gyro: {
    merchantId: "0N7Q6GEDRPSB1",
    tokenEnv: "CLOVER_TOKEN_DEMO_GYRO",
    menu: {
      "gyro plate": "NHE8K6W4FCRYW",
      "chicken plate": "ZMZ3S0M80JDYP",
      "beef plate": "KABKCM3N8M2VG",
    },
  },
};

const normalize = (s) =>
  String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

/** Map extracted order_items onto Clover line items. */
export function buildLineItems(orderItems, menu) {
  const lineItems = [];
  const unmatched = [];

  for (const entry of orderItems || []) {
    const itemId = menu[normalize(entry.item_name)];
    const qty = Math.max(1, Math.round(Number(entry.quantity) || 1));

    if (!itemId) {
      unmatched.push(`${qty}x ${entry.item_name || "(unnamed item)"}`);
      continue;
    }

    const note = (entry.modifiers || []).join(", ").slice(0, 255);
    for (let i = 0; i < qty; i++) {
      lineItems.push(note ? { item: { id: itemId }, note } : { item: { id: itemId } });
    }
  }

  return { lineItems, unmatched };
}

/**
 * Create a Clover order. Always resolves — check `.ok`.
 * Refuses (skipped:true) rather than guessing when the call left any doubt.
 */
export async function createCloverOrder(clientId, data) {
  const cfg = CLOVER_CLIENTS[clientId];
  if (!cfg) return { ok: false, skipped: true, reason: `No Clover config for client "${clientId}"` };

  const token = process.env[cfg.tokenEnv];
  if (!token) return { ok: false, skipped: true, reason: `Missing env var ${cfg.tokenEnv}` };

  if (data.order_confirmed === false) {
    return { ok: false, skipped: true, reason: "Caller never confirmed the read-back" };
  }
  if ((data.unmatched_requests || []).length > 0) {
    return {
      ok: false,
      skipped: true,
      reason: "Call contained requests the agent could not match",
      unmatched: data.unmatched_requests,
    };
  }

  const { lineItems, unmatched } = buildLineItems(data.order_items, cfg.menu);

  if (unmatched.length) {
    return { ok: false, skipped: true, reason: "Item(s) not found in the menu map", unmatched };
  }
  if (!lineItems.length) {
    return { ok: false, skipped: true, reason: "No orderable items in this call" };
  }

  const noteParts = [
    data.caller_name ? `Phone order — ${data.caller_name}` : "Phone order",
    data.callback_number || null,
    data.pickup_time_minutes ? `pickup ~${data.pickup_time_minutes} min` : null,
    data.order_type === "delivery" ? "DELIVERY" : null,
    data.special_instructions || null,
  ].filter(Boolean);

  const body = {
    orderCart: {
      lineItems,
      note: noteParts.join(" · ").slice(0, 255),
    },
  };

  try {
    const resp = await fetch(
      `${CLOVER_BASE}/v3/merchants/${cfg.merchantId}/atomic_order/orders`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    const text = await resp.text();

    if (!resp.ok) {
      console.error("[clover] create failed", resp.status, text.slice(0, 300));
      return { ok: false, status: resp.status, reason: `clover ${resp.status} ${text}`.slice(0, 400) };
    }

    const order = JSON.parse(text);
    console.log(`[clover] created ${order.id} — ${lineItems.length} line item(s), total ${order.total}`);
    return { ok: true, orderId: order.id, total: order.total, lineItemCount: lineItems.length };
  } catch (err) {
    console.error("[clover] request error", err);
    return { ok: false, reason: err.message };
  }
}

/** Email banner: green when it reached the POS, orange when staff must act. */
export function cloverStatusHtml(result) {
  if (!result) return "";

  if (result.ok) {
    return `<div style="background:#e8f5e9;border-left:4px solid #2e7d32;padding:10px 14px;border-radius:6px;margin-bottom:16px;">
      <strong style="color:#2e7d32;">✓ Sent to POS</strong> — order <code>${result.orderId}</code>,
      ${result.lineItemCount} item(s), $${(result.total / 100).toFixed(2)}
    </div>`;
  }

  const extra = result.unmatched?.length
    ? `<br><strong>Needs attention:</strong> ${result.unmatched.join(", ")}`
    : "";

  return `<div style="background:#fff3e0;border-left:4px solid #e65100;padding:10px 14px;border-radius:6px;margin-bottom:16px;">
    <strong style="color:#e65100;">⚠ NOT sent to POS — enter this order manually</strong><br>
    ${result.reason || "Unknown error"}${extra}
  </div>`;
}

/** Slack one-liner for the same result. */
export function cloverStatusSlack(result) {
  if (!result) return null;
  if (result.ok) return `*POS:* :white_check_mark: sent — order ${result.orderId} ($${(result.total / 100).toFixed(2)})`;
  return `*POS:* :warning: NOT sent — ${result.reason}`;
}
