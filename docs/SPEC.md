# Hindsight Language Specification

Version 0.2. **Normative.** The lexer, parser, compiler, VM, builtins and the test corpus must all
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
- "type name" means the string returned by `type(v)` (§4.1); "article type" is defined in §4.1.

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
- Any other character outside a token is **E001**, reported once per code point (a surrogate pair is
  one code point). The lexer skips it and continues.

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
- If a number is immediately followed by a letter, the whole run of letters, digits and `_` starting
  at the number is **E004**: `3abc`, `1e`, `0x1F`.
- The value is an IEEE-754 double (`Number(lexemeWithoutUnderscores)`).

### 2.6 Strings and interpolation

- Strings are delimited by `"`. They may span lines (raw newlines are kept).
- Escapes: `\n` `\t` `\r` `\0` `\\` `\"` `\{` `\}` and `\u{H…}` with 1–6 hex digits denoting a code
  point ≤ 0x10FFFF (encoded as UTF-16). Any other escape, or a malformed `\u{…}`, is **E003**; the
  lexer keeps the escaped character literally and continues.
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

- An empty interpolation `"{}"` is a syntax error (**E011**).

### 2.7 Punctuators

Longest match wins:

```
...  ..=  ..  .  =>  ==  =  !=  <=  <  >=  >  +=  +  -=  -  **  *=  *  /=  /  %=  %  |>  |
(  )  {  }  [  ]  ,  :  ;
```

There are no `!`, `&&` or `||` operators: use `not`, `and`, `or`. Two `|` tokens in a row (with or
without whitespace or comments between them) form an empty lambda parameter list (§7.12).

### 2.8 Lexical errors

- The lexer reports every **E001**, **E003** and **E004** it meets and keeps going.
- At end of file it reports at most one "unterminated" error: if a string interpolation is open,
  **E006** at the `{` of the outermost open interpolation; otherwise, if a string is open, **E002** at
  its opening `"`; otherwise, if a block comment is open, **E005** at the outermost open `/*`.
- If the lexer reports any error, compilation stops: no syntax or name errors are reported (§11.2).

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
lambda         = "|" [ params ] "|" body
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
- **`fn` at the start of a statement**: followed by `(` it begins an expression statement (an
  anonymous function, e.g. `fn(x) { x }(5)`); followed by anything else it begins a declaration.
- **Lambda parameters.** Inside a lambda's `|…|`, a `|` at the top level of a parameter pattern ends
  the parameter list, so `|a| a + 1` has the parameter `a`. A `|` nested inside a list or record
  pattern (`|[1 | 2]| 0`) is an alternative, which is **E015** outside match arms.
- **Assignment** is a statement, not an expression. The left side must be an identifier (not `_`),
  a member access `a.b`, or an index `a[i]`; anything else is **E012**.
- **Statement separation.** After a statement, the next token must be `;`, a token with
  `newlineBefore`, `}` or end of file; otherwise **E018**. Match arms follow the same rule with `,`
  in place of `;` (a `;` between arms is E018). A `;` that ends nothing (`;;`, or `;` first in a
  block or program) is **E011**.
- Template parts (`STRING_HEAD` …) come from the lexer (§2.6).

### 3.2 Newline sensitivity

Newlines never end an expression on their own, but they stop the parser from _continuing_ one:

1. While parsing an expression in a **newline-sensitive** context, the parser does **not** consume the
   following tokens when they have `newlineBefore = true`; the expression ends before them:
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

3. **Contexts.** The program top level, every block, and the braces of a `match` are
   newline-sensitive. Parentheses `( … )` (grouping or arguments), brackets `[ … ]` (lists and index
   expressions), the braces of a record literal, and string interpolations `{ … }` are
   newline-**insensitive**: rule 1 does not apply inside them. Every other construct (`if`, `while`,
   `for` and `match` headers, arm guards, lambda expression bodies) inherits the context it appears
   in. A block or `match` nested inside brackets is newline-sensitive again.
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

print(match xs {   // valid: arms are newline-separated even inside print( … )
  [] => "empty"
  [x] => "one"
  _ => "many"
})
```

### 3.3 Precedence and operator placement

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

- `not` may appear only at the start of an expression or directly after `and`, `or`, `|>` or another
  `not`. Elsewhere (`1 == not x`, `-not x`, `1 + not x`) it is **E011**.
- E013 and E014 are decided on tokens while parsing: a parenthesized operand never triggers them, so
  `(a < b) == c` and `(1..2)..3` are valid.
- Lambda bodies extend as far right as possible: `|x| x + 1 |> f` is `|x| (x + 1 |> f)`.

### 3.4 Parentheses

Parentheses only group; no rule can observe them. Consequences: `x |> (f(a))` is `f(x, a)` (write
`f(a)` into a variable first to call its result); `let f = (|x| x)` names the lambda `f` (§7.12);
`(a) = 1` assigns to `a`.

### 3.5 Syntax errors

Parsing stops at the **first** syntax error, which is the only diagnostic reported. Syntax errors are
**E010**, **E011**, **E015** `invalid pattern`, **E018** and **E028**.

**E010** `expected EXPECTED but found FOUND`. EXPECTED is either a quoted token (keywords are quoted
without the word "keyword": `'in'`) or `an identifier`:

| situation                                                                                                                                                                     | EXPECTED                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| after an item in a bracketed comma list (arguments, list, record, parameters, lambda parameters, list or record pattern), a token that is neither `,` nor the closing bracket | the closing bracket: `')'`, `']'`, `'}'` or `'\|'` (never `','`) |
| after the expression inside `( … )` grouping, `[ … ]` indexing, or an interpolation                                                                                           | `')'`, `']'`, `'}'`                                              |
| after a `let`/`var` pattern                                                                                                                                                   | `'='`                                                            |
| after a `for` pattern                                                                                                                                                         | `'in'`                                                           |
| where a block is required (if/while/for/fn bodies; after `else` unless `if` follows) and after a match subject                                                                | `'{'`                                                            |
| after an arm's pattern or guard                                                                                                                                               | `'=>'`                                                           |
| after `.`; after `fn` at the start of a statement when `(` does not follow; at the start of a record-literal item that is not `...`, an identifier or a string                | `an identifier`                                                  |
| after `fn NAME`, and after `fn` in an expression                                                                                                                              | `'('`                                                            |
| after a string key in a record literal                                                                                                                                        | `':'`                                                            |
| end of file inside a block or a `match`                                                                                                                                       | `'}'`                                                            |

**E011** `expected an expression but found FOUND`: where an expression must start (or, in a
bracketed list, where an item or the closing bracket may come) and the token cannot start one; a
token where a statement must start but no expression can begin (for example a stray top-level `}`);
an empty statement (§3.1); an empty interpolation.

**E015** `invalid pattern`, exactly when:

- at the start of a pattern, list-pattern item or record-pattern value, the token cannot begin an
  _altPattern_: an interpolated string, `(`, `-` not followed by a number, any keyword other than
  `true`/`false`/`nil`, `...` outside a list pattern; or at the start of a record-pattern item, a
  token other than an identifier or string;
- a complete _altPattern_ is immediately followed by `(`, `[`, `.`, or an operator token other than
  `|`: `+ - * / % ** == != < <= > >= and or |>`, or `..`/`..=` after anything but a number literal;
- a range-pattern bound is not `[-] NUMBER`.

Any other unexpected token after a pattern is **E010** with that context's EXPECTED.

**E018**: see statement separation (§3.1). Between match arms the message is
`expected a newline or ',' between match arms`.

**E028** `expression is nested too deeply`: more than 256 constructs open at once (brackets, braces,
blocks, interpolations, prefix operators), or a syntax tree deeper than 512 levels (for example a
chain of 600 `+` operators). Reported at the token where the limit is exceeded.

### 3.6 Checks after parsing

When the program parses without a syntax error, these checks report **every** occurrence, sorted by
position: **E012**, **E013**, **E014**, **E015** `alternatives ('|') are only allowed in match
patterns` (one per pattern, at its first `|`, reported instead of E017 for that pattern), **E016**,
**E017**, **E019**, **E023**, **E027**. If any is reported, compilation stops: no name errors
(E020–E026) are reported.

`_` directly as an assignment target (`_ = 1`, `_ += 1`) is E012 only. `_` anywhere else in an
expression, including `_.x = 1` and `_[0] = 1`, is E027.

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

The **article type** of a value, used in messages, is `nil` for nil and `a bool`, `a number`,
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
- functions → `<fn NAME>` (NAME per §7.12) and `<fn>` for unnamed functions. Every **builtin** —
  natives and library functions alike — shows as `<builtin NAME>`.
- ranges → `A..B` or `A..=B` (bounds via `show`); a range with step ≠ 1 → `range(A, B, STEP)`.
- **Cycles.** While a list or record is being printed, a reference to that same object nested inside
  it prints as `[...]` or `{...}`. Shared references that are not cyclic print in full each time:
  `let a = [1]` then `print([a, a])` prints `[[1], [1]]`; `var xs = [1]`, `push(xs, xs)`, `print(xs)`
  prints `[1, [...]]`.
- For every non-string value, `show(v) == repr(v)`.
- Nesting depth is unlimited: a 100,000-deep list prints (implementations must not recurse on the
  JavaScript stack in proportion to nesting depth).

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
- Every block introduces a local scope. A function's parameters live in the function's outermost
  scope, visible to the whole body. Each match arm has a scope for its bindings. Each for-loop
  iteration has a scope containing the iteration's bindings and the loop body's statements.
- A local binding is visible from the end of its declaration statement to the end of its scope. A
  `fn` declaration is also visible inside its own body.
- A `let`/`var` initializer is resolved as if its own declaration did not exist: in
  `let x = x + 1`, the initializer's `x` is a visible outer local if there is one, otherwise it is
  resolved by §5.3 — which, for a top-level declaration, finds the global itself and reports E026.
- **Shadowing** is allowed for locals, in nested scopes and in the same scope: a later declaration
  hides the earlier one from that point on.

### 5.3 Name resolution (compile time)

An identifier reference `x` (including assignment targets) resolves to the first match of:

1. a visible local of the current function, innermost scope first, most recent declaration first;
2. a visible local of an enclosing function (captured by reference, §5.6);
3. a global: any top-level declaration of `x` anywhere in the program;
4. a builtin named `x` (§9);
5. otherwise **E020** `undefined variable 'x'`, with the hint `did you mean 'y'?` when some visible
   local, global or builtin name is within Damerau–Levenshtein distance 2 of `x` and that distance is
   smaller than `x`'s length (closest wins; ties go to locals innermost-first, then globals in
   declaration order, then builtins in table order). Compiler-internal names (starting with `$`)
   are never suggested.

**Use before declaration.** If a reference to global `x` (a read or an assignment target) occurs in
top-level code (outside every function and lambda body) at an offset before the end of the first
top-level declaration of `x`, it is **E026**. When a builtin named `x` exists, E026 carries the hint
`this declaration hides the builtin 'x'`. Example: `let max = max(3, 7)` at top level is E026.
References inside functions are late-bound and checked at run time (**R006**).

### 5.4 Globals

- A global name may be declared at most once at top level; a second declaration is **E022**. The
  first declaration defines the global for all other checks.
- Globals and locals may shadow builtins. Builtins themselves are unaffected (library code keeps
  using the original builtin).
- A global is defined when its declaration executes. Reading or assigning it before that is **R006**.

### 5.5 Assignment

- `x = e` requires `x` to resolve to a `var` binding. Otherwise **E021**, with one of the messages in
  §11.1, or E020 when `x` is unknown.
- `target op= e` (op ∈ `+ - * / %`) behaves like `target = target op e`, except that the object and
  index sub-expressions of `target` are evaluated only once. Errors name the plain operator (`'+'`).
- `obj.name = e` and `obj[key] = e` are checked at run time (§7.7–7.9).

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
| `1..10`, `-5..=5`                            | a number `n` with `a <= n < b` (or `<= b` for `..=`) — an interval test, so `5.5` matches `0..10`                       | —                   |
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

### 6.4 Where patterns are used

- match arms: any pattern.
- `let`, `var`, `for`, parameters: any pattern except alternatives. When the value does not match,
  the program stops with **R014**. For a parameter, the check happens when the function is entered,
  after the arity check: the called function's frame is on the stack and the error is reported at
  that parameter's pattern in the function header.

---

## 7. Expressions

### 7.1 Evaluation order

Strictly left to right: left operand before right; callee before arguments; arguments in order;
object before index before assigned value.

### 7.2 Arithmetic

- `+`: number + number → sum; string + string → concatenation; list + list → a **new** list with
  the items of both. Anything else is **R001**; for string + number (either order) the error carries
  the hint `convert with str() or use interpolation, e.g. "{x}"`.
- `-`, `*`, `**`: numbers only (**R001**). `**` is JavaScript `**`.
- `/`: numbers only; a zero divisor is **R002**.
- `%`: numbers only; a zero divisor is **R002**. The result takes the divisor's sign: compute
  `r = a % b` as in JavaScript, and when `r != 0` and `r` and `b` have different signs, the result is
  `r + b`. So `-7 % 3 == 2`, `7 % -3 == -2`, `5 % INF == 5`.
- unary `-`: numbers only (**R001**, unary form).
- Overflow and other IEEE cases follow JavaScript (`2 ** 2000 == Infinity`).

### 7.3 Comparison

- `==` and `!=` use equality (§7.4) and never fail.
- `<`, `<=`, `>`, `>=`: both numbers (numeric order) or both strings (lexicographic by UTF-16 code
  unit, like JavaScript). Anything else is **R001**.

### 7.4 Equality

`equal(a, b)`:

- the same list or record object is equal to itself (checked before its contents);
- different types → false;
- nil, bools, strings: same value; numbers: JavaScript `===` (so `NaN != NaN` and `0 == -0`);
- lists: same length and items pairwise equal;
- records: same key set and equal values per key (order ignored);
- ranges: same start, end, step and inclusivity;
- functions: the same function object.
- If a comparison `(a, b)` is already in progress further up, it counts as equal (cyclic structures
  compare without looping). Nesting depth is unlimited, as in §4.3.

### 7.5 Logical operators

`a and b` → `a` if `a` is falsy, else `b`. `a or b` → `a` if `a` is truthy, else `b`. `not a` →
`true` if `a` is falsy, else `false`. `and`/`or` short-circuit.

### 7.6 Ranges

- `a..b` (end excluded) and `a..=b` (end included) require numbers (**R001** with operator `..` or
  `..=`), step 1. `range(n)` = `0..n`; `range(a, b)` = `a..b`; `range(a, b, step)` is exclusive with
  `step != 0` (**R021**).
- **Elements.** Element `k` is exactly `start + k * step` in double arithmetic (never repeated
  addition). The elements are those for `k = 0, 1, 2, …` up to, not including, the first `k` whose
  element fails the bound test: `< end` (exclusive, step > 0), `<= end` (inclusive, step > 0), or
  `> end` (step < 0). If start, end or step is NaN there are no elements.
- `len(r)` is the number of elements, computed arithmetically (never by iterating); it is `Infinity`
  for an unbounded range such as `0..INF`.
- `for`, spreads and `list` yield exactly these elements (`list(0..INF)` is **R025**).
- `contains(r, v)` is true when `v` is a number equal (`===`) to some element; it is computed
  arithmetically, so it terminates for unbounded ranges. Note: `contains(0..10, 5.5)` is false while
  the _pattern_ `0..10` matches `5.5`.
- Ranges cannot be indexed (**R009**) and are compared structurally (§7.4).

### 7.7 Indexing: `o[i]` and `o[i] = v`

The indexed value's type decides the checks, in this order:

| `o` is | read `o[i]`                                                                                                                                             | write `o[i] = v`                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| list   | `i` not an integer (including non-numbers) → **R008** `list index must be an integer, got R`; negative `i` counts from the end; out of range → **R007** | same; assignment never grows a list (use `push`/`insert`)                    |
| string | **R008** `string index …`; negative from the end; **R007**; result is a one-code-unit string                                                            | always **R022** (checked first)                                              |
| record | `i` not a string → **R012**; missing key → **R010**                                                                                                     | `i` not a string → **R012**; creates or updates the field (new keys go last) |
| other  | **R009** `cannot index AT` (the index is not examined)                                                                                                  | **R009**                                                                     |

R007 prints the index as written by the program (before adding the length to a negative index).

### 7.8 Lists

`[a, b, ...xs]` creates a new list. `...e` inserts every element of any iterable (§8.3); a
non-iterable is **R013**.

### 7.9 Records

- `{a: 1, "b c": 2, d, ...other}` creates a new record, entries in source order. `d` alone means
  `d: d`. `...e` copies every entry of the record `e` (a non-record is **R024**). A later entry for
  the same key replaces the value but keeps the key's original position. Repeating a key in one
  literal, in any spelling (`{a, a: 1}`, `{a: 1, "a": 2}`), is **E019**; keys supplied by a spread
  never count.
- `r.k` reads a field; a missing key is **R010**, with the hint `did you mean 'k2'?` chosen from the
  record's first 10,000 keys by the §5.3 rule (insertion order breaks ties). On a non-record, `.k`
  is **R011** `cannot read field 'k' of AT`.
- `r.k = v` creates or updates the field (new keys go last). On a non-record it is **R011**
  `cannot set field 'k' on AT`.

### 7.10 Calls

- The callee must be a function (**R004**).
- User functions require exactly as many arguments as parameters (**R005**). Builtins declare a
  minimum and maximum (§9).
- Parameters are bound left to right when the function is entered; pattern mismatches are **R014**
  (§6.4).
- **Call depth.** Active calls are the frames of user and library functions; the top-level frame and
  native calls do not count. A call that would create the 10,001st active call raises **R016** at
  that call. So `fn d(n) { if n == 0 { 0 } else { 1 + d(n - 1) } }` runs `d(9999)` and fails on
  `d(10000)`.
- The result is the value of the executed `return`, or else the value of the body block (§7.15).

### 7.11 Pipe

`x |> f(a, b)` means exactly `f(x, a, b)`: when the right side is a call expression, `x` becomes its
first argument (for a call of a call, the outermost call). Otherwise `x |> g` means `g(x)`.
Evaluation order is that of the resulting call. Pipes associate left: `x |> f |> g` is `g(f(x))`.
Errors raised by a piped call are reported at the stage that failed (§10.4).

### 7.12 Functions and lambdas

- `fn name(params) { … }` declares a function. `fn(params) { … }` is an anonymous function
  expression. `|a, b| a + b`, `|| 42` and `|x| { … }` are lambdas.
- **Display names** (used by `show`, stack traces and the debugger): a declared function uses its
  name. An anonymous function or lambda that is the entire initializer of `let NAME =` or
  `var NAME =` (parentheses allowed, §3.4) takes `NAME`. Any other anonymous function is unnamed: it
  shows as `<fn>` and is called `lambda` in messages.
- The top-level code runs in a frame named `<top level>`.

### 7.13 if

`if c { A } else { B }` evaluates to the value of the chosen block. Without `else`, a falsy condition
yields `nil`. `else if` chains as expected.

### 7.14 match

The subject is evaluated once. Arms are tried top to bottom: an arm is chosen when its pattern
matches and its guard (if any) is truthy; the guard sees the arm's bindings. The match evaluates to
the chosen arm's body. When no arm is chosen, **R015**. A match with no arms always fails with R015.

### 7.15 Blocks

A block's value is the value of its last statement when that statement is an expression statement,
otherwise `nil` (a nested block statement is not an expression statement, so `{ 1; { 2 } }` is
`nil`). The empty block's value is `nil`.

---

## 8. Statements

### 8.1 Expression statements

Evaluated for their effects; the value is discarded (except as a block's final value, §7.15).

### 8.2 while

`while c { … }` repeats while `c` is truthy. The condition belongs to the loop: `break` and
`continue` inside it affect this loop.

### 8.3 for

`for p in e { … }` evaluates `e` once — outside the loop, so `break`/`continue` inside `e` affect an
enclosing loop — then iterates:

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

Builtins live in a fixed table: the natives (§9.2), then the library functions (§9.3). Their order is
fixed by `src/core/builtin-names.ts`.

### 9.1 Argument rules for natives

1. **Arity** violations are **R005**: `'NAME' expects 1 argument but got 2`; ranges read
   `expects 1 to 3 arguments`; variadic natives read `expects at least 1 argument`.
2. Arguments are checked **left to right**; only the first failure is reported.
3. Optional arguments are decided by count alone: an explicit `nil` is a value and is checked
   (`join(xs, nil)` is R019; `assert(false, nil)` fails with `assertion failed: nil`).
4. **Index** arguments (`insert`, `remove`, `char_code`) behave like `xs[i]`: a non-integer
   (including a non-number) is **R008**, out of range is **R007**.
5. **Iterable** arguments (`list`) raise **R013** `cannot iterate over AT`.
6. Every other argument problem is **R019** `'NAME' expects DESCRIPTION as argument N, got AT`, with
   the DESCRIPTION listed in §9.2, unless the row gives a specific message.
7. Results that would exceed the size limits raise **R025** (§10.5).

### 9.2 Natives

| name                                          | args  | checks (argument: DESCRIPTION)                                                                                                                                                                                                              | result                                                                                                                                  |
| --------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `print(...values)`                            | 0+    | —                                                                                                                                                                                                                                           | `nil`. One output line: `show` of each value joined by a space.                                                                         |
| `str(v)`                                      | 1     | —                                                                                                                                                                                                                                           | `show(v)`                                                                                                                               |
| `repr(v)`                                     | 1     | —                                                                                                                                                                                                                                           | `repr(v)`                                                                                                                               |
| `type(v)`                                     | 1     | —                                                                                                                                                                                                                                           | the type name                                                                                                                           |
| `len(v)`                                      | 1     | 1: `a list, string, record or range`                                                                                                                                                                                                        | item count, string length, key count, or range length (§7.6)                                                                            |
| `num(v)`                                      | 1     | 1: `a number or string`                                                                                                                                                                                                                     | a number → itself; a string → `Number(s.trim())`, or `nil` when the trimmed string is empty or the result is NaN                        |
| `list(iterable)`                              | 1     | 1: iterable (R013)                                                                                                                                                                                                                          | a new list of the elements (§8.3)                                                                                                       |
| `range(a, b?, step?)`                         | 1–3   | each: `a number`                                                                                                                                                                                                                            | a range (§7.6); step 0 is R021                                                                                                          |
| `assert(cond, message?)`                      | 1–2   | —                                                                                                                                                                                                                                           | `nil`; when `cond` is falsy: **R018** `assertion failed` (one argument) or `assertion failed: SHOW` (two arguments)                     |
| `panic(message)`                              | 1     | —                                                                                                                                                                                                                                           | never returns: **R017** with message `show(message)`                                                                                    |
| `push(list, v)`                               | 2     | 1: `a list`                                                                                                                                                                                                                                 | `nil`; appends                                                                                                                          |
| `pop(list)`                                   | 1     | 1: `a list`                                                                                                                                                                                                                                 | removes and returns the last item; empty: **R020**                                                                                      |
| `insert(list, index, v)`                      | 3     | 1: `a list`; 2: index (rule 4); a negative index means `len + index`; valid results are `0..=len`                                                                                                                                           | `nil`; inserts before the item at that position                                                                                         |
| `remove(list, index)`                         | 2     | 1: `a list`; 2: index (rule 4)                                                                                                                                                                                                              | removes and returns the item                                                                                                            |
| `slice(seq, start, end?)`                     | 2–3   | 1: `a list or string`; 2, 3: `a number`                                                                                                                                                                                                     | a new list or string, exactly JavaScript `slice` (truncation, negatives from the end, clamping)                                         |
| `reverse(seq)`                                | 1     | 1: `a list or string`                                                                                                                                                                                                                       | a new reversed list, or a string with its code units reversed                                                                           |
| `sort(list)`                                  | 1     | 1: `a list`; items must be all numbers or all strings, else **R019** `'sort' can only sort a list of all numbers or all strings`                                                                                                            | a new list in ascending order; numbers numerically, strings by UTF-16 code units (like `<`, never locale-aware); stable                 |
| `contains(c, v)`                              | 2     | 1: `a list, string, record or range`; when `c` is a string, 2: `a string`                                                                                                                                                                   | list: some item equal (§7.4) to `v`; string: `v` is a substring; record: `v` is a string and a key; range: §7.6 (false for non-numbers) |
| `index_of(seq, v)`                            | 2     | 1: `a list or string`; when `seq` is a string, 2: `a string`                                                                                                                                                                                | index of the first equal item or of the first occurrence of the substring, else `-1`                                                    |
| `join(list, separator?)`                      | 1–2   | 1: `a list`; 2: `a string`                                                                                                                                                                                                                  | `show` of each item joined by `separator` (default `""`)                                                                                |
| `min(...)` / `max(...)`                       | 1+    | with one list argument: its items must be numbers — **R019** `'min' expects a list of numbers as argument 1, got AT` (AT of the first bad item), empty list: **R019** `'min' expects a non-empty list`; otherwise each argument: `a number` | the smallest / largest number, with JavaScript `Math.min` / `Math.max` semantics (NaN propagates). `max` reads `'max'` in messages.     |
| `copy(v)`                                     | 1     | 1: `a list or record`                                                                                                                                                                                                                       | a shallow copy                                                                                                                          |
| `keys(r)` / `values(r)` / `entries(r)`        | 1     | 1: `a record`                                                                                                                                                                                                                               | the keys / values / `[key, value]` lists, in insertion order                                                                            |
| `has(r, key)`                                 | 2     | 1: `a record`; 2: `a string`                                                                                                                                                                                                                | bool                                                                                                                                    |
| `get(r, key, default?)`                       | 2–3   | 1: `a record`; 2: `a string`                                                                                                                                                                                                                | the value, or `default` (`nil` when omitted) when the key is missing                                                                    |
| `delete(r, key)`                              | 2     | 1: `a record`; 2: `a string`                                                                                                                                                                                                                | removes the key; returns the old value or `nil`                                                                                         |
| `upper(s)` / `lower(s)` / `trim(s)`           | 1     | 1: `a string`                                                                                                                                                                                                                               | JavaScript `toUpperCase` / `toLowerCase` / `trim` (locale-independent)                                                                  |
| `split(s, separator)`                         | 2     | both: `a string`                                                                                                                                                                                                                            | JavaScript `s.split(separator)`; `""` splits into code units                                                                            |
| `replace(s, from, to)`                        | 3     | all: `a string`                                                                                                                                                                                                                             | JavaScript `s.split(from).join(to)` (every occurrence, no special characters)                                                           |
| `starts_with(s, p)` / `ends_with(s, p)`       | 2     | both: `a string`                                                                                                                                                                                                                            | bool                                                                                                                                    |
| `repeat(s, n)`                                | 2     | 1: `a string`; 2: `a non-negative integer`                                                                                                                                                                                                  | `s` repeated `n` times                                                                                                                  |
| `chars(s)`                                    | 1     | 1: `a string`                                                                                                                                                                                                                               | a list of one-code-unit strings                                                                                                         |
| `char_code(s, index?)`                        | 1–2   | 1: `a string`; 2: index (rule 4, string form), default 0                                                                                                                                                                                    | the code unit at the index                                                                                                              |
| `from_char_code(n)`                           | 1     | 1: `an integer from 0 to 65535`                                                                                                                                                                                                             | a one-code-unit string                                                                                                                  |
| `pad_start(s, width, fill?)` / `pad_end(…)`   | 2–3   | 1: `a string`; 2: `a number`; 3: `a string`                                                                                                                                                                                                 | JavaScript `padStart` / `padEnd` (`fill` defaults to `" "`)                                                                             |
| `abs` `floor` `ceil` `sqrt` `sin` `cos` `log` | 1     | 1: `a number`                                                                                                                                                                                                                               | JavaScript `Math.abs` … `Math.log` (natural log)                                                                                        |
| `round(x)`                                    | 1     | 1: `a number`                                                                                                                                                                                                                               | nearest integer, halves away from zero (`round(-2.5) == -3`, `round(2.5) == 3`)                                                         |
| `atan2(y, x)`                                 | 2     | both: `a number`                                                                                                                                                                                                                            | JavaScript `Math.atan2`                                                                                                                 |
| `random()`                                    | 0     | —                                                                                                                                                                                                                                           | a number in `[0, 1)` (§10.3)                                                                                                            |
| `random_int(lo, hi)`                          | 2     | both: `an integer`; when `lo > hi`: **R019** `'random_int' expects lo <= hi`                                                                                                                                                                | an integer in `[lo, hi]` (§10.3)                                                                                                        |
| `seed(n)`                                     | 1     | 1: `a number`                                                                                                                                                                                                                               | `nil`; resets the generator (§10.3)                                                                                                     |
| `steps()`                                     | 0     | —                                                                                                                                                                                                                                           | the number of steps executed before this call (§10.1); absolute values depend on code generation                                        |
| `PI`, `INF`                                   | value | —                                                                                                                                                                                                                                           | the constants π and `Infinity` (numbers, not functions)                                                                                 |

### 9.3 Library functions

`map`, `filter`, `reduce`, `each`, `find`, `find_index`, `any`, `all`, `count`, `sum`, `sort_by`,
`zip`, `enumerate`, `flat_map`, `flatten`, `take`, `drop`, `uniq`, `group_by`, `min_by`, `max_by`,
`times` and `chunk` are written in Hindsight. **Appendix A is their normative source**:
`src/core/prelude.ts` contains exactly that text. Their behavior, including evaluation order, how
often callbacks run, edge cases and error codes, is whatever that source does under this
specification. They do no argument checks besides the `assert` calls in the source. They run as
_library_ code: debuggers may skip their frames, and errors inside them are reported at the user's
call (§10.4). In brief:

| name                                                                | result                                                                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `map(xs, f)`, `filter(xs, f)`, `reduce(xs, f, init)`, `each(xs, f)` | the usual; `each` returns `nil`                                                   |
| `find(xs, f)`, `find_index(xs, f)`                                  | first item with `f(x)` truthy (else `nil`) / its index (else `-1`)                |
| `any(xs, f)`, `all(xs, f)`, `count(xs, f)`, `sum(xs)`               | bool / bool / number of matches / numeric sum (`0` for none)                      |
| `sort_by(xs, key)`                                                  | stable merge sort by `key(x)` (computed once per item, compared with `<`)         |
| `zip(a, b)`, `enumerate(xs)`                                        | `[[a0, b0], …]` up to the shorter length / `[[0, x0], [1, x1], …]`                |
| `flat_map(xs, f)`, `flatten(xs)`                                    | concatenation of the iterables `f(x)` / of the items                              |
| `take(xs, n)`, `drop(xs, n)`                                        | the first `n` items / all but the first `n` (`n` a non-negative integer)          |
| `uniq(xs)`                                                          | items without later duplicates (§7.4), in first-seen order                        |
| `group_by(xs, key)`                                                 | a record from `str(key(x))` to the list of items with that key                    |
| `min_by(xs, f)`, `max_by(xs, f)`                                    | the item with the smallest / largest `f(x)` (first wins ties; `nil` when empty)   |
| `times(n, f)`, `chunk(xs, n)`                                       | `[f(0), …, f(n - 1)]` / consecutive lists of length `n` (the last may be shorter) |

Every library function first converts `xs` with `list(xs)`, so any iterable works and a non-iterable
fails with **R013** `cannot iterate over AT`.

---

## 10. Execution model

### 10.1 Steps and time

A **step** is the execution of one VM instruction. A run is a sequence of steps `0, 1, …, N-1`.
**Time** `t` (an integer in `0..=N`) names the state _before_ step `t`; time `N` is the state after
the run ends. If step `k` raises a runtime error, the run ends with `N = k`: time `N` is the state
just before the failing instruction, so the operands that caused the error are still visible.

### 10.2 Output

`print` produces one **output event** per call: the text (no trailing newline; it may contain
newlines) and the time of the step that executed the call. The text is visible in every state after
that time.

### 10.3 Determinism and the random generator

Running the same program with the same seed produces the same steps, output and states. The only
source of randomness is the VM's generator, whose state is part of the VM state:

- The state is an unsigned 32-bit integer. A run starts with state `ToUint32(seed)` (JavaScript
  `seed >>> 0`), where the seed defaults to `42`. `seed(n)` sets the state to `n >>> 0`.
- `random()` advances the state with **mulberry32** and returns the draw:

  ```js
  state = (state + 0x6d2b79f5) >>> 0
  let t = state
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  ```

- `random_int(lo, hi)` is `lo + floor(random() * (hi - lo + 1))`, using exactly one draw.

There is no clock, input or I/O besides `print`. The absolute values returned by `steps()` and the
last digits of `sin`, `cos`, `log`, `atan2` and non-integer `**` results are implementation-defined;
conformance tests must not print them.

### 10.4 Runtime errors and their locations

A runtime error stops the program. It carries its code, message, optional hint, a span, and the call
stack (innermost first, each frame with its display name and the span of its current instruction).
An error's **line** is the line where its span starts. The span is that of the failing operation:

| errors                                                     | span                                                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| R001, R002 from a binary operator                          | the whole binary expression                                                               |
| R001 from unary `-`                                        | the unary expression                                                                      |
| R004, R005, R016, and every error raised by a native       | the call expression; for a call written with `\|>`, from the `\|>` to the end of the call |
| any error inside library code                              | the call, in the innermost user-code frame, that entered library code                     |
| R014 in `let`, `var`, `for`                                | the pattern                                                                               |
| R014 for a parameter                                       | that parameter's pattern in the function header                                           |
| R015                                                       | the match subject                                                                         |
| R006                                                       | the identifier                                                                            |
| R007, R008, R009, R012, R022 from indexing (read or write) | the index expression `o[i]`, from the start of `o` to `]`                                 |
| R010, R011                                                 | from the `.` to the end of the field name                                                 |
| R013 in `for`                                              | the `for` header (`for p in e`)                                                           |
| R013, R024 from a spread                                   | the `...e` element                                                                        |
| R025 from an operator, an interpolation or a literal       | that expression                                                                           |

### 10.5 Limits

- **Calls**: 10,000 active calls (§7.10, **R016**).
- **Size**: no operation may create a list with more than 2^24 items, a record with more than 2^24
  keys, or a string longer than 2^24 code units. The check happens before the result is built, and
  failing it is **R025** `result too large`. It applies to `+`, interpolation, list and record
  literals and spreads, `push`/`insert`, field creation, `list`, `repeat`, `pad_start`/`pad_end`,
  `replace`, `join`, `split`, `chars`, `str`, `repr` and `print`. Unbounded ranges remain legal for
  `for` and `contains`.
- **Memory**: a run may allocate at most 2^26 units in total, counting each list item, record entry
  and string code unit that an allocating operation creates: list and record literals, spreads,
  field creation, `+` on strings and lists, interpolation, rest bindings, `push`/`insert`, `list`,
  `copy`, `slice`, `reverse`, `sort`, `keys`/`values`/`entries`, `split`, `chars`, `join`,
  `repeat`, `pad_start`/`pad_end`, `replace`, `upper`/`lower`/`trim`, `str`, `repr` and `print`.
  The budget is cumulative (it is never refunded); an operation that would exceed it fails with
  **R025** `memory limit exceeded` instead of producing its result. It is part of the VM state, so
  replays fail at the same step.
- **Steps**: chosen by the host (the studio defaults to 2,000,000). Reaching the limit is not an
  error; the run ends with outcome _step limit_ and can be resumed by tools that support it.

---

## 11. Diagnostics catalog

Placeholders: `X` a name, `C` a character, `N`/`M` numbers, `T`/`U` type names, `AT` an article
type (§4.1), `R` a `repr`, `OP` an operator, `P` the pattern's exact source text, `FOUND` a token
description (below). Messages never end with a period. Hints are separate text.

**Token descriptions** (`FOUND`): `'OP'` for punctuators (e.g. `')'`), `keyword 'K'`,
`identifier 'X'`, `number N` (the lexeme), `string`, `end of file`.

**Truncated reprs.** In R014 and R015, a `repr` longer than 60 UTF-16 code units is cut to its first
59 code units followed by `…` (U+2026).

### 11.1 Compile errors

A diagnostic's **line** is the line where its span starts. When FOUND is end of file, the span is the
empty span just after the last non-whitespace character of the source (comments included).

| code | message                                                                                         | span (anchor)                                | hint                                                                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| E001 | `unexpected character 'C'`                                                                      | the character                                | `!`: `use 'not' for negation or '!=' for inequality`; `&`: `use 'and'`; `'` or `` ` ``: `strings use double quotes`; `#`: `comments start with //` |
| E002 | `unterminated string`                                                                           | the opening `"`                              |                                                                                                                                                    |
| E003 | `unknown escape sequence '\C'` / `invalid unicode escape`                                       | the escape, from its `\`                     |                                                                                                                                                    |
| E004 | `invalid number literal 'LEXEME'`                                                               | the lexeme                                   |                                                                                                                                                    |
| E005 | `unterminated block comment`                                                                    | the outermost open `/*`                      |                                                                                                                                                    |
| E006 | `unterminated string interpolation`                                                             | the `{` of the outermost open interpolation  |                                                                                                                                                    |
| E010 | `expected EXPECTED but found FOUND` (§3.5)                                                      | the found token                              |                                                                                                                                                    |
| E011 | `expected an expression but found FOUND`                                                        | the found token                              |                                                                                                                                                    |
| E012 | `invalid assignment target`                                                                     | the target                                   |                                                                                                                                                    |
| E013 | `comparison operators cannot be chained`                                                        | the second operator                          | `write 'a < b and b < c'`                                                                                                                          |
| E014 | `range operators cannot be chained`                                                             | the second operator                          |                                                                                                                                                    |
| E015 | `invalid pattern` / `alternatives ('\|') are only allowed in match patterns`                    | the offending token / the first `\|`         |                                                                                                                                                    |
| E016 | `a list pattern can contain at most one '...rest'`                                              | the second `...`                             |                                                                                                                                                    |
| E017 | `alternative patterns cannot bind variables`                                                    | the bound name                               | `use '_' instead of a name inside alternatives`                                                                                                    |
| E018 | `expected a newline or ';' between statements` / `expected a newline or ',' between match arms` | the found token                              |                                                                                                                                                    |
| E019 | `duplicate field 'X' in record literal`                                                         | the repeated key                             |                                                                                                                                                    |
| E020 | `undefined variable 'X'`                                                                        | the identifier                               | `did you mean 'Y'?` (§5.3)                                                                                                                         |
| E021 | `cannot assign to 'X' because it was declared with 'let'`                                       | the target identifier                        | `declare it with 'var' to make it mutable`                                                                                                         |
| E021 | `cannot assign to 'X' because it is a function`                                                 | the target identifier                        |                                                                                                                                                    |
| E021 | `cannot assign to 'X' because it is a parameter`                                                | the target identifier                        |                                                                                                                                                    |
| E021 | `cannot assign to 'X' because it is a loop variable`                                            | the target identifier                        |                                                                                                                                                    |
| E021 | `cannot assign to 'X' because it is a match binding`                                            | the target identifier                        |                                                                                                                                                    |
| E021 | `cannot assign to builtin 'X'`                                                                  | the target identifier                        |                                                                                                                                                    |
| E022 | `'X' is already declared on line N` (N: line of the first declaration's binding name)           | the binding name in the repeated declaration | `globals can be declared once; use 'var' and assign instead`                                                                                       |
| E023 | `duplicate binding 'X'`                                                                         | the second occurrence                        |                                                                                                                                                    |
| E024 | `'break' can only be used inside a loop` / `'continue' can only be used inside a loop`          | the keyword                                  |                                                                                                                                                    |
| E025 | `'return' can only be used inside a function`                                                   | the keyword                                  |                                                                                                                                                    |
| E026 | `'X' is used before it is declared`                                                             | the identifier                               | `this declaration hides the builtin 'X'` (when one exists)                                                                                         |
| E027 | `'_' can only be used in patterns`                                                              | the `_`                                      |                                                                                                                                                    |
| E028 | `expression is nested too deeply`                                                               | the token where the limit was exceeded       |                                                                                                                                                    |

### 11.2 Which compile errors are reported

Compilation runs in stages and stops after the first stage that reports anything:

1. **Lexer**: every E001, E003, E004, plus at most one of E002/E005/E006 (§2.8).
2. **Parser**: the first syntax error only — E010, E011, E015 `invalid pattern`, E018 or E028 (§3.5).
3. **Checks after parsing**: every E012, E013, E014, E015 (alternatives), E016, E017, E019, E023,
   E027 (§3.6).
4. **Names**: every E020, E021, E022, E024, E025, E026.

Within a stage, diagnostics are sorted by position, and exact duplicates are removed. Hindsight 0.2
has no warnings.

### 11.3 Runtime errors

| code | message                                                                                                                                                                                                        | hint / notes                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| R001 | `cannot apply 'OP' to T and U` (binary) / `cannot apply 'OP' to T` (unary)                                                                                                                                     | string + number: `convert with str() or use interpolation, e.g. "{x}"`. OP is always the plain operator. |
| R002 | `division by zero`                                                                                                                                                                                             |                                                                                                          |
| R004 | `cannot call AT`                                                                                                                                                                                               |                                                                                                          |
| R005 | `'X' expects N argument(s) but got M` — exactly `expects 1 argument`, `expects 2 arguments`, `expects 1 to 3 arguments`, `expects at least 1 argument`. Unnamed functions read `lambda expects …` (no quotes). |                                                                                                          |
| R006 | `'X' was used before it was defined`                                                                                                                                                                           |                                                                                                          |
| R007 | `index N is out of bounds for a list of length M` / `… for a string of length M`                                                                                                                               | N as written                                                                                             |
| R008 | `list index must be an integer, got R` / `string index must be an integer, got R`                                                                                                                              |                                                                                                          |
| R009 | `cannot index AT`                                                                                                                                                                                              |                                                                                                          |
| R010 | `record has no field 'X'`                                                                                                                                                                                      | `did you mean 'Y'?` (§7.9)                                                                               |
| R011 | `cannot read field 'X' of AT` / `cannot set field 'X' on AT`                                                                                                                                                   |                                                                                                          |
| R012 | `record keys must be strings, got AT`                                                                                                                                                                          |                                                                                                          |
| R013 | `cannot iterate over AT`                                                                                                                                                                                       |                                                                                                          |
| R014 | `value R does not match pattern P`                                                                                                                                                                             | R truncated                                                                                              |
| R015 | `no match arm matched the value R`                                                                                                                                                                             | R truncated                                                                                              |
| R016 | `stack overflow: more than 10000 nested calls`                                                                                                                                                                 |                                                                                                          |
| R017 | the panic message                                                                                                                                                                                              |                                                                                                          |
| R018 | `assertion failed` / `assertion failed: MESSAGE`                                                                                                                                                               |                                                                                                          |
| R019 | `'X' expects DESCRIPTION as argument N, got AT`, and the specific messages in §9.2                                                                                                                             |                                                                                                          |
| R020 | `cannot pop from an empty list`                                                                                                                                                                                |                                                                                                          |
| R021 | `range step cannot be zero`                                                                                                                                                                                    |                                                                                                          |
| R022 | `cannot assign into a string: strings are immutable`                                                                                                                                                           |                                                                                                          |
| R024 | `cannot spread AT into a record`                                                                                                                                                                               |                                                                                                          |
| R025 | `result too large` / `memory limit exceeded` (§10.5)                                                                                                                                                           |                                                                                                          |

(There is no R003 or R023.)

---

## Appendix A. Library source

`src/core/prelude.ts` exports exactly the following text as `PRELUDE_SOURCE` (a test enforces it).

```hindsight
fn map(xs, f) {
  var out = []
  for x in list(xs) {
    push(out, f(x))
  }
  out
}

fn filter(xs, f) {
  var out = []
  for x in list(xs) {
    if f(x) { push(out, x) }
  }
  out
}

fn reduce(xs, f, init) {
  var acc = init
  for x in list(xs) {
    acc = f(acc, x)
  }
  acc
}

fn each(xs, f) {
  for x in list(xs) {
    f(x)
  }
  nil
}

fn find(xs, f) {
  for x in list(xs) {
    if f(x) { return x }
  }
  nil
}

fn find_index(xs, f) {
  var i = 0
  for x in list(xs) {
    if f(x) { return i }
    i += 1
  }
  -1
}

fn any(xs, f) {
  for x in list(xs) {
    if f(x) { return true }
  }
  false
}

fn all(xs, f) {
  for x in list(xs) {
    if not f(x) { return false }
  }
  true
}

fn count(xs, f) {
  var n = 0
  for x in list(xs) {
    if f(x) { n += 1 }
  }
  n
}

fn sum(xs) {
  var total = 0
  for x in list(xs) {
    total = total + x
  }
  total
}

fn sort_by(xs, key) {
  var items = []
  for x in list(xs) {
    push(items, [key(x), x])
  }
  let n = len(items)
  var width = 1
  while width < n {
    var merged = []
    var lo = 0
    while lo < n {
      let mid = min(lo + width, n)
      let hi = min(lo + 2 * width, n)
      var i = lo
      var j = mid
      while i < mid and j < hi {
        if items[j][0] < items[i][0] {
          push(merged, items[j])
          j += 1
        } else {
          push(merged, items[i])
          i += 1
        }
      }
      while i < mid {
        push(merged, items[i])
        i += 1
      }
      while j < hi {
        push(merged, items[j])
        j += 1
      }
      lo = hi
    }
    items = merged
    width = width * 2
  }
  var out = []
  for pair in items {
    push(out, pair[1])
  }
  out
}

fn zip(a, b) {
  let left = list(a)
  let right = list(b)
  let n = min(len(left), len(right))
  var out = []
  var i = 0
  while i < n {
    push(out, [left[i], right[i]])
    i += 1
  }
  out
}

fn enumerate(xs) {
  var out = []
  var i = 0
  for x in list(xs) {
    push(out, [i, x])
    i += 1
  }
  out
}

fn flat_map(xs, f) {
  var out = []
  for x in list(xs) {
    for y in list(f(x)) {
      push(out, y)
    }
  }
  out
}

fn flatten(xs) {
  var out = []
  for x in list(xs) {
    for y in list(x) {
      push(out, y)
    }
  }
  out
}

fn take(xs, n) {
  assert(type(n) == "number" and n >= 0 and n == floor(n), "'take' expects a non-negative integer")
  var out = []
  for x in list(xs) {
    if len(out) >= n { break }
    push(out, x)
  }
  out
}

fn drop(xs, n) {
  assert(type(n) == "number" and n >= 0 and n == floor(n), "'drop' expects a non-negative integer")
  var out = []
  var i = 0
  for x in list(xs) {
    if i >= n { push(out, x) }
    i += 1
  }
  out
}

fn uniq(xs) {
  var out = []
  for x in list(xs) {
    if not contains(out, x) { push(out, x) }
  }
  out
}

fn group_by(xs, key) {
  var groups = {}
  for x in list(xs) {
    let k = str(key(x))
    if has(groups, k) {
      push(groups[k], x)
    } else {
      groups[k] = [x]
    }
  }
  groups
}

fn min_by(xs, f) {
  var best = nil
  var best_key = nil
  var first = true
  for x in list(xs) {
    let k = f(x)
    if first or k < best_key {
      best = x
      best_key = k
      first = false
    }
  }
  best
}

fn max_by(xs, f) {
  var best = nil
  var best_key = nil
  var first = true
  for x in list(xs) {
    let k = f(x)
    if first or k > best_key {
      best = x
      best_key = k
      first = false
    }
  }
  best
}

fn times(n, f) {
  assert(type(n) == "number" and n >= 0 and n == floor(n), "'times' expects a non-negative integer")
  var out = []
  var i = 0
  while i < n {
    push(out, f(i))
    i += 1
  }
  out
}

fn chunk(xs, n) {
  assert(type(n) == "number" and n >= 1 and n == floor(n), "'chunk' expects a positive integer")
  var out = []
  var current = []
  for x in list(xs) {
    push(current, x)
    if len(current) == n {
      push(out, current)
      current = []
    }
  }
  if len(current) > 0 { push(out, current) }
  out
}
```
