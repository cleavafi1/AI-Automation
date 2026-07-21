import Anthropic from "@anthropic-ai/sdk";

// Server-side Anthropic client. Lazily instantiated so a missing key only
// fails when quote generation is actually invoked, not at build time.
let cachedClient: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (cachedClient) return cachedClient;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY environment variable.");
  }

  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

// Model used for quote drafting.
export const QUOTE_MODEL = "claude-sonnet-4-6";
