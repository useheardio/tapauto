// POST /api/stripe/payment-intent
// Creates a PaymentIntent to charge a driver. Two modes:
//   - Card on file (server-side): pass stripeCustomerId + paymentMethodId +
//     offSession:true + confirm:true to charge immediately.
//   - Fresh card (browser): omit those; use the returned client_secret with
//     Stripe.js to collect and confirm the card on the device.
//
// Plug-and-play: returns { configured:false } until STRIPE_SECRET_KEY is set.
// Body: { amountCents, stripeCustomerId?, paymentMethodId?, offSession?, confirm? }
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

    const amount = parseInt(body.amountCents, 10);
    if (!amount || amount < 50) { res.status(400).json({ error: "amountCents required (min 50)" }); return; }

    const params = { amount: amount, currency: "usd" };
    if (body.stripeCustomerId) params.customer = body.stripeCustomerId;
    if (body.paymentMethodId) {
      params.payment_method = body.paymentMethodId;
      params.off_session = !!body.offSession;
      params.confirm = !!body.confirm;
    } else {
      params.automatic_payment_methods = { enabled: true };
    }

    const pi = await stripe.paymentIntents.create(params);
    res.status(200).json({ configured: true, clientSecret: pi.client_secret, paymentIntentId: pi.id, status: pi.status });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
};
