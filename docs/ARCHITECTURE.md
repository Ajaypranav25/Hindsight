# Hindsight Architecture

Version 0.2. **Normative for internal contracts.** `docs/SPEC.md` defines the language; this document
defines how the implementation is split into modules and the exact contracts between them. Contract
types live in code and are the source of truth for shapes:

| contract file               | defines                                                             |
| --------------------------- | ------------------------------------------------------------------- |
| `src/core/span.ts`          | `Span`, `LineIndex`                                                 |
| `src/core/diagnostics.ts`   | `Diagnostic`, error codes, "did you mean" helpers                   |
| `src/core/tokens.ts`        | `Token`, `TokenKind`                                                |
| `src/core/ast.ts`           | the AST                                                             |
| `src/core/bytecode.ts`      | opcodes, `FunctionProto`, `Program`, pattern descriptors            |
| `src/core/builtin-names.ts` | the builtin table order                                             |
| `src/core/runtime-types.ts` | runtime values, frames, `VM`, `VMHooks`, `NativeContext`, `Library` |
| `src/core/api-types.ts`     | `Recording`, `StateView`, provenance and navigation types           |

---

## 1. Repository layout

```
docs/                 SPEC.md (language), ARCHITECTURE.md (this file)
src/core/             the language; zero runtime dependencies; no DOM, no Node APIs
  span.ts diagnostics.ts tokens.ts lexer.ts ast.ts parser*.ts ast-print.ts
  bytecode.ts compiler/ disasm.ts verify.ts
  builtin-names.ts runtime-types.ts values.ts natives*.ts prelude.ts library.ts vm*.ts
  recorder*.ts navigator*.ts provenance*.ts inspector*.ts api-types.ts index.ts
  testing/            test-only helpers (bytecode assembler, fixtures)
src/conformance/      the corpus annotation parser and checker (shared by tests and the CLI)
src/cli/              the `hindsight` command-line tool (Node)
src/studio/           the web studio (React + CodeMirror 6 + zustand)
tests/lang/**.sight   the conformance corpus (§10.2)
tests/*.test.ts       cross-module tests (corpus runner, time-travel properties, API)
e2e/                  Playwright tests for the studio
examples/             gallery programs shown in the studio
```

Module dependency direction (no cycles):

```
span ← diagnostics ← tokens ← lexer ← parser(ast) ← compiler(bytecode, builtin-names)
runtime-types ← values ← natives ← vm(bytecode)      library(compiler, vm, natives, prelude)
recorder(vm) ← navigator, provenance, inspector     index(all of the above)
```

The compiler never imports `library.ts`; `vm*.ts` never imports `library.ts` or the compiler.
`index.ts` wires them together.

## 2. Conventions

- TypeScript strict mode, ES2022, ESM, no default exports, `import type` for type-only imports
  (`verbatimModuleSyntax`). Prettier formats everything (`npm run format`).
- `src/core` must type-check without DOM or Node types (`tsconfig.core.json`). Host facilities
  (timers, `MessageChannel`) are reached through `globalThis` with narrow local interfaces.
- **Mutation policy.** Application and UI state is immutable (new objects, never in-place edits).
  The VM, recorder and compiler internals are deliberately imperative for speed: they own their
  mutable state and never expose it for writing. Everything a module returns to callers (AST,
  `Program`, `StateView`, events) is treated as immutable by every consumer.
- Errors: internal invariant violations throw `InternalError` (a bug). User-facing problems are
  `Diagnostic`s (compile time) or runtime errors (`RuntimeErrorInfo`). Nothing user-triggered may
  throw a raw JavaScript exception out of `lex`, `parse`, `compile`, `run` or `record` — including
  stack overflows: algorithms over user data (show, repr, equals, snapshot, restore, heap walks) use
  explicit work stacks, never JavaScript recursion proportional to nesting depth.
- No `console.log` in `src/core` or `src/studio`. Files stay under 800 lines; split by
  responsibility.
- Unit tests sit next to their module (`lexer.test.ts`), use Vitest, Arrange–Act–Assert, and
  descriptive names.

## 3. Pipeline

```
source ──lex──▶ tokens ──parse──▶ AST ──compile──▶ Program (FunctionProtos + debug info)
                                                      │
                     library (prelude, natives) ──────┤
                                                      ▼
                              VM ◀── recorder (trace, snapshots, events) ──▶ Recording
                                                     ├─ navigator (step / continue)
                                                     ├─ provenance (origin / history)
                                                     └─ inspector (StateView, objectAt)
```

## 4. Front end

### 4.1 Lexer — `lex(source): LexResult`

`LexResult = { tokens: Token[]; comments: Span[]; diagnostics: Diagnostic[] }`.

- Implements SPEC §2 exactly, including §2.8 (every E001/E003/E004; at most one of E002/E005/E006 at
  end of file). `comments` lists every comment's span (the studio highlights them).
- Always ends with one `EOF` token, span `[len, len]`. An E004 run is emitted as one `Number` token
  covering the run with value `NaN`. Never throws.

### 4.2 Parser — `parse(source): ParseResult`

`ParseResult = { program: ast.Program; diagnostics: Diagnostic[] }`.

- `parse` lexes internally. If the lexer reported anything, it returns those diagnostics and an empty
  program without parsing.
- Recursive descent over SPEC §3. **Newline sensitivity** (§3.2) uses a context stack: push
  `sensitive` for the program top level, every block and the braces of a `match`; push `insensitive`
  for `( )`, `[ ]`, record-literal braces and string interpolations; everything else inherits.
- **No recovery.** The first syntax error (E010, E011, E015 `invalid pattern`, E018, E028) stops
  parsing; `parse` returns exactly that one diagnostic (SPEC §3.5, §11.2).
- **Checks after parsing** (E012, E013, E014, E015 alternatives, E016, E017, E019, E023, E027) are
  recorded while parsing without stopping. They are returned, sorted, only when no syntax error
  occurred (SPEC §3.6).
- **Nesting limits** (E028): count open brackets, braces, blocks, interpolations and prefix
  operators (limit 256) and track each node's tree depth (limit 512), so the parser and every later
  recursive pass stay far from the JavaScript stack limit.
- Diagnostic spans follow the anchor column of SPEC §11.1 (EOF findings use the empty span just after
  the last non-whitespace character).
- **Pipes**: a pipe whose right side is a `Call` inserts the left operand as that call's first
  argument; otherwise it becomes `Call(rhs, [lhs])`. The call's `span` covers the whole pipe
  expression; `pipe = true`; `pipeSpan` runs from the `|>` token to the end of the right side.
- `Member.accessSpan` runs from the `.` to the end of the name.
- `ast-print.ts`: `printAst(node)` gives a compact S-expression for tests.

### 4.3 Compiler — `compileProgram(ast, options): CompileOutput`

`options = { source: string; mode: 'main' | 'library'; firstProtoId: number }`,
`CompileOutput = { program: Program | null; diagnostics: Diagnostic[] }`, exported from
`src/core/compiler/index.ts`.

The compiler reports the name stage of SPEC §11.2 (E020, E021, E022, E024, E025, E026; every
occurrence; sorted). Each function being compiled has a `FunctionState` with scopes, upvalues, the
code under construction, debug tables and the **tracked stack depth**. Protos are numbered
`firstProtoId, firstProtoId + 1, …` in creation order, script first.

#### 4.3.1 Stack depth and slots

- Every frame's stack region starts with slot 0 = the callee closure, then parameters in slots
  `1..arity`. The compiler tracks `depth` = number of values in the region (initially `1 + arity`).
- Every emitted instruction updates `depth` by its stack effect (§5.2). At control-flow joins the
  depths of all incoming paths are equal. `Return`, `Jump` and `NoMatch` are terminators: the depth
  after them is whatever the join or the next label requires.
- **A local's slot is the depth position its value occupies**: after the initializer leaves `m`
  binding values on the stack, those locals get slots `depth - m … depth - 1`. Temporaries may sit
  below a block's locals (`1 + if c { let z = 2; z } else { 0 }`): slots are depth positions, not
  local counts.
- After `return`, `break` or `continue`, the following code in the same block is unreachable; keep
  tracking `depth` as if the statement had not changed it.

#### 4.3.2 Scopes and live ranges

- A scope records `startDepth` and its locals. The operand of the scope-closing instruction is
  computed from depths, never from a count of registered locals: `PopN (depth − startDepth)` in
  statement mode, `EndScope (depth − startDepth − 1)` in value mode (the kept value is on top).
  `Declare 0`, `PopN 0` and `EndScope 0` are never emitted.
- **Value-mode block end** (the block's value is needed): `EndScope n`. **Statement-mode block end**
  (loop bodies, statement-level blocks): `PopN n`.
- **Live ranges** (`LocalInfo.startIp/endIp`): `startIp` is the ip just after the `Declare` (or the
  instruction that pushed a hidden local). `endIp` is the ip just after the scope-closing
  instruction emitted at the end of that scope's code: the block's `EndScope`/`PopN`, a match arm's
  `EndScope m`, the for-iteration `PopN m`, the `L_x: Pop` of `$iter`, the `L_end: EndScope 1` of
  `$subject`. A `PopN` emitted by `break`, `continue` or a failed guard never ends a live range (the
  inspector also hides slots above the frame's current stack top). A binding may have several
  `LocalInfo` entries, one per contiguous range: each binding of a guarded arm gets a second entry
  covering the guard-failure `PopN` (`[L_gf, L_gf + 2)`).
- The function body block is a scope nested inside the parameter scope: its `EndScope` never removes
  parameters, `$argI` slots or prologue bindings, whose `endIp` is `code.length`.
- Globals are only created by statements directly at top level in `mode: 'main'`.

#### 4.3.3 Emission recipes

The recipes are exact: no peephole optimization (instruction counts are observable through
`steps()` and the debugger). `d` is the tracked depth when the construct starts. "stmtStart" marks a
step-over-able unit (§4.3.5).

| construct                                                     | code                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| program (`main`)                                              | statements…; `Nil`; `Return`                                                                                                                                                                                                                                                                                                           |
| expression statement (including statement-level `if`/`match`) | expr; `Pop`                                                                                                                                                                                                                                                                                                                            |
| `let/var x = e` (local)                                       | e; `Declare 1`                                                                                                                                                                                                                                                                                                                         |
| `let/var PAT = e` (local, destructuring)                      | e; `Destructure k`; `Declare m` (omitted when `m == 0`)                                                                                                                                                                                                                                                                                |
| `let _ = e`                                                   | e; `Pop`                                                                                                                                                                                                                                                                                                                               |
| `let/var x = e` (global)                                      | e; `DefineGlobal name`                                                                                                                                                                                                                                                                                                                 |
| `let/var PAT = e` (global)                                    | e; `Destructure k`; `DefineGlobal` for each binding in **reverse** order                                                                                                                                                                                                                                                               |
| `fn f(...) {...}` (local)                                     | declare `f` first (so the body can capture it); `Closure k …`; `Declare 1`                                                                                                                                                                                                                                                             |
| `fn f(...) {...}` (global)                                    | `Closure k …`; `DefineGlobal f`                                                                                                                                                                                                                                                                                                        |
| `fn f(...) {...}` (library mode, top level)                   | `Closure k …`; `DefineBuiltin b`                                                                                                                                                                                                                                                                                                       |
| `x = e`                                                       | e; `SetLocal`/`SetUpvalue`/`SetGlobal`                                                                                                                                                                                                                                                                                                 |
| `x op= e`                                                     | `Get…`; e; op; `Set…`                                                                                                                                                                                                                                                                                                                  |
| `o.f = e`                                                     | o; e; `SetField f`                                                                                                                                                                                                                                                                                                                     |
| `o.f op= e`                                                   | o; `Dup`; `GetField f`; e; op; `SetField f`                                                                                                                                                                                                                                                                                            |
| `o[i] = e`                                                    | o; i; e; `SetIndex`                                                                                                                                                                                                                                                                                                                    |
| `o[i] op= e`                                                  | o; i; `Dup2`; `GetIndex`; e; op; `SetIndex`                                                                                                                                                                                                                                                                                            |
| `return e` / `return`                                         | e (or `Nil`); `Return`                                                                                                                                                                                                                                                                                                                 |
| `break`                                                       | `PopN (depth − loop.bodyDepth)`; `Jump loop.exit`                                                                                                                                                                                                                                                                                      |
| `continue`                                                    | `PopN (depth − loop.bodyDepth)`; `Jump loop.continue`                                                                                                                                                                                                                                                                                  |
| `while c B`                                                   | `L_c:` c; `JumpIfFalse L_x`; B (statement mode); `Jump L_c`; `L_x:` — the loop context (bodyDepth `d`, continue → `L_c`) covers the condition and the body                                                                                                                                                                             |
| `for p in e B`                                                | e (**outside** the loop context); `IterInit` (hidden local `$iter`); push the loop context (bodyDepth `d + 1`, continue → `L_n`); `L_n: IterNext L_x` [stmtStart]; bind p (`Declare 1` / `Destructure k; Declare m` / `Pop` for `_`); B (statement mode, nested scope); `PopN m` (iteration scope); `Jump L_n`; `L_x: Pop`             |
| block `{…}` (value mode)                                      | statements, the last expression statement's value kept (else `Nil`); `EndScope n`                                                                                                                                                                                                                                                      |
| `if c A else B`                                               | c; `JumpIfFalse L_e`; A; `Jump L_end`; `L_e:` B or `Nil`; `L_end:`                                                                                                                                                                                                                                                                     |
| `a and b` / `a or b`                                          | a; `AndJump L` / `OrJump L`; b; `L:`                                                                                                                                                                                                                                                                                                   |
| `match s { arms }`                                            | s (hidden local `$subject`); for each arm: `L_i: MatchPattern k L_{i+1}` [stmtStart]; `Declare m`; guard? (`guard; JumpIfFalse L_gf`); body [first instr stmtStart]; `EndScope m`; `Jump L_end`; `L_gf: PopN m` (if guarded; falls through to `L_{i+1}`) … `L_n: NoMatch`; `L_end:` (depth `d + 2`, also with zero arms); `EndScope 1` |
| literal                                                       | `Const` / `Nil` / `True` / `False`                                                                                                                                                                                                                                                                                                     |
| template                                                      | for each part in order: non-empty literal → `Const`, expression → its code; `Interp n` (n = values pushed)                                                                                                                                                                                                                             |
| list                                                          | leading plain items; `List n`; then each remaining item: plain → item; `ListAppend` / spread → e; `ListExtend`                                                                                                                                                                                                                         |
| record                                                        | leading plain fields as `Const key`, value; `Record n`; then each remaining: field → `Const key`, value; `RecordSet` / spread → e; `RecordMerge`                                                                                                                                                                                       |
| unary / binary                                                | operands; op (`Range 0` for `..`, `Range 1` for `..=`)                                                                                                                                                                                                                                                                                 |
| `a(b, c)` (incl. pipes)                                       | callee; args…; `Call argc`                                                                                                                                                                                                                                                                                                             |
| `o.f` / `o[i]`                                                | o; `GetField f` / o; i; `GetIndex`                                                                                                                                                                                                                                                                                                     |
| identifier                                                    | `GetLocal` / `GetUpvalue` / `GetGlobal` / `GetBuiltin`                                                                                                                                                                                                                                                                                 |
| function / lambda                                             | a separate `FunctionProto`; in the enclosing function `Closure k (isLocal, index)…`                                                                                                                                                                                                                                                    |
| function body                                                 | parameter prologue: for each parameter `i` that is neither an identifier nor `_`: `GetLocal 1+i`; `Destructure k`; `Declare m` (first prologue instruction is stmtStart); then the body block in value mode (or the expression body, its first instruction stmtStart); `Return`                                                        |

Identifier parameters occupy their slots directly. Every other parameter's slot is a hidden local
`$argI`; `_` parameters get no prologue.

#### 4.3.4 Patterns → `PatternDesc`

Patterns compile to a `PatternDesc` stored in the constant pool (`PatternConst`, see `bytecode.ts`)
with the pattern's exact source text (for R014/R015) and `bindCount`. The VM interprets descriptors
(§6.5). Binding order is SPEC §6.2.

#### 4.3.5 Debug info (per `FunctionProto.debug`)

- `spanStart/spanEnd[i]` for every code index `i` (operand indices repeat their instruction's
  values). Spans implement SPEC §10.4 exactly:
  - binary and unary operators: the whole expression; literals and identifiers: the node;
  - `Call`: the call expression, or for `pipe` calls the `pipeSpan`;
  - `GetField`/`SetField`: `Member.accessSpan`; `GetIndex`/`SetIndex` (including compound
    assignments): the index expression;
  - `Get…`/`Set…` of variables in assignments: the target identifier;
  - `Destructure`: the pattern (for parameters, the parameter's pattern);
  - `Declare`/`DefineGlobal`: the declaring statement;
  - `IterInit`, `IterNext`, the loop's back `Jump` and the exit `Pop`: the `for` header;
  - `ListExtend`/`RecordMerge`: the spread element; `ListAppend`/`RecordSet`: the item;
  - `MatchPattern` and an arm's `Declare`: the arm's pattern; `NoMatch`: the subject;
  - block-ending `EndScope`/`PopN`: the block's closing `}` (1-character span);
  - implicit `Return`: the body's closing `}` or the expression body; the program's final
    `Nil`/`Return`: the empty span at the end of the source.
- `stmtStart[i] = 1` for the first instruction of every statement, every `MatchPattern`, the first
  instruction of every arm body, `IterNext`, the first instruction of a lambda's expression body and
  the first instruction of a parameter prologue. Otherwise 0 (and 0 on operand indices).
- `stmtSpanStart/stmtSpanEnd[i]`: the innermost enclosing statement; for `MatchPattern` and arm
  bodies, the arm; for the expression body of a lambda, the body expression.
- `locals` (§4.3.2), `upvalueNames[i]` (the captured variable's name).
- Display names: SPEC §7.12. `FunctionProto.name` is `null` for unnamed functions; the script is
  `kind: 'script'` named `'<top level>'`.

### 4.4 Disassembler and verifier

- `disasm.ts`: `disassemble(target: Program | FunctionProto): string`, one line per instruction:
  `ip  OPNAME operands  ; comment` (constant values, names, jump targets, line numbers), nested protos
  included.
- `verify.ts`: `verifyProto(proto): string[]` and `verifyProgram(program): string[]`: an abstract
  interpreter that reports invalid opcodes or operands, out-of-range constant/local/upvalue/jump
  indices, inconsistent or negative stack depths at joins, debug arrays of the wrong length,
  `stmtStart` on operand indices, and locals outside the frame or with inverted ranges.

## 5. Bytecode (`src/core/bytecode.ts`)

### 5.1 Encoding

`FunctionProto.code` is a flat `number[]`: each instruction is its opcode followed by its operands,
each operand one array element (no byte packing). Jump targets are **absolute** code indices.

### 5.2 Instruction set

Stack effects are written `( before -- after )`, top of stack on the right.

| op                                  | operands                                               | effect                                               | semantics                                                                            |
| ----------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Const`                             | k                                                      | `( -- v )`                                           | push `constants[k]` (number or string)                                               |
| `Nil` `True` `False`                | —                                                      | `( -- v )`                                           |                                                                                      |
| `Pop`                               | —                                                      | `( v -- )`                                           |                                                                                      |
| `PopN`                              | n                                                      | `( v1…vn -- )`                                       | close open cells pointing at those slots, then pop n                                 |
| `EndScope`                          | n                                                      | `( x1…xn v -- v )`                                   | close cells for x1…xn, remove them, keep v                                           |
| `Dup`                               | —                                                      | `( a -- a a )`                                       |                                                                                      |
| `Dup2`                              | —                                                      | `( a b -- a b a b )`                                 |                                                                                      |
| `GetLocal` / `SetLocal`             | slot                                                   | `( -- v )` / `( v -- )`                              | `stack[base + slot]`                                                                 |
| `GetUpvalue` / `SetUpvalue`         | i                                                      | `( -- v )` / `( v -- )`                              | the closure's cell i (open: the stack slot; closed: the cell)                        |
| `GetGlobal` / `SetGlobal`           | k (name)                                               | `( -- v )` / `( v -- )`                              | R006 if not yet defined                                                              |
| `DefineGlobal`                      | k (name)                                               | `( v -- )`                                           | define (records a `declare` event)                                                   |
| `GetBuiltin`                        | b                                                      | `( -- v )`                                           | `builtins[b]`                                                                        |
| `DefineBuiltin`                     | b                                                      | `( v -- )`                                           | library initialization only                                                          |
| `Declare`                           | n                                                      | `( -- )`                                             | no-op; the top n slots become declared locals (records `declare` events)             |
| `GetField` / `SetField`             | k (name)                                               | `( o -- v )` / `( o v -- )`                          | SPEC §7.9                                                                            |
| `GetIndex` / `SetIndex`             | —                                                      | `( o i -- v )` / `( o i v -- )`                      | SPEC §7.7                                                                            |
| `Add` `Sub` `Mul` `Div` `Mod` `Pow` | —                                                      | `( a b -- r )`                                       | SPEC §7.2                                                                            |
| `Neg` `Not`                         | —                                                      | `( a -- r )`                                         |                                                                                      |
| `Eq` `Ne` `Lt` `Le` `Gt` `Ge`       | —                                                      | `( a b -- bool )`                                    | SPEC §7.3                                                                            |
| `Range`                             | inclusive (0/1)                                        | `( a b -- range )`                                   |                                                                                      |
| `Jump`                              | target                                                 | `( -- )`                                             | terminator                                                                           |
| `JumpIfFalse`                       | target                                                 | `( c -- )`                                           | pops; jumps when falsy                                                               |
| `AndJump`                           | target                                                 | `( a -- a )` or `( a -- )`                           | falsy: jump keeping `a`; else pop `a`                                                |
| `OrJump`                            | target                                                 | same                                                 | truthy: jump keeping `a`; else pop `a`                                               |
| `Call`                              | argc                                                   | `( f a1…an -- r )`                                   | §6.3                                                                                 |
| `Return`                            | —                                                      | `( v -- )`                                           | terminator; §6.3                                                                     |
| `Closure`                           | k, then `isLocal, index` × `constants[k].upvalueCount` | `( -- closure )`                                     | push the closure **first**, then capture (a local function can capture its own slot) |
| `List`                              | n                                                      | `( v1…vn -- list )`                                  |                                                                                      |
| `ListAppend`                        | —                                                      | `( list v -- list )`                                 |                                                                                      |
| `ListExtend`                        | —                                                      | `( list it -- list )`                                | append every element of iterable `it` (R013)                                         |
| `Record`                            | n                                                      | `( k1 v1 … kn vn -- rec )`                           | keys are string constants                                                            |
| `RecordSet`                         | —                                                      | `( rec k v -- rec )`                                 |                                                                                      |
| `RecordMerge`                       | —                                                      | `( rec other -- rec )`                               | R024 when `other` is not a record                                                    |
| `Interp`                            | n                                                      | `( v1…vn -- string )`                                | concatenation of `show(vi)`                                                          |
| `IterInit`                          | —                                                      | `( it -- iter )`                                     | R013 when not iterable                                                               |
| `IterNext`                          | target                                                 | `( iter -- iter v )` or jump with `( iter -- iter )` | jump when exhausted                                                                  |
| `Destructure`                       | k (pattern)                                            | `( v -- b1…bm )`                                     | R014 on mismatch                                                                     |
| `MatchPattern`                      | k (pattern), target                                    | `( v -- v b1…bm )` or jump with `( v -- v )`         | bindings pushed only on success                                                      |
| `NoMatch`                           | —                                                      | —                                                    | terminator: raises R015 with the subject on top                                      |

## 6. Runtime

### 6.1 Values (`runtime-types.ts`, `values.ts`)

- Shapes are defined in `runtime-types.ts`: `nil` → `null`, bools, numbers and strings are JS
  primitives; heap objects (`ListObj`, `RecordObj`, `ClosureObj`, `NativeObj`, `RangeObj`,
  `IteratorObj`, `CellObj`) carry a `type` tag and a numeric `id`.
- **Object ids** come from a counter in the VM state. The script closure is created by `createVM`
  with id 1 and no `alloc` event; the counter then continues at 2 for every allocation (lists,
  records, closures, ranges, iterators, cells). Builtins have negative ids `-(builtinIndex + 1)`.
- **Builtins display as builtins**: a native, or a closure with a negative id (a library function),
  shows as `<builtin NAME>`; tools see it as RefType `builtin` and never expand it. Closures created
  while library code runs have positive ids and follow SPEC §7.12.
- `values.ts` provides `typeName`, `articleType`, `isTruthy`, `equals` (SPEC §7.4), `show`/`repr`
  (SPEC §4.3), a bounded `preview(value, maxLength)` that stops building as soon as it has enough
  characters, range helpers (element count, k-th element, contains — SPEC §7.6), and iteration
  helpers. All are iterative (§2).

### 6.2 VM state

`stack`, `frames` (`{closure, ip, base, uid}`), `openCells` (sorted by stack index), `globals`
(insertion order = definition order), `time` (steps executed), `nextObjectId`, `nextFrameUid` (the
script frame is uid 1), the generator state (SPEC §10.3), `status`, `error`.

`createVM(program, { builtins, libraryProtos, seed })` (exported from `vm.ts`) returns a `VM`
(`runtime-types.ts`). The VM receives the builtins and library protos from `library.ts` via
`index.ts`; it never builds them itself. `protoById(id)` looks up library protos below
`program.firstProtoId` and program protos from it.

- `step()` executes exactly step `time`; on success `time` increases by 1. On a runtime error,
  `status` becomes `'error'`, `error` is set and `time` does not change.
- `runUntil(t)` steps while `status === 'running'` and `time < t` (step `t` itself does not run).
- **Hooks are pure observers**: the state after `k` steps is identical with hooks on or off
  (natives allocate through the same context helpers either way).

### 6.3 Calls and returns

- `Call argc`: callee at `stack[top − argc]`.
  - native: check arity (R005), run the native atomically within the same step, replace callee and
    arguments with the result.
  - closure: check arity (R005), then call depth (R016: fail when `frames.length − 1 >= 10000`,
    i.e. the top-level frame does not count) **before** mutating anything; push a frame
    `{base = top − argc, ip = 0, uid = nextFrameUid++}`; record a `declare` event for each parameter
    slot `1..arity` of the new frame.
  - anything else: R004.
- `Return`: pop the result, close cells for slots `>= base`, drop the frame's region, push the
  result. When the script frame returns, the run is `finished` with an empty stack and no frames.

### 6.4 Natives (`natives.ts`)

`createNatives(): Value[]` in `NATIVE_NAMES` order (functions as `NativeObj`; `PI`, `INF` as
numbers), implementing SPEC §9.1–9.2 exactly. A native receives `(ctx: NativeContext, args)`; the
context (`runtime-types.ts`) offers output, allocation helpers that assign ids and record `alloc`
events, mutation helpers that perform list/record changes and record their events (§6.7), the
generator, the current time, and `fail(code, message, hint?)`. Natives never call back into user
code and check SPEC §10.5 size limits before building results.

### 6.5 Pattern matching

The VM matches a `PatternDesc` against a value per SPEC §6. A rest binding allocates a new list.
On success it pushes the bindings in order; `Destructure` raises R014 on failure, `MatchPattern`
jumps.

### 6.6 Errors

The VM builds a `RuntimeErrorInfo` at the moment of failure: code, message, hint, the span per SPEC
§10.4, and the stack innermost-first. If the failing instruction belongs to library code, the span is
that of the `Call` instruction in the nearest user frame. After an error the VM state may be
inconsistent; consumers never read it (the recorder rebuilds time `N` by replay).

### 6.7 Hooks (recording events)

`vm.hooks` is `null` during replay and a `VMHooks` object while recording. Event times are always
the index of the executing step.

- `output(time, text)` for `print`.
- `write(time, kind, target, value)` with `kind` ∈ `'declare' | 'write'`:
  - `declare`: `Declare` (locals of the current frame), call parameters (the new frame's slots),
    `DefineGlobal` (`{kind: 'global'}`);
  - `write`: `SetLocal`, `SetGlobal`, `SetUpvalue` (an **open** cell is reported as the owning
    frame's `local` slot, a closed cell as `{kind: 'cell'}`), `SetField` and `RecordSet` (field),
    `RecordMerge` (one field write per copied key, in order), `SetIndex` on a list (element target
    with the **normalized** non-negative index) or a record (field).
- `listOp(time, listId, op, index, count, value)` for every change of a list's shape: `push` and
  `ListAppend` → `append` (index = old length, value = the item); `ListExtend` → `extend` (index =
  first new index, count, value = the iterable); `insert` → `insert` (normalized index, the item);
  `remove` → `remove` (normalized index, the removed item); `pop` → `pop` (index = new length, the
  removed item). Index/element writes of the same list are separate `write` events.
- `fieldDelete(time, recordId, key)` when `delete` removes an existing key.
- `alloc(time, object)` for every allocation (except the script closure).
- `cellClosed(time, cellId, ownerFrameUid, slot)` when an open cell is closed.

### 6.8 Snapshots

`snapshot()` copies the **whole** VM record: stack, frames, open cells, globals, `time`,
`nextObjectId`, `nextFrameUid`, generator state, status, plus all mutable heap objects reachable from
them (lists, records, closures with their cells, cells, iterators with their position and key
snapshot), preserving object identity and ids. Strings, numbers, ranges, natives, library closures
and `FunctionProto`s are shared, never copied. `restore(s)` copies again, so a snapshot can be
restored any number of times. `VMSnapshot.size` is the number of values copied (used by the recorder's
cadence). Both are iterative. Tool-side bookkeeping is keyed only on numeric ids and uids, never on
JS object identity, because `restore` creates fresh objects.

### 6.9 Library (`prelude.ts`, `library.ts`)

`prelude.ts` exports `PRELUDE_SOURCE`: exactly SPEC Appendix A (a test compares them). `getLibrary()`
(lazy singleton, `Library` in `runtime-types.ts`) compiles it with `mode: 'library'`,
`firstProtoId: 0` (library protos have `debug.library = true`, `source: 'prelude'`), runs it once in
a VM whose builtins array holds the natives (library slots `nil`), collects the closures stored by
`DefineBuiltin`, renumbers their ids to `-(index + 1)`, and returns `{ source, builtins, protos }`.
In library mode, references to library names resolve to `GetBuiltin`, and anything other than
top-level `fn` declarations is an internal error. A prelude compile or run failure throws
`InternalError` with the details.

### 6.10 Implementation notes

Decisions made while building the runtime, recorded here so tools can rely on them:

- `DefineBuiltin` writes into the very array passed as `VMOptions.builtins`; `library.ts` reads the
  library closures back from that array.
- `run()` attaches hooks whose callbacks other than `output` do nothing; it drops output events
  with `time >= N` so its output matches a recording's.
- `ListExtend` and spreads that add no elements record no `listOp` event.
- `restore()` accepts only snapshots taken from the same `Program` object (a fresh VM resuming a
  recording must be created from that object).
- `GlobalInfo.declSpan` is the span of the global's binding name, not of the whole statement.
- `Recording.continue` already requires user code, so `NavOptions.justMyCode` does not change it.
- `allocationTime` is null for the script closure (id 1) and for objects allocated in a failing
  step. `recordAsync` reports `onProgress` one last time with the final `N`.
- Measured on the reference machine: 5,000,000 VM instructions in about 430 ms; a 1.26 M-step
  recording in about 230 ms with 0.35 ms average seeks. Heap-heavy programs (60,000 records) seek in
  about 27 ms, because snapshots are spaced in proportion to their size.

## 7. Time travel

### 7.1 Recorder (`recorder*.ts`) — implements `Recording` (`api-types.ts`)

`record(program, runtime, options)` and `recordAsync(program, runtime, options)`, where
`runtime = { createVM, builtins, libraryProtos }` (index.ts supplies it):

1. Create a VM with recording hooks. For each step `t`: append the location of the instruction
   about to execute (proto id, ip, depth = frames − 1) to the trace, take a snapshot when the cadence
   says so, then `vm.step()`.
2. **Stopping.** The run ends when the VM finishes or errors, when `t == maxSteps` (outcome
   `step-limit`), or when the signal aborts (outcome `aborted`). Finished and error take precedence
   over the limit. On error at step `k`, `N = k`; events, allocations and output emitted during the
   failing step are discarded, so every event has `time < N`.
3. **Location at N** is stored for `error`, `step-limit` and `aborted` (the failing or paused
   instruction); for `finished` it is null.
4. **Snapshot cadence** (cost-aware): snapshot at time 0; after a snapshot at time `s` that copied
   `c` values, the next is taken at the first multiple of `interval` at or after
   `s + max(interval, 4c)`. Start with `interval = 256`. When the number of snapshots exceeds
   `snapshotBudget` (default 512) or the retained copied values exceed 8,000,000, drop every other
   snapshot (keeping time 0) and double `interval`. For `step-limit` and `aborted`, also snapshot at
   `N` (for `extend`).
5. **Seek** `stateAt(t)`: restore the latest snapshot `<= t` and replay with `vm.runUntil(t)`
   (hooks off). Keep the VM positioned at the last seek so a forward seek within reach runs on
   without restoring. The state at `N` for an error is rebuilt this way (never read from the failed
   VM). Cache recently built `StateView`s (small LRU).
6. **Storage** is columnar (typed arrays that grow by doubling) for the per-step trace and for
   events; object-per-step storage is not acceptable. Budget: recording 1,000,000 steps of a typical
   program takes under 2 s and stays under ~150 MB; a seek averages under 5 ms.
7. **Async**: `recordAsync` works in slices of `sliceMs` (default 8 ms), yielding through a
   `MessageChannel` macrotask when available (else `setTimeout(0)`), reporting `onProgress(time)`,
   and ending with outcome `aborted` when `signal.aborted` becomes true.
8. **Extend**: `extend(extraSteps)` / `extendAsync(extraSteps, options)` apply only to `step-limit`
   and `aborted` recordings (otherwise `InternalError`). They resume from the snapshot at `N` in a
   fresh hooked VM and return a new `Recording` of length `<= N + extraSteps` whose outcome's
   `maxSteps` is the previous limit plus `extraSteps`. The receiver stays unchanged and valid
   (shared buffers are only appended beyond `N`; the snapshot list is copied before thinning).
   Repeated calls return independent, identical continuations.
9. **Arguments**: every method that takes a time requires an integer in `[0, N]` and throws
   `InternalError` otherwise (the studio clamps first).

### 7.2 Navigator (`navigator*.ts`)

Let `S(t)` = the instruction at `t` is a stmtStart, `U(t)` = it is user code (`source: 'main'`),
`D(t)` = depth, `L(t)` = the line of the instruction's **statement span** start (`Location.stmtLine`).
Candidate times range over `0..N−1`; `N` (forward) and `0` (backward) are only fallback results.
`D(N)` is the depth of `locationAt(N)` when it exists, else 0. With **just-my-code** (JMC) on, add
`U(t')` to every predicate.

| operation | forward result (else `N`)                                                 | backward result (else `0`)                                                |
| --------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| step into | min `t' > t`: `S(t')`                                                     | max `t' < t`: `S(t')`                                                     |
| step over | min `t' > t`: `S(t') ∧ D(t') <= D(t) ∧ min{D(u) : t <= u <= t'} >= D(t')` | max `t' < t`: `S(t') ∧ D(t') <= D(t) ∧ min{D(u) : t' <= u <= t} >= D(t')` |
| step out  | min `t' > t`: `D(t') < D(t)`                                              | max `t' < t`: `D(t') < D(t)`                                              |
| continue  | min `t' > t`: `S(t') ∧ U(t') ∧ L(t') ∈ B`                                 | max `t' < t`: same                                                        |

- Step over is defined by **activation**: the running minimum makes a sibling call at the same depth
  (`sq(2) + sq(3)`) not count as the same frame.
- With JMC, if a step-over scan passes through a library step at depth `< D(t)` (the frame returned
  into library code, or — backward — was called by it) before finding a result, the result is the
  JMC step-into target from that point, so stepping over the end of a `map` callback lands on its
  next invocation.
- `lineHits(line)` lists every `t < N` with `S(t) ∧ U(t) ∧ L(t) = line`; `lineHitCounts()`
  aggregates them. Linear scans over typed arrays are fast enough; precompute where cheap.

### 7.3 Provenance (`provenance*.ts`)

Events (`declare`, `write`, `alloc`, list ops, field deletes, cell closes) are indexed per target.
`origin(target, before)` returns the latest relevant event with `time < before`:

- `local` / `global`: the latest `declare`/`write` on exactly that target.
- `field {objectId, key}`: the latest write or delete of that key, else the object's `alloc`.
- `element {objectId, index: i}`: walk the list's events backwards from `before`, translating the
  index: an element write at `i`, an `append`/`insert` at `i`, or an `extend` covering `i` → that
  event; an `insert` at `j < i` → `i := i − 1`; a `remove` at `j <= i` → `i := i + 1`; a `pop` →
  skip; the `alloc` → the `alloc`.
- `object {objectId}`: the latest event of any kind on that object, including its `alloc`.
- `cell {cellId}`: events on the cell, and — before its `cellClosed` time — events on the owning
  frame's local slot.

`history(target, at, window?)` returns the events of the **binding** live at `at`:

- `local`: the latest `declare` of `(frameUid, slot)` before `at` identifies the binding's
  declaration site (proto id, ip). The result is every event on that slot in each occupancy whose
  declare ran at the same site (so a loop variable's history spans iterations), plus, for a binding
  that was captured and later closed, its cell's events. Other declarations that reused the slot are
  excluded. A `cell` target resolves to the same set through its owner slot.
- other targets: their `origin` event sets (with the element-index translation).
- `window = {from, to, limit}` (defaults: whole run, 1000): events with `from <= time < to`; when more
  than `limit`, evenly spaced samples including the first and last, with `truncated = true` and the
  `total`.

### 7.4 Inspector (`inspector*.ts`)

Builds a `StateView` from the VM positioned at time `t`:

- `frames`: outermost first. Per frame: uid, display name, proto id, ip, library flag, source;
  `span` and `stmtSpan` of the instruction at `ip` (for callers, of the `Call` they wait on: the
  instruction just before `ip`); live non-hidden locals (§4.3.2, inside the frame's current stack
  region) in slot order with their `WriteTarget`s; the closure's captures (name, value, target per
  §6.7); and `temps`, the stack values above the highest live local.
- `globals`: defined user globals in definition order with kind and mutability from `Program.globals`.
- **Heap**: breadth-first from the roots in this order: globals in definition order, then frames
  outermost-first, each frame's whole stack region in slot order (locals, hidden locals, temps), then
  its closure's captures. Children are visited in `ObjectView` order (items, entry values, captures,
  iterator source). Each id is visited once; `heap` holds the first `heapLimit` (default 250)
  objects visited, and `heapTruncated` says whether more were reachable. Builtins are never
  expanded.
- `ObjectView` lists and records carry at most 100 items or entries plus the total `length`; the
  rest is fetched with `objectAt(t, id, {offset, limit})`, which returns `null` when the object is
  not reachable at `t`.
- `ValueView.preview` comes from the bounded `preview` (~48 characters).
- At `t == N`: frames are empty when finished; for errors, step limits and aborts, frames show the
  paused state, and `error` is set for errors.

## 8. Public API (`src/core/index.ts`)

```ts
lex(source): LexResult                                   // for editors
parse(source): ParseResult
compile(source): CompileResult                           // stages per SPEC §11.2
run(program, { maxSteps?, seed?, onOutput? }): RunResult // fast; hooks only for output
record(program, RecordOptions): Recording
recordAsync(program, AsyncRecordOptions): Promise<Recording>
disassemble(program): string
verifyProgram(program): string[]
getLibrarySource(): string
show, repr, LineIndex, and all types from api-types.ts / diagnostics.ts / span.ts / tokens.ts
```

`compile` runs the stages of SPEC §11.2 and returns only the first failing stage's diagnostics
(sorted, de-duplicated). It never throws for user input. `run` and `record` agree on outcomes.

## 9. Command-line tool (`src/cli`)

`hindsight <command>`; during development `npm run sight -- <command>`.

| command                               | behavior                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `run FILE [--max-steps N] [--seed S]` | print output; on error print a diagnostic and exit 1                                                     |
| `check FILE`                          | compile only; print diagnostics; exit 1 on errors                                                        |
| `disasm FILE`                         | print the disassembly                                                                                    |
| `replay FILE --at T [--max-steps N]`  | record, then print the state at time `T`: location, frames with locals, globals, output so far           |
| `why FILE --line L --name X`          | record, then list every event in the history of variable `X` declared on line `L`, with times and values |
| `test [DIR]`                          | run `.sight` files with annotations (§10.2) using `src/conformance`; summary; exit 1 on failure          |
| `repl`                                | interactive prompt (below)                                                                               |

Diagnostics print Rust-style with a code frame and caret underline (`error[E020]: …`, `--> file:3:9`,
the source line, `^^^`, `= hint: …`), colored only when stdout is a TTY.

**REPL**: each accepted entry is appended to the source of all previously accepted entries; the
whole text is compiled and run from scratch with the same seed, and only output events beyond the
previous run's are printed. An entry that fails to compile or raises a runtime error is reported and
discarded (so E022 applies across entries).

## 10. Testing

### 10.1 Unit tests

Every module has co-located tests. Coverage target: 80 %+ lines for `src/core`, `src/conformance`,
`src/cli`, and the non-visual parts of `src/studio`.

### 10.2 Conformance corpus

`tests/lang/**/*.sight`, run by `tests/corpus.test.ts` and by `hindsight test`, both through
`src/conformance` (annotation parser + checker), both with `maxSteps` 5,000,000 and seed 42.

**Scanning.** Each raw physical line (split as `LineIndex` does) is scanned without regard to
lexical context. Each occurrence of `// expect` starts an annotation that runs to the next
`// expect` on the line or the end of the line. Corpus programs must not contain `// expect` for any
other purpose (including inside strings).

**Forms.**

```
// expect:[ TEXT]
// expect compile error[ CODE][: TEXT][ // hint: HINT]
// expect runtime error[ CODE][: TEXT][ // hint: HINT]
```

`CODE` is `E\d{3}` for compile errors and `R\d{3}` for runtime errors. Anything else that starts with
`// expect` is a malformed annotation and fails the file. `TEXT` and `HINT` have trailing whitespace
removed; a bare `// expect:` expects an empty line.

**Output.** The actual lines are the output events' texts joined with `\n`, split on `\n`, each with
trailing whitespace removed. The expected lines are all `expect:` annotations in file order, wherever
they appear. The two sequences must be equal.

**Compile errors.** A file with any compile-error annotation contains no other annotation kind, and
compilation must fail. Every diagnostic must be matched by at least one annotation on its line (same
code if given; message contains `TEXT`; hint contains `HINT` if given), and every annotation must
match at least one diagnostic.

**Runtime errors.** At most one runtime-error annotation per file. The program must compile, print
exactly the expected lines, then fail with a runtime error on the annotation's line whose code,
message and hint match.

**Otherwise** the program must compile, finish within the step limit, and print exactly the expected
lines. The runner also records every passing program and checks that the recording's outputs equal
the fast run's.

**Lines.** A diagnostic's or runtime error's line is the line of its span start (SPEC §10.4, §11.1).

### 10.3 Time-travel properties (`tests/timetravel.test.ts`, fast-check)

For corpus and generated programs: `stateAt(t)` equals the state reached by a fresh VM run to `t`;
seeking in random orders gives identical views; forward navigation results are `> t` (or `N`) and
backward `< t` (or 0); step over skips sibling calls; `origin` never returns an event at or after
`before`; `restore(snapshot())` then `k` steps equals `k` steps on the original.

### 10.4 End-to-end (`e2e/`)

Playwright against the dev server with the local Chrome (`channel: 'chrome'`): load, run an example,
step forwards and backwards, scrub the timeline, click output to jump, jump to a variable's origin,
toggle breakpoints, compile errors, sharing links.

## 11. Studio (`src/studio`)

A single-page React 19 app (CodeMirror 6 editor, zustand store). It imports only
`src/core/index.ts` and runs entirely in the browser: no server, no network calls besides fonts.

### 11.1 Concept

**A strip-chart recorder for programs.** The bottom of the screen is a strip of graph paper on which
the run's call depth is traced, the way a chart recorder traces a signal. A red **pen** marks the
current time. Dragging the pen travels through the run; everything else (the editor highlight, the
call stack, variables, heap and console) shows the program at the pen's time.

### 11.2 Layout

Desktop (≥ 1100 px), one screen, nothing scrolls except inside panels:

```
┌ header: HINDSIGHT wordmark · example picker · Run ▸ (Ctrl/⌘+Enter) · status · settings · help ┐
├ editor (≈ 56 %)                             │ instrument column: CALL STACK / VARIABLES /     │
│ gutters: breakpoints, heat                  │ HEAP / CONSOLE (stacked, each collapsible)      │
├ transport: ⏮ ⟸ ↶ ← ▶/❚❚ → ↷ ⤴ ⟹ ⏭ · tape counter STEP 0 001 234 / 0 056 789 · line, function ┤
└ strip chart: depth trace, event ticks (output), breakpoint hits, watched writes, error flag, pen ┘
```

Tablet (700–1099 px): editor on top, instrument column below as tabs, transport and strip chart
pinned to the bottom. Phone (< 700 px): one column (editor ≈ 40 % height, transport, strip chart,
tabbed panels); the page may scroll vertically, never horizontally.

### 11.3 Behaviors

- **Opens working**: the first load shows a gallery example already recorded, with the pen placed at
  an interesting moment, plus a one-line dismissible hint ("Drag the red pen to travel through
  time · ⟲ shows where a value came from").
- **Run**: compiles and records with `recordAsync` (abortable; a new run aborts the old). While
  recording, the strip chart fills in left to right and the status shows the step count. Auto-run
  (default on) re-records 600 ms after the last edit when the program compiles; compile errors show
  as squiggles and in the console, and the previous recording stays visible but marked stale.
- **Navigation**: transport buttons and shortcuts: F11 / Shift+F11 step into forward / back;
  F10 / Shift+F10 step over; F7 / Shift+F7 step out; F8 / Shift+F8 continue to breakpoint;
  Home / End; Space toggles playback (statement by statement at an adjustable speed); F9 toggles a
  breakpoint on the cursor line; Ctrl/⌘+Enter runs. With the strip chart focused, ←/→ step into and
  Shift+←/→ step over. Just-my-code (default on) skips library frames.
- **Editor**: Hindsight highlighting from the real lexer (including comments); diagnostics as lint
  squiggles; the current statement's lines tinted and the current instruction's span outlined; the
  selected caller frame's call span marked differently; clickable breakpoint gutter; a heat gutter
  showing per-line hit counts (log scale) with a tooltip ("ran 1,204 times · click to jump to the
  next run"); inline value hints for the selected frame's live locals at the end of their
  declaration lines; hovering an identifier shows its value at the current time.
- **Call stack**: innermost frame first; library frames dimmed (collapsed with just-my-code);
  clicking a frame selects it (variables and editor follow).
- **Variables**: locals of the selected frame, its captured variables, and globals. Values render as
  expandable trees (lists, records, functions; long lists page through `objectAt`). Values that
  changed since the previous step flash. Every row has **⟲ origin** (move the pen to
  `origin(target, t).time`; the status explains "x was set here") and **history** (marks every event
  of the binding on the strip chart and opens a list with values, plus a sparkline for numbers).
- **Heap**: a graph of objects reachable from the selected frame and globals: variable chips on the
  left, objects as boxes (lists as indexed cells, records as key/value rows, functions with their
  captures), arrows for references. Layout is deterministic and keyed by object id, so boxes keep
  their place as time moves; at most 60 boxes (with a "+N more" note).
- **Console**: one line per output event with its step number. Lines printed after the pen are
  ghosted; the line printed at the pen is marked. Clicking a line moves the pen to the moment it was
  printed. At the end of a failed run the error appears here with its hint and a link to the failing
  moment.
- **Strip chart**: canvas; x = time, y = depth (deeper calls rise like peaks). Graph-paper grid with
  labeled step ticks and a "1 div = N steps" chart-speed readout. Click or drag to move the pen; wheel
  zooms around the cursor; Shift+wheel or dragging the scale pans; double-click resets. Hover shows
  step, line and function. Markers: output events (ticks on the top margin), breakpoint hits, watched
  writes, the error flag at the end. Rendering uses a per-pixel min/max envelope (precomputed
  mipmaps) so 2,000,000 steps draw in a few milliseconds.
- **Status**: recording progress; "Finished · 56,789 steps · 12 lines"; "Runtime error on line 7 · …"
  (click to jump); "Step limit reached · Record 2M more" (calls `extendAsync`).
- **Settings**: step budget (500 k / 2 M / 10 M), just-my-code, auto-run, instruction-level
  stepping (adds a step-instruction button, shows `opName` and operand temps), theme.
- **Sharing**: "Copy link" puts the program in the URL fragment (`#src=` + base64url of the
  deflate-raw-compressed UTF-8 source). Opening such a link loads that program. The current source
  and settings persist in `localStorage` (every access wrapped in try/catch).
- **Help**: a dialog with the shortcuts and a one-page language cheat sheet.

### 11.4 Visual identity

- **Light theme (default `:root`)**: graph-paper ground with a faint green-grey grid, blue-black ink
  for text and the trace, recorder-pen red for the pen and errors, a cobalt event-marker blue for
  breakpoints, output ticks and provenance. **Dark theme**: blue-graphite ground, faint cyan grid,
  pale ink, a brighter pen red and a lighter cobalt.
- **Type**: Barlow Condensed (uppercase, letter-spaced instrument labels and the wordmark), Barlow
  (interface text), JetBrains Mono (code, values, the tape counter with tabular digits). Loaded from
  Google Fonts with system fallbacks.
- Panels read as instrument modules: hairline rules and small uppercase labels, not heavy cards.
  Transport icons are inline SVG. One orchestrated motion moment: the pen writing the chart while a
  run records. `prefers-reduced-motion` disables animation.
- Colors are tokens only (`src/studio/styles/tokens.css`): every token defined on bare `:root`
  (light), redefined under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`
  and `:root[data-theme="dark"]`; `body` sets an explicit background. The theme toggle sets
  `data-theme` on `<html>`.

### 11.5 Code structure

```
src/studio/
  main.tsx  App.tsx
  state/     store.ts (zustand: source, compile result, recording, time, selection, breakpoints,
             settings, watch target; actions) · session.ts (compile/record orchestration, abort,
             debounce) · selectors.ts
  lib/       format.ts · timeline-math.ts (zoom, pan, ticks, envelopes) · heap-layout.ts ·
             share.ts · storage.ts · shortcuts.ts      (pure, unit-tested)
  editor/    Editor.tsx · language.ts · decorations.ts · gutters.ts · lint.ts · theme.ts
  timeline/  StripChart.tsx · Transport.tsx · TapeCounter.tsx
  panels/    CallStack.tsx · Variables.tsx · ValueTree.tsx · HeapGraph.tsx · Console.tsx · History.tsx
  chrome/    Header.tsx · ExamplePicker.tsx · Settings.tsx · HelpDialog.tsx · Status.tsx
  styles/    tokens.css · base.css (+ one CSS file per component folder)
  examples.ts  (loads /examples/*.sight via import.meta.glob with `?raw`; reads `// title:` and
               `// summary:` header comments)
```

### 11.6 Single-file build

`npm run build:page` produces `dist/page/index.html` with all JavaScript and CSS inlined (a small
local Vite plugin, no extra dependency), suitable for publishing as one self-contained page. It must
respect the page rules: a two-to-four-word `<title>` ("Hindsight Studio"), side gutters of
`max(16px, env(safe-area-inset-left/right, 0px))`, `height: 100%` instead of `100vh`, no horizontal
page scroll at 400 px, no `alert`/`confirm`/`prompt`, clipboard writes inside click handlers with a
select-the-text fallback, and storage access wrapped in try/catch.
