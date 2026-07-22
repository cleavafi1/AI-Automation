import { getSupabaseAdmin } from "./supabase";
import type { EmailConversation } from "./types";

// Read/write helpers for the per-quote email conversation history (Phase 7).

export type NewConversationRow = {
  quote_id: string;
  direction: "inbound" | "outbound";
  from_address?: string | null;
  subject?: string | null;
  body_text?: string | null;
  resend_email_id?: string | null;
  classified_intent?: string | null;
  telegram_message_id?: number | null;
  status?: "pending_review" | "approved" | "declined";
  proposed_date?: string | null;
  proposed_start_time?: string | null;
  proposed_end_time?: string | null;
};

/** Insert a conversation row and return it. */
export async function insertConversation(
  row: NewConversationRow
): Promise<EmailConversation> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("email_conversations")
    .insert(row)
    .select("*")
    .single();
  if (error) {
    throw new Error(`Failed to insert conversation row: ${error.message}`);
  }
  return data as EmailConversation;
}

/** All conversation rows for a quote, oldest first (full history for context). */
export async function loadConversationHistory(
  quoteId: string
): Promise<EmailConversation[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("email_conversations")
    .select("*")
    .eq("quote_id", quoteId)
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(`Failed to load conversation history: ${error.message}`);
  }
  return (data ?? []) as EmailConversation[];
}

/** Render history as a plain transcript for a Claude prompt. */
export function renderHistoryForPrompt(rows: EmailConversation[]): string {
  if (rows.length === 0) return "(ei aiempaa viestihistoriaa)";
  return rows
    .map((r) => {
      const who = r.direction === "inbound" ? "ASIAKAS" : "CLEAVA";
      return `[${who}] ${r.body_text ?? ""}`.trim();
    })
    .join("\n\n");
}
