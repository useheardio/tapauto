// GET /api/tap?token=XXXX  ->  the Tier-0 public payload for a tag.
// Calls the locked-down tap_public() function (no PII) and logs the tap.
// Later: validate the NTAG 424 SDM cmac before trusting the read.
const { createClient } = require("@supabase/supabase-js");

module.exports = async (req, res) => {
  try {
    const token = String((req.query && req.query.token) || "").trim();
    if (!token) { res.status(400).json({ error: "token required" }); return; }

    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) { res.status(500).json({ error: "Supabase env vars not set" }); return; }

    const supa = createClient(url, anonKey, { auth: { persistSession: false } });

    const { data, error } = await supa.rpc("tap_public", { p_token: token });
    if (error) { res.status(500).json({ error: error.message }); return; }

    // best-effort tap log (does not block the response)
    const ctr = req.query && req.query.ctr ? parseInt(req.query.ctr, 16) : null;
    supa.rpc("log_tap", { p_token: token, p_counter: Number.isNaN(ctr) ? null : ctr, p_cmac_valid: false, p_tier: "0" })
      .then(() => {}, () => {});

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(data || { found: false });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
};
