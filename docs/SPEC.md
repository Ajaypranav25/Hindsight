# Hindsight Language Specification

Version 0.1. **Normative.** The lexer, parser, compiler, VM, builtins and the test corpus must all
follow this document. If an implementation and this document disagree, the document wins until the
document is changed on purpose. Section numbers (§) are stable references.

Hindsight is a small, dynamically typed, expression-oriented language designed to be _recorded_:
every program runs on a bytecode VM whose complete state can be reconstructed at any step, so tools
can rewind, scrub, and explain execution. Source files use the extension `.sight`.

```
fn fib(n) {
  if n < 2 { n } else { fib(n - 1) + fib(n - 2) }
}

for i in 0..10 {
  print("fib({i}) = {fib(i)}")
}
```

---

## 1. Notation

- `code` is literal source text. _Italics_ name grammar symbols.
- "Compile error **E0xx**" and "runtime error **R0xx**" refer to the catalog in §11. Message
  templates in §11 are exact; tests match on them.
- "type name" means the string returned by `type(v)` (§4.1).

---

## 2. Lexical structure

### 2.1 Source text

- A program is a JavaScript string (a sequence of UTF-16 code units).
- **Offsets** are 0-based UTF-16 code-unit indices. A **span** `{start, end}` is half-open: it
  covers offsets `start <= i < end`.
- Lines end at `\n`, `\r\n`, or `\r`. **Line** and **column** numbers are 1-based; columns count
  UTF-16 code units.
- A byte-order mark (U+FEFF) at offset 0 is ignored.

### 2.2 Whitespace and comments

- Whitespace: space, tab, `\n`, `\r`.
- Line comment: `//` up to (not including) the end of the line.
- Block comment: `/*` … `*/`. Block comments **nest**: `/* a /* b */ c */` is one comment.
  An unterminated block comment is **E005**.
- Any other character outside a token is **E001** (see §11 for hints). The lexer reports the error,
  skips the character, and continues.

### 2.3 The newline flag

Every token has a boolean `newlineBefore`: true when at least one line terminator appears between the
end of the previous token and the start of this token (line terminators inside comments count).
The first token of the file has `newlineBefore = false`. The parser uses this flag (§3.2).

### 2.4 Identifiers and keywords

- _identifier_: `[A-Za-z_][A-Za-z0-9_]*`. The single character `_` lexes as an identifier; it has a
  special meaning in patterns (§6) and is an error as a value (**E027**).
- Keywords (reserved, cannot be identifiers):
  `and break continue else false fn for if in let match nil not or return true var while`

### 2.5 Numbers

```
number := digits ( "." digits )? ( ("e" | "E") ("+" | "-")? digits )?
digits := [0-9] ( [0-9] | "_" )*
```

- `_` separators are ignored: `1_000_000` is one million.
- A `.` belongs to the number only when a digit follows it: `1..5` is `1`, `..`, `5`; `1.` is `1`, `.`.
- An exponent marker must be followed by digits.
- If a number is immediately followed by a letter, the whole run of letters, digits and `_` is
  **E004**: `3abc`, `1e`, `0x1F`.
- The value is an IEEE-754 double (`Number(lexemeWithoutUnderscores)`).

### 2.6 Strings and interpolation

- Strings are delimited by `"`. They may span lines (raw newlines are kept).
- Escapes: `\n` `\t` `\r` `\0` `\\` `\"` `\{` `\}` and `\u{H…}` with 1–6 hex digits denoting a code
  point ≤ 0x10FFFF (encoded as UTF-16). Any other escape, or a malformed `\u{…}`, is **E003**; the
  lexer keeps the escaped character literally and continues.
- An unterminated string is **E002**, reported at the opening quote; the token extends to end of file.
- **Interpolation**: an unescaped `{` inside a string starts an embedded expression that runs to the
  matching `}`. Braces nest, and strings may nest inside the expression. The lexer emits:

  | source             | tokens                                                                                         |
  | ------------------ | ---------------------------------------------------------------------------------------------- |
  | `"plain"`          | `String("plain")`                                                                              |
  | `"a {x} b"`        | `StringHead("a ")`, `x`, `StringTail(" b")`                                                    |
  | `"{x}{y}"`         | `StringHead("")`, `x`, `StringMiddle("")`, `y`, `StringTail("")`                               |
  | `"n = {f("{k}")}"` | `StringHead("n = ")`, `f`, `(`, `StringHead("")`, `k`, `StringTail("")`, `)`, `StringTail("")` |

  Token values are the _cooked_ text (escapes resolved). Spans: `String` covers both quotes;
  `StringHead` covers the opening `"` through the `{`; `StringMiddle` covers `}` through the next `{`;
  `StringTail` covers `}` through the closing `"`.

- End of file inside an interpolation is **E006**. An empty interpolation `"{}"` is a parse error
  (**E011**).

### 2.7 Punctuators

Longest match wins:

```
...  ..=  ..  .  =>  ==  =  !=  <=  <  >=  >  +=  +  -=  -  **  *=  *  /=  /  %=  %  |>  |
(  )  {  }  [  ]  ,  :  ;
```

There is no `!`, `&&`, `||` or `!` operator: use `not`, `and`, `or`. Two adjacent `|` tokens (`||`)
form an empty lambda parameter list (§7.12).

---

## 3. Syntax

### 3.1 Grammar

```
program        = { stmt } EOF
block          = "{" { stmt } "}"

stmt           = ( letStmt | fnDecl | returnStmt | "break" | "continue"
                 | whileStmt | forStmt | block | exprOrAssign ) [ ";" ]
letStmt        = ( "let" | "var" ) pattern "=" expr
fnDecl         = "fn" IDENT "(" [ params ] ")" block
params         = pattern { "," pattern } [ "," ]
returnStmt     = "return" [ expr ]                       (value rule: §3.2)
whileStmt      = "while" expr block
forStmt        = "for" pattern "in" expr block
exprOrAssign   = expr [ assignOp expr ]
assignOp       = "=" | "+=" | "-=" | "*=" | "/=" | "%="

expr           = pipe
pipe           = orExpr { "|>" orExpr }
orExpr         = andExpr { "or" andExpr }
andExpr        = notExpr { "and" notExpr }
notExpr        = "not" notExpr | comparison
comparison     = range [ compOp range ]                  (a second compOp is E013)
compOp         = "==" | "!=" | "<" | "<=" | ">" | ">="
range          = additive [ ( ".." | "..=" ) additive ]  (a second range op is E014)
additive       = multiplicative { ( "+" | "-" ) multiplicative }
multiplicative = unary { ( "*" | "/" | "%" ) unary }
unary          = "-" unary | power
power          = postfix [ "**" unary ]
postfix        = primary { "(" [ args ] ")" | "[" expr "]" | "." IDENT }
args           = expr { "," expr } [ "," ]

primary        = NUMBER | STRING | template | "true" | "false" | "nil" | IDENT
               | "(" expr ")" | list | record | lambda | fnExpr | ifExpr | matchExpr
template       = STRING_HEAD expr { STRING_MIDDLE expr } STRING_TAIL
list           = "[" [ listItem { "," listItem } [ "," ] ] "]"
listItem       = "..." expr | expr
record         = "{" [ recItem { "," recItem } [ "," ] ] "}"
recItem        = "..." expr | ( IDENT | STRING ) ":" expr | IDENT
lambda         = ( "|" [ params ] "|" | "||" ) body
fnExpr         = "fn" "(" [ params ] ")" block
ifExpr         = "if" expr block [ "else" ( ifExpr | block ) ]
matchExpr      = "match" expr "{" { arm [ "," ] } "}"
arm            = pattern [ "if" expr ] "=>" body
body           = block | expr                            ("{" always starts a block here)

pattern        = altPattern { "|" altPattern }           (alternatives: §6.3)
altPattern     = "_" | IDENT | literalPat | rangePat | listPat | recordPat
literalPat     = [ "-" ] NUMBER | STRING | "true" | "false" | "nil"
rangePat       = [ "-" ] NUMBER ( ".." | "..=" ) [ "-" ] NUMBER
listPat        = "[" [ listPatItem { "," listPatItem } [ "," ] ] "]"
listPatItem    = "..." [ IDENT ] | pattern
recordPat      = "{" [ recPatItem { "," recPatItem } [ "," ] ] "}"
recPatItem     = IDENT [ ":" pattern ] | STRING ":" pattern
```

Notes:

- **Blocks vs. records.** At the start of a statement, `{` begins a block. In expression position,
  `{` begins a record literal, except where the grammar requires a _block_ or a _body_ (after an
  `if`/`while`/`for` header, after `else`, after `fn(...)`, after a lambda's `|...|`, after `=>`).
  To return a record from a lambda or match arm, parenthesize it: `|x| ({x})`.
- **Assignment** is a statement, not an expression. The left side must be an identifier (not `_`),
  a member access `a.b`, or an index `a[i]`; anything else is **E012**.
- **Statement separation.** After a statement, the next token must be `;`, a token with
  `newlineBefore`, `}` or end of file. Otherwise **E018**. The same rule separates match arms, with
  `,` allowed in place of `;`.
- Template parts (`STRING_HEAD` …) come from the lexer (§2.6).

### 3.2 Newline sensitivity

Newlines never end an expression on their own, but they stop the parser from _continuing_ one:

1. While parsing an expression, the parser does **not** consume the following tokens when they have
   `newlineBefore = true`; the expression ends before them:
   - `(` (call) and `[` (index),
   - binary operators `+ - * / % ** == != < <= > >= .. ..= and or`,
   - assignment operators `= += -= *= /= %=`.
2. The tokens `.` (member access) and `|>` (pipe) **may** start a line; they continue the previous
   expression. This enables the pipeline style:

   ```
   let total = orders
     |> filter(|o| o.paid)
     |> map(|o| o.amount)
     |> sum()
   ```

3. **Inside brackets newlines are ignored**: within `( … )` (grouping or arguments), `[ … ]` (lists
   and index expressions), and the braces of a record literal, rule 1 does not apply. Rule 1 applies
   again inside any block nested within them (for example a lambda's block body inside call
   arguments).
4. `return` takes a value only when the next token is on the same line (`newlineBefore = false`) and
   is not `}`, `;` or end of file.
5. `else` may appear on the line after the closing `}` of an `if` block.

Consequences worth knowing (documented behavior, not bugs):

```
let a = 1
-2            // a separate statement: the expression `-2`
let b = 1 -
  2           // b == -1: the operator ends the line, so the expression continues
f
(x)           // two statements: `f` and `(x)`
```

### 3.3 Precedence

Lowest to highest:

| level | operators                         | associativity                   |
| ----- | --------------------------------- | ------------------------------- |
| 1     | `\|>`                             | left                            |
| 2     | `or`                              | left                            |
| 3     | `and`                             | left                            |
| 4     | `not` (prefix)                    | —                               |
| 5     | `== != < <= > >=`                 | none: chaining is **E013**      |
| 6     | `..` `..=`                        | none: chaining is **E014**      |
| 7     | `+ -`                             | left                            |
| 8     | `* / %`                           | left                            |
| 9     | `-` (prefix)                      | —                               |
| 10    | `**`                              | right; `-2 ** 2` is `-(2 ** 2)` |
| 11    | call `()`, index `[]`, member `.` | left                            |

Lambda bodies extend as far right as possible: `|x| x + 1 |> f` is `|x| (x + 1 |> f)`.

---

## 4. Values

### 4.1 Types

| type name    | values                                                                          |
| ------------ | ------------------------------------------------------------------------------- |
| `"nil"`      | `nil`                                                                           |
| `"bool"`     | `true`, `false`                                                                 |
| `"number"`   | IEEE-754 doubles; integers are exact up to 2^53                                 |
| `"string"`   | immutable sequences of UTF-16 code units                                        |
| `"list"`     | mutable ordered sequences; reference semantics                                  |
| `"record"`   | mutable maps from string keys to values; insertion-ordered; reference semantics |
| `"function"` | user functions, lambdas, and builtins                                           |
| `"range"`    | immutable arithmetic progressions (§7.6)                                        |

The **article form** of a type, used in messages, is `nil` for nil and `a bool`, `a number`,
`a string`, `a list`, `a record`, `a function`, `a range` for the rest.

### 4.2 Truthiness

`nil` and `false` are falsy. Everything else is truthy, including `0`, `""` and `[]`.

### 4.3 Text representation

Two conversions are used throughout: `show` (for `print`, `str`, `join`, interpolation) and `repr`
(inside containers, in error messages, and by `repr()`).

- `nil` → `nil`; booleans → `true` / `false`.
- numbers → JavaScript `String(n)` (so `3`, `0.5`, `-0` → `0`, `1e+21`, `NaN`, `Infinity`).
- strings: `show(s)` is `s` itself. `repr(s)` wraps in double quotes and escapes `\` `"`, newline
  (`\n`), tab (`\t`), carriage return (`\r`) and other code units below 0x20 as `\u{h}` (lowercase
  hex, no padding).
- lists → `[` + `repr` of each item joined by `, ` + `]`.
- records → `{` + `key: repr(value)` joined by `, ` + `}`. A key is written bare when it matches
  _identifier_ syntax and is not a keyword; otherwise as `repr(key)`. Empty record: `{}`.
- functions → `<fn NAME>` (NAME per §7.12), `<fn>` for unnamed lambdas, `<builtin NAME>` for builtins.
- ranges → `A..B` or `A..=B` (bounds via `show`); a range with step ≠ 1 → `range(A, B, STEP)`.
- A list or record that contains itself (directly or indirectly) prints the repeated occurrence as
  `[...]` or `{...}`.
- For every non-string value, `show(v) == repr(v)`.

---

## 5. Names, scopes and bindings

### 5.1 Declarations

| form                         | creates                                    | mutable |
| ---------------------------- | ------------------------------------------ | ------- |
| `let PATTERN = e`            | the pattern's bindings                     | no      |
| `var PATTERN = e`            | the pattern's bindings                     | yes     |
| `fn NAME(PARAMS) { … }`      | `NAME`, visible inside its own body        | no      |
| function / lambda parameters | the parameter patterns' bindings           | no      |
| `for PATTERN in e { … }`     | fresh bindings for every iteration         | no      |
| match arm pattern            | bindings scoped to that arm's guard + body | no      |

`_` in any pattern binds nothing. To modify a parameter, shadow it: `var n = n`.

### 5.2 Scopes and visibility

- The program's top level is the **global scope**. A declaration statement that appears _directly_
  at top level (not inside any block) declares a **global**. Everything else is a local.
- Every block introduces a local scope. A function's parameters live in the same scope as the
  statements of its body. Each match arm has a scope for its bindings. Each for-loop iteration has a
  scope containing the iteration's bindings and the loop body's statements.
- A local binding is visible from the end of its declaration statement to the end of its scope. A
  `fn` declaration is also visible inside its own body. A `let`/`var` initializer cannot see the
  binding it declares, so `let x = x + 1` refers to an outer `x`.
- **Shadowing** is allowed for locals, in nested scopes and in the same scope: a later declaration
  hides the earlier one from that point on.

### 5.3 Name resolution (compile time)

An identifier reference `x` resolves to the first match of:

1. a visible local of the current function, innermost scope first, most recent declaration first;
2. a visible local of an enclosing function (captured by reference, §5.6);
3. a global: any top-level declaration of `x` anywhere in the program;
4. a builtin named `x` (§9);
5. otherwise **E020** `undefined variable 'x'`. When some visible local, global or builtin name is
   within Damerau–Levenshtein distance 2 of `x` and the distance is smaller than `x`'s length, the
   error carries the hint `did you mean 'y'?` (closest wins; ties go to locals innermost-first, then
   globals in declaration order, then builtins in table order).

**Use before declaration.** If a reference to global `x` occurs in top-level code (outside every
function and lambda body) at an offset before the end of the first top-level declaration of `x`, it
is **E026**. References inside functions are late-bound and checked at run time (**R006**).

### 5.4 Globals

- A global name may be declared at most once at top level; a second declaration is **E022**.
- Globals and locals may shadow builtins. Builtins themselves are unaffected (library code keeps
  using the original builtin).
- A global is defined when its declaration executes. Reading or assigning it before that is **R006**.

### 5.5 Assignment

- `x = e` requires `x` to resolve to a `var` binding. Otherwise **E021** with the reason:
  `declared with 'let'`, `a function`, `a parameter`, `a loop variable`, `a match binding`, or
  **E021** `cannot assign to builtin 'x'`. An unknown `x` is **E020**.
- `target op= e` (op ∈ `+ - * / %`) behaves like `target = target op e`, except that the object and
  index sub-expressions of `target` are evaluated only once.
- `obj.name = e` and `obj[key] = e` are checked at run time (§7.8, §7.9).

### 5.6 Closures

Functions capture variables, not values. A closure that captures a `var` observes later assignments
and its own assignments are visible to everyone sharing the variable. Every loop iteration has fresh
bindings, so closures created in different iterations capture different variables.

---

## 6. Patterns

### 6.1 Forms

| pattern                                      | matches                                                                                                                 | binds               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `_`                                          | anything                                                                                                                | —                   |
| `name`                                       | anything                                                                                                                | `name`              |
| `42`, `-1.5`, `"hi"`, `true`, `false`, `nil` | a value equal (§7.4) to the literal                                                                                     | —                   |
| `1..10`, `-5..=5`                            | a number `n` with `a <= n < b` (or `<= b` for `..=`)                                                                    | —                   |
| `[p1, p2]`                                   | a list of exactly that length whose items match                                                                         | from items          |
| `[p1, ...rest, pk]`                          | a list with at least the fixed count; `rest` binds a **new** list of the middle items                                   | from items + `rest` |
| `[first, ...]`                               | same, rest discarded (`..._` is equivalent)                                                                             | from items          |
| `{name, age: a, "x y": p}`                   | a record that has every listed key and whose values match; extra keys are allowed. `{name}` is short for `{name: name}` | from fields         |
| `p1 \| p2`                                   | anything that matches one alternative, tried left to right                                                              | — (§6.3)            |

### 6.2 Binding order

Bindings are introduced in source order, depth first, left to right. For a list pattern: the items
before the rest, then the rest, then the items after it. For a record pattern: in field order.

### 6.3 Restrictions

- A list pattern may contain at most one rest element (**E016**).
- Alternatives (`|`) may appear only in match arm patterns, at any depth (**E015** elsewhere), and
  may not contain bindings (**E017**).
- A name may be bound at most once per pattern, and at most once across a parameter list (**E023**);
  `_` is exempt.
- Anything else in pattern position (an operator expression, an interpolated string, a call) is
  **E015**.

### 6.4 Where patterns are used

- match arms: any pattern.
- `let`, `var`, `for`, parameters: any pattern except alternatives. When the value does not match,
  the program stops with **R014**. (For parameters, at the call.)

---

## 7. Expressions

### 7.1 Evaluation order

Strictly left to right: left operand before right; callee before arguments; arguments in order;
object before index before assigned value.

### 7.2 Arithmetic

- `+`: number + number → sum; string + string → concatenation; list + list → a **new** list with
  the items of both. Anything else is **R001**; for string + number (either order) the error carries
  the hint `convert with str() or use interpolation, e.g. "{x}"`.
- `-`, `*`, `**`: numbers only (**R001**). `**` is `Math.pow`.
- `/`: numbers only; a zero divisor is **R002**.
- `%`: numbers only; **floored** modulo `a - b * floor(a / b)` (the result takes the divisor's sign:
  `-7 % 3 == 2`); a zero divisor is **R002**.
- unary `-`: numbers only (**R001**, unary form).
- Overflow and other IEEE cases follow JavaScript (`2 ** 2000 == Infinity`).

### 7.3 Comparison

- `==` and `!=` use equality (§7.4) and never fail.
- `<`, `<=`, `>`, `>=`: both numbers (numeric order) or both strings (lexicographic by UTF-16 code
  unit, like JavaScript). Anything else is **R001**.

### 7.4 Equality

`equal(a, b)`:

- different types → false;
- nil, bools, strings: same value; numbers: JavaScript `===` (so `NaN != NaN` and `0 == -0`);
- lists: same length and items pairwise equal;
- records: same key set and equal values per key (order ignored);
- ranges: same start, end, step and inclusivity;
- functions: the same function object.
- If a comparison `(a, b)` is already in progress further up the recursion, it counts as equal (so
  cyclic structures compare without looping).

### 7.5 Logical operators

`a and b` → `a` if `a` is falsy, else `b`. `a or b` → `a` if `a` is truthy, else `b`. `not a` →
`true` if `a` is falsy, else `false`. `and`/`or` short-circuit.

### 7.6 Ranges

- `a..b` (end excluded) and `a..=b` (end included) require numbers (**R001** with operator `..` or
  `..=`), step 1.
- `range(n)` = `0..n`; `range(a, b)` = `a..b`; `range(a, b, step)` with `step != 0` (**R021**):
  exclusive, counting down when `step < 0`.
- Elements: `a, a+step, a+2·step, …` while `< b` (step > 0, exclusive), `<= b` (inclusive), or `> b`
  (step < 0). Bounds need not be integers. A range whose start is already past its end is empty.
- `len(r)` is the element count. Ranges are iterable (`for`, spreads, `list(r)`), support
  `contains` (§9), and are compared structurally. Ranges cannot be indexed (**R009**).

### 7.7 Strings

- `s[i]`: `i` must be an integer (**R008**); negative `i` counts from the end (`-1` is the last);
  out of range is **R007**. The result is a one-code-unit string.
- Strings are immutable: `s[i] = v` is **R022**.
- Interpolation converts each embedded value with `show` and concatenates.

### 7.8 Lists

- `[a, b, ...xs]` creates a new list. `...e` inserts every element of any iterable (§8.3).
- `xs[i]`: integer index (**R008**), negative counts from the end, out of range is **R007**.
- `xs[i] = v`: same index rules. Assignment never grows a list; use `push`/`insert`.

### 7.9 Records

- `{a: 1, "b c": 2, d, ...other}` creates a new record, entries in source order. `d` alone means
  `d: d`. `...e` copies every entry of the record `e` (a non-record is **R024**). A later entry for
  the same key replaces the value but keeps the key's original position. Repeating an explicit key in
  one literal is **E019**.
- `r.k` and `r["k"]` read a field; a missing key is **R010** (hint `did you mean 'k2'?` from the
  record's keys, distance ≤ 2). On a non-record, `.k` is **R011** and `[k]` is **R009**.
- `r.k = v` and `r["k"] = v` create or update the field (new keys go last). On a non-record, `.k = v`
  is **R011** and `[k] = v` is **R009**.
- Record index keys must be strings (**R012**).

### 7.10 Calls

- The callee must be a function (**R004**).
- User functions require exactly as many arguments as parameters (**R005**). Builtins declare a
  minimum and maximum (§9).
- Parameters are bound left to right at the call; a parameter pattern mismatch is **R014**.
- At most 10,000 calls may be active at once; one more is **R016**.
- The result is the value of the executed `return`, or else the value of the body block (§7.15).

### 7.11 Pipe

`x |> f(a, b)` means exactly `f(x, a, b)`: when the right side is a call expression, `x` becomes its
first argument (for a call of a call, the outermost call). Otherwise `x |> g` means `g(x)`.
Evaluation order is that of the resulting call. Pipes associate left: `x |> f |> g` is `g(f(x))`.

### 7.12 Functions and lambdas

- `fn name(params) { … }` declares a function. `fn(params) { … }` is an anonymous function
  expression. `|a, b| a + b`, `|| 42` and `|x| { … }` are lambdas.
- **Display names** (used by `show`, stack traces and the debugger): a declared function uses its
  name. An anonymous function or lambda used directly as the initializer of `let NAME =` or
  `var NAME =` takes `NAME`. Any other anonymous function is unnamed: it shows as `<fn>` and is called
  `lambda` in messages.
- The top-level code runs in a frame named `<top level>`.

### 7.13 if

`if c { A } else { B }` evaluates to the value of the chosen block. Without `else`, a falsy condition
yields `nil`. `else if` chains as expected.

### 7.14 match

The subject is evaluated once. Arms are tried top to bottom: an arm is chosen when its pattern
matches and its guard (if any) is truthy; the guard sees the arm's bindings. The match evaluates to
the chosen arm's body. When no arm is chosen, **R015**.

### 7.15 Blocks

A block's value is the value of its last statement when that statement is an expression statement,
otherwise `nil`. The empty block's value is `nil`.

---

## 8. Statements

### 8.1 Expression statements

Evaluated for their effects; the value is discarded (except as a block's final value, §7.15).

### 8.2 while

`while c { … }` repeats while `c` is truthy.

### 8.3 for

`for p in e { … }` evaluates `e` once, then iterates:

| iterable | yields                                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| list     | the item at index 0, 1, 2, … re-checking the list's _current_ length before every step (mutation during iteration is visible) |
| range    | its elements (§7.6)                                                                                                           |
| string   | one-code-unit strings                                                                                                         |
| record   | its keys, from a snapshot taken when the loop starts, in insertion order                                                      |

Any other value is **R013**. Each element is matched against `p` (**R014** on mismatch).

### 8.4 break and continue

Affect the innermost enclosing loop of the current function. Outside a loop (including inside a
lambda that is inside a loop) they are **E024**.

### 8.5 return

`return e` / `return` (value `nil`) leaves the current function. At top level it is **E025**.

---

## 9. Builtins

Builtins live in a fixed table. Their order (natives first, then library functions) is fixed by
`src/core/builtin-names.ts`. Arity violations are **R005**; argument type errors are **R019** in the
form `'NAME' expects DESCRIPTION as argument N, got ARTICLE-TYPE` unless a row says otherwise.
"Index" arguments follow §7.8 (integer, negative from the end) unless noted.

### 9.1 Natives

| name                                                    | args  | result and notes                                                                                                                                                            |
| ------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `print(...values)`                                      | 0+    | `nil`. Writes one output line: `show` of each value joined by a space.                                                                                                      |
| `str(v)`                                                | 1     | `show(v)`                                                                                                                                                                   |
| `repr(v)`                                               | 1     | `repr(v)`                                                                                                                                                                   |
| `type(v)`                                               | 1     | the type name                                                                                                                                                               |
| `len(v)`                                                | 1     | length of a list, string, record (key count) or range                                                                                                                       |
| `num(v)`                                                | 1     | number → itself; string → `Number(trimmed)`, or `nil` when the string is empty after trimming or the result is NaN                                                          |
| `list(iterable)`                                        | 1     | a new list of the iterable's elements (§8.3)                                                                                                                                |
| `range(a, b?, step?)`                                   | 1–3   | a range (§7.6). Arguments must be numbers.                                                                                                                                  |
| `assert(cond, message?)`                                | 1–2   | `nil`; when `cond` is falsy: **R018** `assertion failed` or `assertion failed: MESSAGE` (`show`)                                                                            |
| `panic(message)`                                        | 1     | never returns: **R017** whose message is `show(message)`                                                                                                                    |
| `push(list, v)`                                         | 2     | `nil`; appends                                                                                                                                                              |
| `pop(list)`                                             | 1     | removes and returns the last item; empty list → **R020**                                                                                                                    |
| `insert(list, index, v)`                                | 3     | `nil`; index in `0..=len` (negative counts from the end: `len + index`), else **R007**                                                                                      |
| `remove(list, index)`                                   | 2     | removes and returns the item at index (**R007**)                                                                                                                            |
| `slice(seq, start, end?)`                               | 2–3   | a new list or string; JavaScript `slice` semantics (negatives from end, clamped)                                                                                            |
| `reverse(seq)`                                          | 1     | a new reversed list or string                                                                                                                                               |
| `sort(list)`                                            | 1     | a new list sorted ascending; items must be all numbers or all strings, else **R019** `'sort' can only sort a list of all numbers or all strings`. Stable.                   |
| `contains(collection, v)`                               | 2     | list: some item equal to `v`; string: substring (`v` must be a string); record: has key `v`; range: `v` is one of its elements                                              |
| `index_of(seq, v)`                                      | 2     | first index of an equal item / substring, or `-1`                                                                                                                           |
| `join(list, separator?)`                                | 1–2   | `show` of each item joined by `separator` (default `""`)                                                                                                                    |
| `min(...)` / `max(...)`                                 | 1+    | the smallest / largest of the number arguments, or of the numbers in a single list argument. An empty list is **R019** `'min' expects a non-empty list` (`'max'` likewise). |
| `copy(v)`                                               | 1     | a shallow copy of a list or record                                                                                                                                          |
| `keys(record)`                                          | 1     | list of keys in insertion order                                                                                                                                             |
| `values(record)`                                        | 1     | list of values                                                                                                                                                              |
| `entries(record)`                                       | 1     | list of `[key, value]` lists                                                                                                                                                |
| `has(record, key)`                                      | 2     | bool                                                                                                                                                                        |
| `get(record, key, default?)`                            | 2–3   | the value, or `default` (`nil` when omitted) when the key is missing                                                                                                        |
| `delete(record, key)`                                   | 2     | removes the key; returns the old value or `nil`                                                                                                                             |
| `upper(s)` / `lower(s)` / `trim(s)`                     | 1     | string                                                                                                                                                                      |
| `split(s, separator)`                                   | 2     | list of strings; separator `""` splits into code units                                                                                                                      |
| `replace(s, from, to)`                                  | 3     | replaces every occurrence (literal, not a pattern)                                                                                                                          |
| `starts_with(s, p)` / `ends_with(s, p)`                 | 2     | bool                                                                                                                                                                        |
| `repeat(s, n)`                                          | 2     | `s` repeated `n` times; `n` must be a non-negative integer                                                                                                                  |
| `chars(s)`                                              | 1     | list of one-code-unit strings                                                                                                                                               |
| `char_code(s, index?)`                                  | 1–2   | the UTF-16 code unit at index (default 0); **R007** when out of range                                                                                                       |
| `from_char_code(n)`                                     | 1     | a one-code-unit string                                                                                                                                                      |
| `pad_start(s, width, fill?)` / `pad_end(...)`           | 2–3   | JavaScript `padStart`/`padEnd`; `fill` defaults to `" "`                                                                                                                    |
| `abs` `floor` `ceil` `sqrt` `sin` `cos` `log` (natural) | 1     | number (JavaScript `Math`)                                                                                                                                                  |
| `round(x)`                                              | 1     | nearest integer, halves away from zero (`round(-2.5) == -3`)                                                                                                                |
| `atan2(y, x)`                                           | 2     | number                                                                                                                                                                      |
| `random()`                                              | 0     | a number in `[0, 1)` from the VM's deterministic generator (§10.3)                                                                                                          |
| `random_int(lo, hi)`                                    | 2     | an integer in `[lo, hi]` (both integers, `lo <= hi`)                                                                                                                        |
| `seed(n)`                                               | 1     | `nil`; resets the generator from the number `n`                                                                                                                             |
| `steps()`                                               | 0     | the number of VM steps executed before this call (the current time, §10.1)                                                                                                  |
| `PI`, `INF`                                             | value | the constants π and `Infinity` (not functions)                                                                                                                              |

### 9.2 Library functions

Written in Hindsight itself (`src/core/prelude.ts`), so their execution is recorded like user code
and shows up as _library_ frames that debuggers can skip. `xs` may be any iterable (§8.3); results
are new lists. `f` and `key` are functions.

| name                              | result                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `map(xs, f)`                      | `[f(x) for each x]`                                                                    |
| `filter(xs, f)`                   | the items for which `f(x)` is truthy                                                   |
| `reduce(xs, f, init)`             | folds left: `acc = f(acc, x)` starting from `init`                                     |
| `each(xs, f)`                     | calls `f(x)` for every item; `nil`                                                     |
| `find(xs, f)`                     | the first item with `f(x)` truthy, else `nil`                                          |
| `find_index(xs, f)`               | its index, else `-1`                                                                   |
| `any(xs, f)` / `all(xs, f)`       | bool                                                                                   |
| `count(xs, f)`                    | number of items with `f(x)` truthy                                                     |
| `sum(xs)`                         | numeric sum (`0` for empty)                                                            |
| `sort_by(xs, key)`                | stable merge sort by `key(x)`, compared with `<`                                       |
| `zip(a, b)`                       | `[[a0, b0], [a1, b1], …]` up to the shorter length                                     |
| `enumerate(xs)`                   | `[[0, x0], [1, x1], …]`                                                                |
| `flat_map(xs, f)`                 | concatenation of the lists `f(x)`                                                      |
| `flatten(xs)`                     | concatenation of the items, each of which must be iterable (one level)                 |
| `take(xs, n)` / `drop(xs, n)`     | the first `n` items / all but the first `n`                                            |
| `uniq(xs)`                        | items without later duplicates (equality §7.4), first occurrences kept in order        |
| `group_by(xs, key)`               | a record mapping `str(key(x))` to the list of items with that key, in first-seen order |
| `min_by(xs, f)` / `max_by(xs, f)` | the item with the smallest / largest `f(x)` (first wins on ties); `nil` for empty      |
| `times(n, f)`                     | `[f(0), f(1), …, f(n - 1)]`                                                            |
| `chunk(xs, n)`                    | consecutive lists of length `n` (the last may be shorter)                              |

When a runtime error happens inside library code, the error is reported at the call site in the
nearest user-code frame (§10.4).

---

## 10. Execution model

### 10.1 Steps and time

A **step** is the execution of one VM instruction. A run is a sequence of steps `0, 1, …, N-1`.
**Time** `t` (an integer in `0..=N`) names the state _before_ step `t`; time `N` is the state after
the run ends. If step `k` raises a runtime error, the run ends with `N = k`: time `N` is the state
just before the failing instruction, so the operands that caused the error are still visible.

### 10.2 Output

`print` produces one **output event** per call: the text (no trailing newline) and the time of the
step that executed the call. The text is visible in every state after that time.

### 10.3 Determinism

Running the same program with the same seed produces the same steps, output and states. The only
source of randomness is the VM's seeded generator (default seed `42`), whose state is part of the VM
state. There is no clock, input or I/O besides `print`.

### 10.4 Runtime errors

A runtime error stops the program. It carries its code, message, optional hint, the span of the
failing instruction, and the call stack (innermost first, each frame with its display name and the
span of its current instruction). If the failing instruction is inside library code, the reported
span is that of the call instruction in the nearest user-code frame.

### 10.5 Limits

- Active calls: 10,000 (**R016**).
- Steps: chosen by the host (the studio defaults to 2,000,000). Reaching the limit is not an error;
  the run simply ends with outcome _step limit_ and can be resumed by tools that support it.

---

## 11. Diagnostics catalog

Placeholders: `X` a name, `C` a character, `N`/`M` numbers, `T`/`U` type names, `AT` an article
type (§4.1), `R` a `repr`, `OP` an operator, `P` the pattern's source text, `FOUND` a token
description (below). Messages never end with a period. Hints are separate text.

**Token descriptions** (`FOUND`): `'OP'` for punctuators (e.g. `')'`), `keyword 'K'`,
`identifier 'X'`, `number N` (the lexeme), `string`, `end of file`.

### 11.1 Compile errors

| code | message                                                                                                                                                                                | hint / notes                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| E001 | `unexpected character 'C'`                                                                                                                                                             | `!`: `use 'not' for negation or '!=' for inequality`; `&`: `use 'and'`; `'` or `` ` ``: `strings use double quotes`; `#`: `comments start with //` |
| E002 | `unterminated string`                                                                                                                                                                  |                                                                                                                                                    |
| E003 | `unknown escape sequence '\C'` / `invalid unicode escape`                                                                                                                              |                                                                                                                                                    |
| E004 | `invalid number literal 'LEXEME'`                                                                                                                                                      |                                                                                                                                                    |
| E005 | `unterminated block comment`                                                                                                                                                           |                                                                                                                                                    |
| E006 | `unterminated string interpolation`                                                                                                                                                    |                                                                                                                                                    |
| E010 | `expected EXPECTED but found FOUND`                                                                                                                                                    | e.g. `expected ')' but found end of file`, `expected an identifier but found number 3`                                                             |
| E011 | `expected an expression but found FOUND`                                                                                                                                               |                                                                                                                                                    |
| E012 | `invalid assignment target`                                                                                                                                                            |                                                                                                                                                    |
| E013 | `comparison operators cannot be chained`                                                                                                                                               | `write 'a < b and b < c'`                                                                                                                          |
| E014 | `range operators cannot be chained`                                                                                                                                                    |                                                                                                                                                    |
| E015 | `invalid pattern` / `alternatives ('\|') are only allowed in match patterns`                                                                                                           |                                                                                                                                                    |
| E016 | `a list pattern can contain at most one '...rest'`                                                                                                                                     |                                                                                                                                                    |
| E017 | `alternative patterns cannot bind variables`                                                                                                                                           | `use '_' instead of a name inside alternatives`                                                                                                    |
| E018 | `expected a newline or ';' between statements`                                                                                                                                         | (between match arms the message is the same with `',' ` allowed: `expected a newline or ',' between match arms`)                                   |
| E019 | `duplicate field 'X' in record literal`                                                                                                                                                |                                                                                                                                                    |
| E020 | `undefined variable 'X'`                                                                                                                                                               | `did you mean 'Y'?`                                                                                                                                |
| E021 | `cannot assign to 'X' because it was declared with 'let'` / `… because it is a function` / `… a parameter` / `… a loop variable` / `… a match binding`; `cannot assign to builtin 'X'` | `declare it with 'var' to make it mutable` (let case only)                                                                                         |
| E022 | `'X' is already declared on line N`                                                                                                                                                    | `globals can be declared once; use 'var' and assign instead`                                                                                       |
| E023 | `duplicate binding 'X'`                                                                                                                                                                |                                                                                                                                                    |
| E024 | `'break' can only be used inside a loop` / `'continue' can only be used inside a loop`                                                                                                 |                                                                                                                                                    |
| E025 | `'return' can only be used inside a function`                                                                                                                                          |                                                                                                                                                    |
| E026 | `'X' is used before it is declared`                                                                                                                                                    |                                                                                                                                                    |
| E027 | `'_' can only be used in patterns`                                                                                                                                                     |                                                                                                                                                    |

### 11.2 Runtime errors

| code | message                                                                                                                                                                                                                          | hint / notes                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| R001 | `cannot apply 'OP' to T and U` (binary) / `cannot apply 'OP' to T` (unary)                                                                                                                                                       | string + number: `convert with str() or use interpolation, e.g. "{x}"` |
| R002 | `division by zero`                                                                                                                                                                                                               |                                                                        |
| R004 | `cannot call AT`                                                                                                                                                                                                                 |                                                                        |
| R005 | `'X' expects N argument(s) but got M` — exactly: `expects 1 argument`, `expects 2 arguments`; builtins with ranges: `expects 1 to 3 arguments`, `expects at least 1 argument`. Unnamed functions: `lambda expects …` (no quotes) |                                                                        |
| R006 | `'X' was used before it was defined`                                                                                                                                                                                             |                                                                        |
| R007 | `index N is out of bounds for a list of length M` / `… for a string of length M`                                                                                                                                                 | `insert` uses the list form                                            |
| R008 | `list index must be an integer, got R` / `string index must be an integer, got R`                                                                                                                                                |                                                                        |
| R009 | `cannot index AT`                                                                                                                                                                                                                |                                                                        |
| R010 | `record has no field 'X'`                                                                                                                                                                                                        | `did you mean 'Y'?`                                                    |
| R011 | `cannot read field 'X' of AT` / `cannot set field 'X' on AT`                                                                                                                                                                     |                                                                        |
| R012 | `record keys must be strings, got AT`                                                                                                                                                                                            |                                                                        |
| R013 | `cannot iterate over AT`                                                                                                                                                                                                         |                                                                        |
| R014 | `value R does not match pattern P`                                                                                                                                                                                               | `R` truncated to 60 characters with `…`                                |
| R015 | `no match arm matched the value R`                                                                                                                                                                                               | `R` truncated to 60 characters with `…`                                |
| R016 | `stack overflow: more than 10000 nested calls`                                                                                                                                                                                   |                                                                        |
| R017 | the panic message                                                                                                                                                                                                                |                                                                        |
| R018 | `assertion failed` / `assertion failed: MESSAGE`                                                                                                                                                                                 |                                                                        |
| R019 | `'X' expects DESCRIPTION as argument N, got AT` and the specific messages in §9.1                                                                                                                                                |                                                                        |
| R020 | `cannot pop from an empty list`                                                                                                                                                                                                  |                                                                        |
| R021 | `range step cannot be zero`                                                                                                                                                                                                      |                                                                        |
| R022 | `cannot assign into a string: strings are immutable`                                                                                                                                                                             |                                                                        |
| R024 | `cannot spread AT into a record`                                                                                                                                                                                                 |                                                                        |

(There is no R003 or R023.)
