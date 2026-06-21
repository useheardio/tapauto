// GET /api/tap?token=XXXX[&uid=..&ctr=..&cmac=..]  ->  Tier-0 public payload.
// Calls the locked-down tap_public() function (no PII) and logs the tap.
// If the tag is provisioned for NTAG 424 SDM (and NTAG_SDM_KEY is set), the
// uid/ctr/cmac are cryptographically verified so a cloned or forged tag is
// flagged. Plain (unprovisioned) tags still resolve, just marked unverified.
const { createClient } = require("@supabase/supabase-js");
const { verifySdm } = require("./_sdm.js");

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const token = String(q.token || q.t || "").trim();
    if (!token) { res.status(400).json({ error: "token required" }); return; }

    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) { res.status(500).json({ error: "Supabase env vars not set" }); return; }

    // ---- tag signature verification (NTAG 424 SDM) ----
    const sdmKey = process.env.NTAG_SDM_KEY;            // 32 hex chars (16 bytes)
    const require_sig = String(process.env.NTAG_SDM_REQUIRE || "").toLowerCase() === "true";
    let verified = false, sdmCounter = null, sdmAttempted = false;
    if (sdmKey && q.uid && q.ctr && q.cmac) {
      sdmAttempted = true;
      const r = verifySdm({ keyHex: sdmKey, uidHex: q.uid, ctrHex: q.ctr, cmacHex: q.cmac });
      verified = !!r.valid;
      sdmCounter = (r.counter != null) ? r.counter : null;
    }
    if (require_sig && sdmAttempted && !verified) {
      res.setHeader("Cache-Control", "no-store");
      res.status(403).json({ found: false, verified: false, error: "tag signature invalid" });
      return;
    }

    const supa = createClient(url, anonKey, { auth: { persistSession: false } });

    const { data, error } = await supa.rpc("tap_public", { p_token: token });
    if (error) { res.status(500).json({ error: error.message }); return; }

    // best-effort tap log (does not block the response)
    let ctr = sdmCounter;
    if (ctr == null && q.ctr) { const c = parseInt(String(q.ctr), 16); ctr = Number.isNaN(c) ? null : c; }
    supa.rpc("log_tap", { p_token: token, p_counter: ctr, p_cmac_valid: verified, p_tier: "0" })
      .then(() => {}, () => {});

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(Object.assign({ verified: verified }, data || { found: false }));
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
};
