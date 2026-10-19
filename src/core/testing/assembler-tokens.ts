/**
 * Line tokenizer for the test assembler: whitespace-separated words, JSON strings (kept with their
 * quotes) and balanced JSON objects/arrays (kept whole). `;` starts a comment outside them.
 */
export function tokenizeLine(line: string, lineNumber: number): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < line.length) {
    const ch = line[i]!
    if (ch === ' ' || ch === '\t' || ch === ',') {
      i++
    } else if (ch === ';') {
      break
    } else if (ch === '"') {
      const end = stringEnd(line, i, lineNumber)
      tokens.push(line.slice(i, end))
      i = end
    } else if (ch === '{' || ch === '[') {
      const end = balancedEnd(line, i, lineNumber)
      tokens.push(line.slice(i, end))
      i = end
    } else {
      const start = i
      while (i < line.length && !/[\s;,]/.test(line[i]!)) i++
      tokens.push(line.slice(start, i))
    }
  }
  return tokens
}

/** Index just after the closing quote of the JSON string starting at `start`. */
function stringEnd(line: string, start: number, lineNumber: number): number {
  for (let i = start + 1; i < line.length; i++) {
    if (line[i] === '\\') i++
    else if (line[i] === '"') return i + 1
  }
  throw new Error(`assembler line ${lineNumber}: unterminated string`)
}

/** Index just after the bracket that balances the one at `start`. */
function balancedEnd(line: string, start: number, lineNumber: number): number {
  let depth = 0
  for (let i = start; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      i = stringEnd(line, i, lineNumber) - 1
    } else if (ch === '{' || ch === '[') {
      depth++
    } else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  throw new Error(`assembler line ${lineNumber}: unbalanced brackets`)
}
