/**
 * Reads the JSON object in a model's answer: the whole text, a fenced block, or the span from the
 * first `{` to the last `}` (local models often wrap JSON in prose or code fences).
 */
export function extractJson(text: string): unknown {
  const attempts = [text.trim()]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced !== null) attempts.push(fenced[1]!.trim())
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) attempts.push(text.slice(first, last + 1))
  for (const candidate of attempts) {
    try {
      const value: unknown = JSON.parse(candidate)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {
      // Try the next reading.
    }
  }
  return null
}
