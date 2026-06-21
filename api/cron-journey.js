// GET /api/cron-journey  (called by Vercel Cron once a day)
// The "set it and forget it" engine. For every shop it:
//   1. re-segments vehicles into thanks / due / winback by car health,
//   2. makes sure each shop has the right offer rows,
//   3. flips each car's active offer so the tag shows the right thing,
//   4. (only if Resend is connected AND JOURNEY_AUTOSEND=true) emails the
//      consented drivers.
//
// Uses the service role key (server-only, trusted) so it can act across shops.
// Protected by CRON_SECRET: Vercel sends "Authorization: Bearer <CRON_SECRET>".
//
// Plug-and-play: returns configured:false until SUPABASE_SERVICE_ROLE_KEY is set.
// Offer-flipping runs as soon as that key exists; emailing waits for
// RESEND_API_KEY + JOURNEY_AUTOSEND=true so you never spam by accident.
const { createClient } = require("@supabase/supabase-js");

var OFFERS = {
  thanks:  { title: "Thanks for visiting. Tap to leave a quick review.", cents: 0,    code: "REVIEW" },
  due:     { title: "$15 off your next oil change",                      cents: 1500, code: "OIL15" },
  winback: { title: "We want you back: $25 off your oil change",         cents: 2500, code: "BACK25" }
};

function health(intervalMiles, lastAt) {
  var interval = intervalMiles || 5000;
  var since = lastAt ? (Date.now() - new Date(lastAt).getTime()) / (1000 * 60 * 60 * 24 * 30.44) : 0;
  var frac = (since * 1000) / interval;
  var h = frac <= 1 ? (100 - frac * 28) : (72 - (frac - 1) * 55);
  return Math.max(5, Math.min(100, Math.round(h)));
}
function bucketKind(v) {
  if (v.last_service_at && (Date.now() - new Date(v.last_service_at).getTime()) / 86400000 <= 30) return "thanks";
  var s = health(v.interval_miles, v.last_service_at);
  if (s < 55) return "winback";
  if (s < 80) return "due";
  return null;
}
function esc(s){ return String(s||"").replace(/[&<>"]/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"})[c]; }); }
function emailHtml(kind, name, offerTitle){
  var hi = name ? ("Hi " + esc(name.split(" ")[0]) + ",") : "Hi,";
  var body = {
    thanks: "Thanks for trusting us with your car. A quick review means the world. Tap your windshield tag any time to see your history.",
    due: "Your oil change is coming due. Tap your windshield tag to book, and here is a little something: <b>" + esc(offerTitle) + "</b>.",
    winback: "It has been a while and your car is past due. We would love to see you back. <b>" + esc(offerTitle) + "</b>. Tap your tag to book."
  }[kind] || "Tap your windshield tag to see your car's status and book your next service.";
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1B1A18">' +
    '<p style="font-size:16px">' + hi + '</p><p style="font-size:15px;line-height:1.6">' + body + '</p>' +
    '<p style="font-size:13px;color:#6A675F;margin-top:24px">You asked us to keep you posted about your vehicle. Reply STOP to opt out.</p></div>';
}

module.exports = async (req, res) => {
  // auth: Vercel Cron passes the secret; reject anything else when a secret is set
  var secret = process.env.CRON_SECRET;
  if (secret) {
    var auth = req.headers.authorization || "";
    if (auth !== ("Bearer " + secret)) { res.status(401).json({ error: "unauthorized" }); return; }
  }

  var url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  var svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svc) { res.status(200).json({ configured: false, reason: "SUPABASE_SERVICE_ROLE_KEY not set" }); return; }

  var resendKey = process.env.RESEND_API_KEY;
  var autosend = String(process.env.JOURNEY_AUTOSEND || "").toLowerCase() === "true";
  var fromAddr = process.env.JOURNEY_FROM || "Tap Auto <reminders@tapauto.app>";

  try {
    var supa = createClient(url, svc, { auth: { persistSession: false } });

    // pull vehicles + owner + each shop's offers in a few queries
    var vres = await supa.from("vehicles")
      .select("id,shop_id,interval_miles,last_service_at,vehicle_ownership(active,customers(name,email,consent_email))");
    if (vres.error) { res.status(500).json({ error: vres.error.message }); return; }
    var vehicles = vres.data || [];

    var ores = await supa.from("offers").select("id,shop_id,kind,active");
    var offers = (ores.data || []).filter(function (o) { return o.active; });
    function offerId(shopId, kind) { var m = offers.filter(function (o) { return o.shop_id === shopId && o.kind === kind; })[0]; return m ? m.id : null; }

    var flipped = 0, emailed = 0, created = 0, voffRows = [];
    var toEmail = [];
    var ensureCache = {};

    for (var i = 0; i < vehicles.length; i++) {
      var v = vehicles[i];
      var kind = bucketKind(v);
      if (!kind) continue;

      // ensure the shop has this offer (create once per shop+kind)
      var ck = v.shop_id + ":" + kind;
      var oid = offerId(v.shop_id, kind);
      if (!oid && !ensureCache[ck]) {
        var def = OFFERS[kind];
        var ins = await supa.from("offers").insert({ shop_id: v.shop_id, kind: kind, title: def.title, value_cents: def.cents || null, code: def.code, active: true }).select("id").single();
        if (ins.data) { oid = ins.data.id; offers.push({ id: oid, shop_id: v.shop_id, kind: kind, active: true }); created++; }
        ensureCache[ck] = oid;
      } else if (!oid) { oid = ensureCache[ck]; }
      if (!oid) continue;

      voffRows.push({ shop_id: v.shop_id, vehicle_id: v.id, offer_id: oid, active: true });
      flipped++;

      var own = (v.vehicle_ownership || []).filter(function (o) { return o.active; })[0];
      var cu = own && own.customers ? own.customers : null;
      if (cu && cu.email && cu.consent_email) toEmail.push({ email: cu.email, name: cu.name, kind: kind, offerTitle: OFFERS[kind].title });
    }

    // flip offers in bulk (newest active vehicle_offer wins in tap_public)
    if (voffRows.length) { var fr = await supa.from("vehicle_offers").insert(voffRows); if (fr.error) { /* keep going */ } }

    // email only when explicitly enabled
    if (resendKey && autosend) {
      for (var j = 0; j < toEmail.length; j++) {
        var r = toEmail[j];
        try {
          var resp = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": "Bearer " + resendKey, "Content-Type": "application/json" },
            body: JSON.stringify({ from: fromAddr, to: r.email, subject: ({ thanks: "Thanks from your shop", due: "Your oil change is coming due", winback: "We miss you" })[r.kind] || "A note from your shop", html: emailHtml(r.kind, r.name, r.offerTitle) })
          });
          if (resp.ok) emailed++;
        } catch (e) {}
      }
    }

    res.status(200).json({
      configured: true,
      vehicles: vehicles.length,
      offersFlipped: flipped,
      offersCreated: created,
      emailsSent: emailed,
      emailEligible: toEmail.length,
      emailingEnabled: !!(resendKey && autosend)
    });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
};
