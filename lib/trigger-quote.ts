// Fire quote generation for a saved inquiry without blocking the customer.
//
// We invoke a Netlify Background Function, which returns 202 immediately and
// runs the actual generation asynchronously. We await ONLY that 202 (fast) so
// the invocation is guaranteed to be dispatched before this request's function
// freezes — critical on Netlify, where a function is frozen once it responds.
// A naive un-awaited call would get killed.

const BACKGROUND_FN_PATH = "/.netlify/functions/generate-quote-background";

function resolveBaseUrl(request: Request): string {
  // Netlify sets these in production / deploy previews.
  const fromEnv =
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    process.env.DEPLOY_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  // Fallback (e.g. local `next dev`): derive from the incoming request.
  return new URL(request.url).origin;
}

/**
 * Trigger background quote generation for an inquiry. Resolves once the
 * background function has accepted the request (202). Never throws — a failure
 * here must not break the customer's confirmation; the inquiry is already saved
 * and can be generated manually from /admin.
 */
export async function triggerQuoteGeneration(
  request: Request,
  inquiryId: string
): Promise<void> {
  try {
    const url = `${resolveBaseUrl(request)}${BACKGROUND_FN_PATH}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inquiryId }),
    });
    if (!res.ok && res.status !== 202) {
      console.error(
        `[trigger-quote] background function returned ${res.status} for inquiry ${inquiryId}`
      );
    }
  } catch (err) {
    // Local dev has no Netlify functions server, and transient failures happen
    // in prod — log and move on. Manual "Generate quote" in /admin is the
    // fallback.
    console.error(
      `[trigger-quote] failed to trigger generation for inquiry ${inquiryId}:`,
      err
    );
  }
}
