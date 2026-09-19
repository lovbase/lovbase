/**
 * Telling source apart from something written for a person.
 *
 * pi emits tool arguments through the same `text_delta` channel as its narration, so the text
 * accumulated from a build can be half a React component. This lives in core rather than next to
 * the agent because it is needed at both ends: the API applies it when writing a tool result, and
 * the transcript applies it when rendering one. Conversations recorded before the write-side check
 * existed still hold raw code in `lb_chat`, and there is no migration that can un-record them —
 * the reader has to defend itself.
 */
export function looksLikeCode(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  // Literal escapes are the giveaway: prose does not contain the two characters \ and n in a row.
  if (t.includes('\\n') || t.includes('\\"')) return true
  const signals = [/className=/, /=>/, /\breturn\s*\(/, /[{};]\s*$/m, /^\s*(const|function|import|export)\s/m]
  return signals.filter((re) => re.test(t)).length >= 2
}
