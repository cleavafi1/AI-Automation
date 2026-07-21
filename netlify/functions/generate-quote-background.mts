// Netlify Background Function.
//
// The "-background" suffix makes Netlify run this asynchronously: it returns
// 202 to the caller immediately and keeps running (up to 15 min), so the
// customer never waits on the Claude API call. It reuses the exact same logic
// as the manual endpoint — generateQuoteForInquiry from lib/quote — no
// duplicated quote logic.
//
// Available on all Netlify plans. Deployed alongside the Next.js runtime from
// the netlify/functions directory.

import { generateQuoteForInquiry } from "../../lib/quote";

export default async function handler(req: Request): Promise<Response> {
  let inquiryId: string | undefined;
  try {
    const body = (await req.json()) as { inquiryId?: string };
    inquiryId = body.inquiryId;
  } catch {
    console.error("[generate-quote-background] invalid JSON body");
    return new Response("invalid body", { status: 400 });
  }

  if (!inquiryId) {
    console.error("[generate-quote-background] missing inquiryId");
    return new Response("missing inquiryId", { status: 400 });
  }

  try {
    const quote = await generateQuoteForInquiry(inquiryId);
    console.log(
      `[generate-quote-background] generated quote ${quote.id} for inquiry ${inquiryId}`
    );
    return new Response("ok", { status: 200 });
  } catch (err) {
    // Log the real error server-side (visible in Netlify function logs). The
    // inquiry still exists and can be retried manually from /admin.
    console.error(
      `[generate-quote-background] failed for inquiry ${inquiryId}:`,
      err
    );
    return new Response("error", { status: 500 });
  }
}
