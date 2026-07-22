// The single canonical closing block for every customer-facing offer email.
// Appended in code (not written by the model) so it is byte-for-byte identical
// on every quote and can never be duplicated. See applyStandardClosing.
export const CLOSING_SIGNATURE = [
  "Ystävällisin terveisin,",
  "Cleava-tiimi",
  "Cleava Siivouspalvelut",
  "info@cleava.fi | +358 45 187 8083 | cleava.fi",
  "Y-tunnus 3631044-9",
].join("\n");

// Sign-off phrases a model might append on its own. If one shows up in the tail
// of a draft we cut from there before appending the canonical block, so a
// model-added closing can't produce a second signature.
const SIGNOFF_RE =
  /(ystävällisin terveisin|parhain terveisin|ystävällisin yhteistyöterveisin|best regards|kind regards|yours sincerely|warm regards)/i;

/**
 * Guarantee the draft ends with exactly ONE canonical closing block.
 * Strips any sign-off the model added in the last part of the text, then
 * appends CLOSING_SIGNATURE. Idempotent — re-running it does not stack blocks.
 */
export function applyStandardClosing(text: string): string {
  let t = (text ?? "").replace(/\s+$/, "");
  // Only look in the tail so a sign-off phrase inside the body prose isn't cut.
  const tailStart = Math.max(0, t.length - 400);
  const tail = t.slice(tailStart);
  const m = SIGNOFF_RE.exec(tail);
  if (m && m.index != null) {
    // Cut back to the start of the line the sign-off begins on.
    let cut = tailStart + m.index;
    const lineStart = t.lastIndexOf("\n", cut);
    if (lineStart !== -1) cut = lineStart;
    t = t.slice(0, cut).replace(/\s+$/, "");
  }
  return `${t}\n\n${CLOSING_SIGNATURE}`;
}
