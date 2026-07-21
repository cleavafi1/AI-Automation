import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sets a quote's status to 'approved'. Called by the internal page just before
// send-offer.
export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const quoteId = params.id;

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("quotes")
      .update({ status: "approved" })
      .eq("id", quoteId)
      .select("id, status")
      .maybeSingle();

    if (error) {
      console.error("[api/approve] update failed:", error);
      return NextResponse.json(
        { error: "Failed to approve quote." },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json({ error: "Quote not found." }, { status: 404 });
    }

    return NextResponse.json({ quote: data }, { status: 200 });
  } catch (err) {
    console.error("[api/approve] unexpected error:", err);
    return NextResponse.json(
      { error: "Failed to approve quote." },
      { status: 500 }
    );
  }
}
