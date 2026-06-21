// POST /api/send-journey
// Sends the journey emails for a bucket. Consent-gated upstream (the client
// only passes opted-in recipients), and verified here against the caller's
// Supabase session. Lights up the moment RESEND_API_KEY is set; until then it
// reports configured:false so the UI can say "email goes live when connected".
const { createClient } = require("@supabase/supabase-js");

function esc(s){ return String(s||"").replace(/[&<>"]/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"})[c]; }); }

function buildHtml(bucket, name, offerTitle){
  var hi = name ? ("Hi " + esc(name.split(" ")[0]) + ",") : "Hi,";
  var body = {
    thanks: "Thanks for trusting us with your car. If we did right by you, a quick review means the world. Tap your windshield tag any time to see your history.",
    due: "Your oil change is coming due. Tap your windshield tag to book in a couple of taps, and here is a little something to make it easy: <b>" + esc(offerTitle) + "</b>.",
    winback: "It has been a while, and your car is past due for an oil change. We would love to see you back. <b>" + esc(offerTitle) + "</b>. Tap your tag to book."
  }[bucket] || "Tap your windshield tag to see your car's status and book your next service.";
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1B1A18">' +
    '<p style="font-size:16px">' + hi + '</p>' +
    '<p style="font-size:15px;line-height:1.6">' + body + '</p>' +
    '<p style="font-size:13px;color:#6A675F;margin-top:24px">You are receiving this because you asked us to keep you posted about your vehicle. ' +
    'Reply STOP to opt out of future reminders.</p></div>';
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];
    const bucket = body.bucket || "due";
    const subject = body.subject || "A note from your shop";
    const offerTitle = body.offerTitle || "";

    const resendKey = process.env.RESEND_API_KEY;
    const fromAddr = process.env.JOURNEY_FROM || "Tap Auto <reminders@tapauto.app>";

    // Not configured yet: tell the UI cleanly. Offers were already flipped client-side.
    if (!resendKey) {
      res.status(200).json({ configured: false, wouldSend: recipients.length, reason: "RESEND_API_KEY not set" });
      return;
    }

    // Verify the caller is a real signed-in user (defense in depth).
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    let caller = null;
    try {
      const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
      if (token && url && anon) {
        const c = createClient(url, anon, { auth: { persistSession: false } });
        const u = await c.auth.getUser(token);
        caller = u && u.data ? u.data.user : null;
      }
    } catch (e) {}
    if (!caller) { res.status(401).json({ error: "unauthorized" }); return; }

    let sent = 0; const errors = [];
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      if (!r || !r.email) continue;
      try {
        const resp = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": "Bearer " + resendKey, "Content-Type": "application/json" },
          body: JSON.stringify({ from: fromAddr, to: r.email, subject: subject, html: buildHtml(bucket, r.name, offerTitle) })
        });
        if (resp.ok) sent++; else errors.push((await resp.text()).slice(0, 200));
      } catch (e) { errors.push(String(e && e.message ? e.message : e)); }
    }
    res.status(200).json({ configured: true, sent: sent, total: recipients.length, errors: errors.slice(0, 3) });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
};
