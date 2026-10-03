const OWNER = "wallstreetbranchmanager-tech";
const REPO = "chinese-takeout-template";
const PATH = "data/orders.json";

function headers() {
  return {
    Authorization: "Bearer " + process.env.GITHUB_TOKEN,
    Accept: "application/vnd.github+json",
    "User-Agent": "wok-desk"
  };
}

async function readBoard() {
  const res = await fetch("https://api.github.com/repos/" + OWNER + "/" + REPO + "/contents/" + PATH, { headers: headers() });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message || "board read failed");
  return { sha: body.sha, data: JSON.parse(Buffer.from(body.content, "base64").toString("utf8")) };
}

async function writeBoard(data, sha, message) {
  const res = await fetch("https://api.github.com/repos/" + OWNER + "/" + REPO + "/contents/" + PATH, {
    method: "PUT",
    headers: Object.assign({ "Content-Type": "application/json" }, headers()),
    body: JSON.stringify({ message, sha, content: Buffer.from(JSON.stringify(data, null, 2)).toString("base64") })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message || "board write failed");
  return body;
}

async function stripeSession(ticket, origin) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", origin + "/paid.html?id=" + ticket.id + "&session_id={CHECKOUT_SESSION_ID}");
  params.set("cancel_url", origin + "/?pay=cancel");
  params.set("client_reference_id", ticket.id);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", "usd");
  params.set("line_items[0][price_data][unit_amount]", String(Math.round(ticket.total * 100)));
  params.set("line_items[0][price_data][product_data][name]", ticket.shop + " " + ticket.id);
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
  if (!process.env.GITHUB_TOKEN) return res.status(500).json({ error: "Kitchen board token is not set." });
  try {
    if (req.method === "GET") {
      const board = await readBoard();
      return res.status(200).json(board.data);
    }
    if (req.method === "POST") {
      const ticket = req.body && req.body.ticket ? req.body.ticket : req.body;
      if (!ticket || !ticket.id) return res.status(400).json({ error: "No ticket." });
      if ((ticket.sub || 0) < 15) return res.status(400).json({ error: "Under $15." });
      ticket.status = "new";
      const origin = req.headers.origin || "https://chinese-takeout-template.vercel.app";
      if (ticket.pay === "card") {
        const session = await stripeSession(ticket, origin);
        if (!session) return res.status(402).json({ error: "Card processing is not connected. Add STRIPE_SECRET_KEY on Vercel. Cash still prints. I will not fake a charge." });
        ticket.payLabel = "Card pending";
        ticket.paid = false;
        ticket.stripeSession = session.id;
        const board = await readBoard();
        board.data.orders = [ticket].concat(board.data.orders || []).slice(0, 40);
        await writeBoard(board.data, board.sha, "order " + ticket.id + " pending card");
        return res.status(200).json({ ok: true, checkoutUrl: session.url, id: ticket.id });
      }
      ticket.payLabel = "CASH COLLECT";
      ticket.paid = false;
      const board = await readBoard();
      board.data.orders = [ticket].concat(board.data.orders || []).slice(0, 40);
      await writeBoard(board.data, board.sha, "order " + ticket.id + " cash");
      return res.status(200).json({ ok: true, id: ticket.id });
    }
    if (req.method === "PATCH") {
      const body = req.body || {};
      const board = await readBoard();
      const hit = (board.data.orders || []).find(t => t.id === body.id);
      if (!hit) return res.status(404).json({ error: "No ticket." });
      if (body.confirmCard) {
        const check = await fetch("https://api.stripe.com/v1/checkout/sessions/" + body.sessionId, { headers: { Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY } });
        const session = await check.json();
        if (session.payment_status !== "paid" || session.client_reference_id !== hit.id) return res.status(402).json({ error: "Stripe did not mark this paid." });
        hit.paid = true;
        hit.payLabel = "CARD PAID";
        hit.status = "new";
      } else if (body.status) hit.status = body.status;
      await writeBoard(board.data, board.sha, "ticket " + hit.id);
      return res.status(200).json({ ok: true, ticket: hit });
    }
    return res.status(405).json({ error: "No." });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
