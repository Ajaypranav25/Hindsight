/** The language cheat sheet in the help dialog (checked against SPEC §2–§9). */
export interface CheatSection {
  readonly title: string
  readonly code: string
  readonly note?: string
}

export const CHEAT_SHEET: readonly CheatSection[] = [
  {
    title: 'Values',
    code: `42   3.14   1_000_000   "hi {name}"
true   false   nil
[1, 2, 3]   {x: 1, y: 2}   0..10   1..=5`,
    note: 'Strings interpolate {expressions}. Ranges exclude the end unless written ..=',
  },
  {
    title: 'Bindings',
    code: `let x = 1        // fixed
var n = 0        // can change
n += 1
let [a, b] = [1, 2]`,
  },
  {
    title: 'Functions',
    code: `fn add(a, b) { a + b }   // last expression is the result
let square = |x| x * x
let f = fn(x) { return x + 1 }`,
  },
  {
    title: 'Control flow',
    code: `if n > 0 { "pos" } else { "not pos" }
while n > 0 { n -= 1 }
for i in 0..10 { if i == 5 { break } }
for [key, value] in entries(record) { print(key) }`,
  },
  {
    title: 'Match and patterns',
    code: `match value {
  0 | 1 => "tiny",
  2..10 => "small",
  [first, ...rest] => first,
  {name, age} => name,
  n if n > 100 => "big",
  _ => "other",
}`,
  },
  {
    title: 'Pipes',
    code: `xs |> filter(|x| x > 0) |> map(|x| x * 2) |> sum()`,
    note: 'x |> f(a) means f(x, a)',
  },
  {
    title: 'Lists and records',
    code: `xs[0]   xs[-1]   push(xs, 4)   pop(xs)   [...xs, 5]
r.name   r["key"]   r.age = 3   {...r, y: 3}`,
  },
  {
    title: 'Common builtins',
    code: `print str repr type len num range
push pop insert remove slice sort reverse join contains
keys values entries has get delete split upper trim
map filter reduce each find any all sum zip enumerate
min max abs floor round sqrt random_int`,
  },
  {
    title: 'Comments',
    code: `// to the end of the line
/* a block /* that nests */ */`,
  },
]
