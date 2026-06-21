// POST /api/consent
// Records a driver's own opt-in to text/email reminders for the vehicle behind
// a tag token. Calls the record_consent() SECURITY DEFINER function.
// Body: { token, email?, phone?, sms (bool), emailOk (bool) }
const { createClient } = require("@supabase/supabase-js");

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const token = String(body.token || "").trim();
    if (!token) { res.status(400).json({ error: "token required" }); return; }

    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anon) { res.status(500).json({ error: "Supabase env vars not set" }); return; }

    const supa = createClient(url, anon, { auth: { persistSession: false } });
    const { data, error } = await supa.rpc("record_consent", {
      p_token: token,
      p_email: body.email || null,
      p_sms: typeof body.sms === "boolean" ? body.sms : null,
      p_email_ok: typeof body.emailOk === "boolean" ? body.emailOk : null,
      p_phone: body.phone || null
    });
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.status(200).json(data || { ok: false });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
};
