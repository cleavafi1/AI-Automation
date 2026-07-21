import { NextResponse } from "next/server";
import { inquirySchema } from "@/lib/validation";
import { getSupabaseAdmin } from "@/lib/supabase";
import { triggerQuoteGeneration } from "@/lib/trigger-quote";

export const runtime = "nodejs";

export async function POST(request: Request) {
  // Parse JSON body.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Virheellinen pyyntö." },
      { status: 400 }
    );
  }

  // Server-side validation (source of truth).
  const parsed = inquirySchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && !fieldErrors[key]) {
        fieldErrors[key] = issue.message;
      }
    }
    return NextResponse.json(
      { error: "Tarkista lomakkeen tiedot.", fieldErrors },
      { status: 400 }
    );
  }

  const data = parsed.data;

  let inquiryId: string;
  try {
    const supabase = getSupabaseAdmin();
    const { data: inserted, error } = await supabase
      .from("inquiries")
      .insert({
        raw_request: data.raw_request,
        name: data.name,
        email: data.email,
        phone: data.phone,
        // service_type / property_size / postal_code / frequency are extracted
        // from raw_request by the background quote pipeline (lib/extraction.ts),
        // so they start null. status defaults to 'new' in the DB.
      })
      .select("id")
      .single();

    if (error || !inserted) {
      // Log the real error server-side; return a generic message to the client.
      console.error("[api/inquiries] insert failed:", error);
      return NextResponse.json(
        { error: "Tallennus epäonnistui. Yritä hetken kuluttua uudelleen." },
        { status: 500 }
      );
    }
    inquiryId = inserted.id as string;
  } catch (err) {
    console.error("[api/inquiries] unexpected error:", err);
    return NextResponse.json(
      { error: "Tallennus epäonnistui. Yritä hetken kuluttua uudelleen." },
      { status: 500 }
    );
  }

  // Kick off quote generation in the background (Netlify background function).
  // We await only the 202 acknowledgment so it's dispatched before this
  // function freezes — the customer is NOT blocked on the Claude call.
  // triggerQuoteGeneration never throws: a failure here leaves the inquiry
  // saved and quotable manually from /admin.
  await triggerQuoteGeneration(request, inquiryId);

  return NextResponse.json(
    { message: "Kiitos! Otamme yhteyttä 24 tunnin sisällä." },
    { status: 201 }
  );
}
