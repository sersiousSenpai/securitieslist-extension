import { createClient } from "npm:@supabase/supabase-js@2";

// Service-role client. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// injected into every edge function by Supabase; they never ship to clients.
export const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

export async function findCompany(ticker: string) {
  const { data } = await db.from("companies").select("id, name").eq("ticker", ticker).maybeSingle();
  return data;
}

export async function companyByTicker(ticker: string, exchange: string | null, name: string | null) {
  const found = await findCompany(ticker);
  if (found) return found;
  const { data: created, error } = await db
    .from("companies")
    .insert({ ticker, exchange, name: name ?? ticker })
    .select("id, name")
    .single();
  if (error) throw error;
  return created;
}

export async function getCursor(source: string) {
  const { data } = await db.from("ingest_state").select("cursor").eq("source", source).maybeSingle();
  return data?.cursor ?? null;
}

export async function setCursor(source: string, cursor: string) {
  await db.from("ingest_state").upsert({ source, cursor, updated_at: new Date().toISOString() });
}
