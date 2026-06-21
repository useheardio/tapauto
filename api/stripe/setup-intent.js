// POST /api/stripe/setup-intent
// Creates (or reuses) a Stripe customer and returns a SetupIntent client_secret
// so the shop can save a card on file for a driver. Card details never touch
// our server: the browser collects them with Stripe.js using this secret.
//
// Plug-and-play: returns { configured:false } until STRIPE_SECRET_KEY is set.
// Body: { customerEmail, name, stripeCustomerId? }
module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) { res.status(200).json({ configured: false }); return; }
  try {
    const Stripe = require("stripe");
    const stripe = Stripe(key);
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    let customerId = body.stripeCustomerId;
    if (!customerId) {
      const cust = await stripe.customers.create({ email: body.customerEmail, name: body.name });
      customerId = cust.id;
    }
    const si = await stripe.setupIntents.create({ customer: customerId, payment_method_types: ["card"] });
    res.status(200).json({ configured: true, clientSecret: si.client_secret, customerId: customerId });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
};
