import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Server-side Supabase client using the secret key (sb_secret_...).
// This bypasses RLS and must never be imported into client components.
// Works identically with the new sb_secret_... key format or a legacy
// service_role JWT — supabase-js just forwards the key string in its headers.
// Lazily instantiated so a missing env var only fails on actual use,
// not at module load / build time.
let cachedClient: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!url || !secretKey) {
    throw new Error(
      "Missing Supabase env vars: NEXT_PUBLIC_SUPABASE_URL and/or SUPABASE_SECRET_KEY."
    );
  }

  cachedClient = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return cachedClient;
}
