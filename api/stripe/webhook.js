// POST /api/stripe/webhook
// Receives Stripe events (payment succeeded, card saved, etc). Verifies the
// signature, then updates our database with the service role key.
//
// IMPORTANT: signature verification needs the RAW request body. Vercel parses
// JSON by default, so we disable the body parser via the config export below
// and read the raw stream ourselves.
//
// Plug-and-play: returns { configured:false } until STRIPE_SECRET_KEY and
// STRIPE_WEBHOOK_SECRET are set.

module.exports.config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise(function (resolve, reject) {
    let data = "";
    req.on("data", function (chunk) { data += chunk; });
    req.on("end", function () { resolve(Buffer.from(data)); });
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const key = process.env.STRIPE_SECRET_KEY;
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!key || !whSecret) { res.status(200).json({ configured: false }); return; }
  try {
    const Stripe = require("stripe");
    const stripe = Stripe(key);
    const sig = req.headers["stripe-signature"];
    const raw = await readRaw(req);

    let event;
    try {
      event = stripe.webhooks.constructEvent(raw, sig, whSecret);
    } catch (err) {
      res.status(400).send("Webhook signature verification failed: " + err.message);
      return;
    }

    // const { createClient } = require("@supabase/supabase-js");
    // const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    switch (event.type) {
      case "payment_intent.succeeded":
        // TODO: mark the matching payments row paid, attach receipt
        break;
      case "setup_intent.succeeded":
        // TODO: store the saved payment method on the customer (card on file)
        break;
      case "charge.refunded":
        // TODO: mark refund on the payment
        break;
      default:
        break;
    }
    res.status(200).json({ received: true });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
};
