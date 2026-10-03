const BOARD = "dqp98n0e";

function slug(name) {
  return String(name || "wok").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "wok";
}

async function kvGet(key) {
  const res = await fetch("https://keyvalue.immanuel.co/api/KeyVal/GetValue/" + BOARD + "/" + key);
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return text.replace(/^"|"$/g, ""); }
}

async function kvPut(key, val) {
  const url = "https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/" + BOARD + "/" + key + "/" + encodeURIComponent(val);
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error("board write failed");
}

async function ordersFor(shop) {
  const ids = String(await kvGet("ids-" + shop) || "").split(",").filter(Boolean);
  const orders = [];
  for (const id of ids) {
    const raw = await kvGet("t-" + shop + "-" + id);
    if (!raw) continue;
    orders.push(typeof raw === "string" ? JSON.parse(raw) : raw);
  }
  return orders;
}

async function stripeSession(ticket, origin) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("payment_method_types[0]", "card");
  params.set("payment_method_options[card][request_three_d_secure]", "automatic");
  params.set("success_url", origin + "/paid.html?id=" + ticket.id + "&shop=" + ticket.slug + "&session_id={CHECKOUT_SESSION_ID}");
  params.set("cancel_url", origin + "/?pay=cancel");
  params.set("client_reference_id", ticket.id);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", "usd");
  params.set("line_items[0][price_data][unit_amount]", String(Math.round(ticket.total * 100)));
  params.set("line_items[0][price_data][product_data][name]", (ticket.shop || "Order") + " " + ticket.id);
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  const body = await res.json();
  if (!res.ok) throw new Error((body.error && body.error.message) || "stripe failed");
  return body;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    const body = req.body || {};
    const shop = slug(req.query.shop || body.shop || body.slug || (body.ticket && body.ticket.shop));
    if (req.method === "GET") {
      const orders = await ordersFor(shop);
      const dead = String(await kvGet("dead-" + shop) || "").split("|").filter(Boolean);
      return res.status(200).json({ shop, orders, dead, card: Boolean(process.env.STRIPE_SECRET_KEY) });
    }
    if (req.method === "POST" && body.action === "86") {
      const raw = String(await kvGet("dead-" + shop) || "");
      let dead = raw.split("|").filter(Boolean);
      dead = dead.includes(body.name) ? dead.filter(x => x !== body.name) : dead.concat(body.name);
      await kvPut("dead-" + shop, dead.join("|"));
      return res.status(200).json({ ok: true, dead });
    }
    if (req.method === "POST") {
      const ticket = body.ticket || body;
      if (!ticket || !ticket.id) return res.status(400).json({ error: "No ticket." });
      if ((ticket.sub || 0) < 15) return res.status(400).json({ error: "Under $15." });
      ticket.slug = shop;
      ticket.status = "new";
      const origin = req.headers.origin || "https://chinese-takeout-template.vercel.app";
      let checkoutUrl = null;
      if (ticket.pay === "card") {
        const session = await stripeSession(ticket, origin);
        if (!session) return res.status(402).json({ error: "Card processor is not connected. Cash works. I will not fake a charge." });
        ticket.payLabel = "Card pending";
        ticket.paid = false;
        ticket.stripeSession = session.id;
        checkoutUrl = session.url;
      } else {
        ticket.payLabel = "CASH COLLECT";
        ticket.paid = false;
      }
      await kvPut("t-" + shop + "-" + ticket.id, JSON.stringify(ticket));
      const ids = String(await kvGet("ids-" + shop) || "").split(",").filter(Boolean).filter(x => x !== ticket.id);
      ids.unshift(ticket.id);
      await kvPut("ids-" + shop, ids.slice(0, 25).join(","));
      return res.status(200).json({ ok: true, id: ticket.id, checkoutUrl });
    }
    if (req.method === "PATCH") {
      const orders = await ordersFor(shop);
      const hit = orders.find(t => t.id === body.id);
      if (!hit) return res.status(404).json({ error: "No ticket." });
      if (body.confirmCard) {
        const check = await fetch("https://api.stripe.com/v1/checkout/sessions/" + body.sessionId, { headers: { Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY } });
        const session = await check.json();
        if (session.payment_status !== "paid" || session.client_reference_id !== hit.id) return res.status(402).json({ error: "Stripe did not mark this paid." });
        hit.paid = true;
        hit.payLabel = hit.pay === "apple" ? "APPLE PAY" : hit.pay === "google" ? "GOOGLE PAY" : "CARD PAID";
        hit.status = "new";
      } else if (body.status) hit.status = body.status;
      await kvPut("t-" + shop + "-" + hit.id, JSON.stringify(hit));
      return res.status(200).json({ ok: true, ticket: hit });
    }
    return res.status(405).json({ error: "No." });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
