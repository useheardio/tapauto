// GET /api/config  ->  public Supabase config for the browser client.
// The anon key is safe to expose (Row-Level Security protects everything).
module.exports = (req, res) => {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || null;
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).json({ url, anonKey, configured: Boolean(url && anonKey) });
};
