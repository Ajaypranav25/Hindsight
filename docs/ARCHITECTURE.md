# Hindsight Architecture

**Normative for internal contracts.** `docs/SPEC.md` defines the language; this document defines how
the implementation is split into modules and the exact contracts between them (AST, bytecode, VM,
recorder, inspector, public API). Contract types live in code and are the source of truth for shapes:

| contract file               | defines                                                      |
| --------------------------- | ------------------------------------------------------------ |
| `src/core/span.ts`          | `Span`, `LineIndex`                                          |
| `src/core/diagnostics.ts`   | `Diagnostic`, error codes, message helpers                   |
| `src/core/tokens.ts`        | `Token`, `TokenKind`                                         |
| `src/core/ast.ts`           | the AST                                                      |
| `src/core/bytecode.ts`      | opcodes, `FunctionProto`, `Program`, pattern descriptors     |
| `src/core/builtin-names.ts` | the builtin table order                                      |
| `src/core/api-types.ts`     | `Recording`, `StateView`, values for tools, navigation types |

---

## 1. Repository layout

```
docs/                 SPEC.md (language), ARCHITECTURE.md (this file)
src/core/             the language; zero runtime dependencies; no DOM, no Node APIs
  span.ts diagnostics.ts tokens.ts lexer.ts ast.ts parser.ts
  bytecode.ts compiler.ts disasm.ts
  builtin-names.ts values.ts natives.ts prelude.ts library.ts vm.ts
  recorder.ts navigator.ts inspector.ts api-types.ts index.ts
  testing/            test-only helpers (e.g. a bytecode assembler)
src/cli/              the `hindsight` command-line tool (Node)
src/studio/           the web studio (React + CodeMirror 6 + zustand)
tests/lang/**.sight   the language conformance corpus (§10.2)
tests/*.test.ts       cross-module tests (corpus runner, time-travel properties)
e2e/                  Playwright tests for the studio
examples/             gallery programs shown in the studio
```

Module dependency direction (no cycles):

```
span ← diagnostics ← tokens ← lexer ← parser(ast) ← compiler(bytecode, builtin-names)
values ← natives ← vm(bytecode)          library(compiler, vm, natives, prelude)
recorder(vm) ← navigator ← inspector     index(all of the above)
```

`compiler.ts` never imports `library.ts`; `vm.ts` never imports `library.ts` or `compiler.ts`.
`index.ts` wires them together.

## 2. Conventions

- TypeScript strict mode, ES2022, ESM, no default exports, `import type` for type-only imports
  (`verbatimModuleSyntax`). Prettier formats everything (`npm run format`).
- `src/core` must type-check without DOM or Node types (`tsconfig.core.json`).
- **Mutation policy.** Application and UI state is immutable (new objects, never in-place edits).
  The VM, recorder and compiler internals are deliberately imperative for speed: they own their
  mutable state and never expose it. Everything a module returns to callers (AST, `Program`,
  `StateView`, events) is treated as immutable by every consumer.
- Errors: internal invariant violations throw `InternalError` (a bug). User-facing problems are
  `Diagnostic`s (compile time) or runtime errors (`RuntimeErrorInfo`). Nothing user-triggered may
  throw a raw JavaScript exception out of `compile`, `run` or `record`.
- No `console.log` in `src/core` or `src/studio`.
- Unit tests sit next to their module (`lexer.test.ts`), use Vitest, Arrange–Act–Assert, and
  descriptive names.

## 3. Pipeline

```
source ──lex──▶ tokens ──parse──▶ AST ──compile──▶ Program (FunctionProtos + debug info)
                                                      │
                     library (prelude, natives) ──────┤
                                                      ▼
                              VM ◀── recorder (trace, snapshots, events) ──▶ Recording
                                                                        ├─ navigator (step/continue)
                                                                        └─ inspector (StateView)
```

## 4. Front end

### 4.1 Lexer — `lex(source): { tokens: Token[]; diagnostics: Diagnostic[] }`

- Implements SPEC §2 exactly. Always ends with one `EOF` token (span `[len, len]`).
- Token kinds: keyword and punctuator kinds are their literal text (`'let'`, `'..='`, `'('`);
  others are `'Number' | 'String' | 'StringHead' | 'StringMiddle' | 'StringTail' | 'Identifier' | 'EOF'`.
- `value`: number for `Number`, cooked text for the string kinds, the name for `Identifier`.
- Error recovery: report, skip the offending character (or close the string at EOF), continue.

### 4.2 Parser — `parse(source): { program: ast.Program; diagnostics: Diagnostic[] }`

- Recursive descent / Pratt implementation of SPEC §3, including newline sensitivity (§3.2): keep a
  stack of "newline-insensitive" contexts. Push `true` when entering `( )`, `[ ]` or record braces,
  push `false` when entering any block. Rule 1 of §3.2 applies when the top is `false`.
- Builds `ast.ts` nodes. Every node's `span` covers its full source text.
- `Call.pipe` is true for calls produced by `|>`. A pipe whose right side is a `Call` gets the left
  operand inserted as the first argument of that (outermost) call; otherwise it becomes
  `Call(rhs, [lhs])`. The resulting call's span covers the whole pipe expression.
- Error recovery: on an error, record the diagnostic, then skip tokens until a likely statement
  boundary (a token with `newlineBefore`, `;`, `}` at the current nesting, or a statement keyword),
  and continue. Report at most one diagnostic per statement. The parser never throws.
- Static checks done in the parser: E012, E013, E014, E015 (syntactic), E016, E017, E018, E019,
  E023 (within a single pattern / parameter list), E027 (`_` as an expression).

### 4.3 Compiler — `compileProgram(ast, options): { program?: Program; diagnostics }`

Options: `{ source: string; mode: 'main' | 'library'; firstProtoId: number }`.

Name resolution and checks (E020–E026) follow SPEC §5. Each function being compiled has a
`FunctionState` with scopes, upvalues, the code under construction, debug tables and the
**tracked stack depth**.

#### 4.3.1 Stack depth and slots

- Every frame's stack region starts with slot 0 = the callee closure, then parameters in slots
  `1..arity`. The compiler tracks `depth` = number of values in the region (initially `1 + arity`).
- Every emitted instruction updates `depth` by its stack effect (§5.2). At control-flow joins, the
  depths of all incoming paths are equal (assert it).
- **A local's slot is the depth position its value occupies**: after the initializer leaves `m`
  binding values on the stack, those locals get slots `depth - m … depth - 1`. Temporaries may sit
  below a block's locals (e.g. `1 + if c { let z = 2; z } else { 0 }`): slots are depth positions,
  not "local counts".
- After `return`, `break` or `continue` the following code in the same block is unreachable; keep
  tracking `depth` as if the statement had not changed it.

#### 4.3.2 Scopes

- A scope records `startDepth` and its locals (name, slot, kind, mutable, hidden, declSpan, the
  `startIp` and later `endIp` for debug info).
- **Value-mode block end** (the block's value is needed): emit `EndScope n` where `n` is the number
  of slots the scope owns (skip when `n == 0`).
- **Statement-mode block end** (loop bodies, statement-level blocks): emit `PopN n` (skip when 0).
- The ip just after the instruction that removes a local is its `endIp`.
- Globals are only created by statements directly at top level in `mode: 'main'`.

#### 4.3.3 Emission recipes

`d` is the tracked depth when the construct starts. "stmtStart" marks the instruction as the start
of a step-over-able unit (§4.3.5).

| construct                                   | code                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| program (`main`)                            | statements…; `Nil`; `Return`                                                                                                                                                                                                                                                                                   |
| expression statement                        | expr; `Pop`                                                                                                                                                                                                                                                                                                    |
| `let/var x = e` (local)                     | e; `Declare 1`                                                                                                                                                                                                                                                                                                 |
| `let/var PAT = e` (local, destructuring)    | e; `Destructure k`; `Declare m` (omit when `m == 0`)                                                                                                                                                                                                                                                           |
| `let _ = e`                                 | e; `Pop`                                                                                                                                                                                                                                                                                                       |
| `let/var x = e` (global)                    | e; `DefineGlobal name`                                                                                                                                                                                                                                                                                         |
| `let/var PAT = e` (global)                  | e; `Destructure k`; `DefineGlobal` for each binding in **reverse** order                                                                                                                                                                                                                                       |
| `fn f(...) {...}` (local)                   | declare `f` first (so the body can capture it); `Closure k …`; `Declare 1`                                                                                                                                                                                                                                     |
| `fn f(...) {...}` (global)                  | `Closure k …`; `DefineGlobal f`                                                                                                                                                                                                                                                                                |
| `fn f(...) {...}` (library mode, top level) | `Closure k …`; `DefineBuiltin b`                                                                                                                                                                                                                                                                               |
| `x = e`                                     | e; `SetLocal`/`SetUpvalue`/`SetGlobal`                                                                                                                                                                                                                                                                         |
| `x op= e`                                   | `Get…`; e; op; `Set…`                                                                                                                                                                                                                                                                                          |
| `o.f = e`                                   | o; e; `SetField f`                                                                                                                                                                                                                                                                                             |
| `o.f op= e`                                 | o; `Dup`; `GetField f`; e; op; `SetField f`                                                                                                                                                                                                                                                                    |
| `o[i] = e`                                  | o; i; e; `SetIndex`                                                                                                                                                                                                                                                                                            |
| `o[i] op= e`                                | o; i; `Dup2`; `GetIndex`; e; op; `SetIndex`                                                                                                                                                                                                                                                                    |
| `return e` / `return`                       | e (or `Nil`); `Return`                                                                                                                                                                                                                                                                                         |
| `break`                                     | `PopN (depth − loop.bodyDepth)` (omit if 0); `Jump loop.exit`                                                                                                                                                                                                                                                  |
| `continue`                                  | `PopN (depth − loop.bodyDepth)` (omit if 0); `Jump loop.continue`                                                                                                                                                                                                                                              |
| `while c B`                                 | `L_c:` c; `JumpIfFalse L_x`; B (statement mode); `Jump L_c`; `L_x:` — `bodyDepth = d`, `continue → L_c`                                                                                                                                                                                                        |
| `for p in e B`                              | e; `IterInit` (hidden local `$iter`); `L_n: IterNext L_x` [stmtStart]; bind p (`Declare 1` / `Destructure k; Declare m` / `Pop` for `_`); B (statement mode, nested scope); `PopN m` (iteration scope, omit if 0); `Jump L_n`; `L_x: Pop` — `bodyDepth = d + 1`, `continue → L_n`                              |
| block `{…}` (value mode)                    | statements, the last expression statement's value kept (else `Nil`); `EndScope n`                                                                                                                                                                                                                              |
| `if c A else B`                             | c; `JumpIfFalse L_e`; A; `Jump L_end`; `L_e:` B or `Nil`; `L_end:`                                                                                                                                                                                                                                             |
| `a and b` / `a or b`                        | a; `AndJump L` / `OrJump L`; b; `L:`                                                                                                                                                                                                                                                                           |
| `match s { arms }`                          | s (hidden local `$subject`); for each arm: `L_i: MatchPattern k L_{i+1}` [stmtStart]; `Declare m` (if m>0); guard? (`guard; JumpIfFalse L_gf`); body [first instr stmtStart]; `EndScope m` (if m>0); `Jump L_end`; `L_gf: PopN m` (if guard; falls through to `L_{i+1}`) … `L_n: NoMatch`; `L_end: EndScope 1` |
| literal                                     | `Const` / `Nil` / `True` / `False`                                                                                                                                                                                                                                                                             |
| template                                    | for each part in order: non-empty literal → `Const`, expression → its code; `Interp n` (n = values pushed)                                                                                                                                                                                                     |
| list                                        | leading plain items; `List n`; then each remaining item: plain → item; `ListAppend` / spread → e; `ListExtend`                                                                                                                                                                                                 |
| record                                      | leading plain fields as `Const key`, value; `Record n`; then each remaining: field → `Const key`, value; `RecordSet` / spread → e; `RecordMerge`                                                                                                                                                               |
| unary / binary                              | operands; op (`Range 0` for `..`, `Range 1` for `..=`)                                                                                                                                                                                                                                                         |
| `a(b, c)` (incl. pipes)                     | callee; args…; `Call argc`                                                                                                                                                                                                                                                                                     |
| `o.f` / `o[i]`                              | o; `GetField f` / o; i; `GetIndex`                                                                                                                                                                                                                                                                             |
| identifier                                  | `GetLocal` / `GetUpvalue` / `GetGlobal` / `GetBuiltin`                                                                                                                                                                                                                                                         |
| function / lambda                           | separate `FunctionProto`; in the enclosing function `Closure k (isLocal, index)…`                                                                                                                                                                                                                              |
| function body                               | pattern-parameter prologue (for each non-identifier parameter `i`: `GetLocal 1+i`; `Destructure k`; `Declare m`; first prologue instruction is stmtStart); then the body block in value mode (or the expression body, its first instruction stmtStart); `Return`                                               |

Identifier parameters occupy their slots directly. A non-identifier parameter's slot is a hidden
local `$argI`. A match arm with `m == 0` and no guard needs no `Declare`/`EndScope`.

#### 4.3.4 Patterns → `PatternDesc`

Patterns compile to a `PatternDesc` stored in the constant pool (`PatternConst`, see
`bytecode.ts`) together with the pattern's source text (for R014/R015) and `bindCount`. The VM
interprets descriptors (§6.5). Binding order is SPEC §6.2.

#### 4.3.5 Debug info (per `FunctionProto.debug`)

- `spanStart/spanEnd[i]` for every code index `i` (operand indices repeat their instruction's
  values). The span is that of the AST node responsible:
  - expressions: the whole node (a `Binary`'s `Add` gets the binary expression's span; a `Call`
    gets the call's span; an `Ident`'s `GetLocal` gets the identifier);
  - assignments: the statement; `Destructure` → the pattern; `Declare`/`DefineGlobal` → the
    declaring statement; `IterNext`, the loop's back `Jump` and `IterInit` → the `for` header
    (`for p in e`); `MatchPattern`/arm `Declare` → the arm's pattern; `NoMatch` → the subject;
    block-ending `EndScope`/`PopN` → the block's closing `}` (1-character span); implicit `Return`
    → the function body's closing `}` or the expression body; the program's final `Nil`/`Return` →
    the empty span at the end of the source.
- `stmtStart[i] = 1` for the first instruction of every statement, every `MatchPattern`, the first
  instruction of every arm body, `IterNext`, the first instruction of a lambda's expression body,
  and the first instruction of a parameter-destructuring prologue. Otherwise 0. (Operand indices: 0.)
- `stmtSpanStart/stmtSpanEnd[i]`: the span of the innermost enclosing statement (for arm bodies, the
  arm; for expression bodies of lambdas, the body expression).
- `locals`: one `LocalInfo` per local slot occupancy, including parameters (`startIp = 0`,
  `endIp = code.length`) and hidden locals (`hidden: true`, name starts with `$`). `startIp` is the
  ip right after the `Declare` (or the instruction that pushed a hidden local). A local is live at
  instruction pointer `ip` when `startIp <= ip < endIp`.
- `upvalueNames[i]`: the captured variable's name.
- Display names: SPEC §7.12. `FunctionProto.name` is `null` for unnamed functions; the script is
  `kind: 'script'` with name `'<top level>'`.

### 4.4 Disassembler — `disassemble(proto | program): string`

One line per instruction: `ip  OPNAME operands  ; comment` (constant values, names, jump targets,
line numbers). Used by tests and `hindsight disasm`.

## 5. Bytecode (`src/core/bytecode.ts`)

### 5.1 Encoding

`FunctionProto.code` is a flat `number[]`: each instruction is its opcode followed by its operands,
each operand one array element (no byte packing). Jump targets are **absolute** code indices.

### 5.2 Instruction set

Stack effects are written `( before -- after )`, top of stack on the right.

| op                                  | operands                                               | effect                                               | semantics                                                                               |
| ----------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `Const`                             | k                                                      | `( -- v )`                                           | push `constants[k]` (number or string)                                                  |
| `Nil` `True` `False`                | —                                                      | `( -- v )`                                           |                                                                                         |
| `Pop`                               | —                                                      | `( v -- )`                                           |                                                                                         |
| `PopN`                              | n                                                      | `( v1…vn -- )`                                       | close open upvalues pointing at those slots, then pop n                                 |
| `EndScope`                          | n                                                      | `( x1…xn v -- v )`                                   | close upvalues for x1…xn, remove them, keep v                                           |
| `Dup`                               | —                                                      | `( a -- a a )`                                       |                                                                                         |
| `Dup2`                              | —                                                      | `( a b -- a b a b )`                                 |                                                                                         |
| `GetLocal` / `SetLocal`             | slot                                                   | `( -- v )` / `( v -- )`                              | `stack[base + slot]`                                                                    |
| `GetUpvalue` / `SetUpvalue`         | i                                                      | `( -- v )` / `( v -- )`                              | the closure's upvalue i (open: the stack slot; closed: the cell)                        |
| `GetGlobal` / `SetGlobal`           | k (name)                                               | `( -- v )` / `( v -- )`                              | R006 if not yet defined                                                                 |
| `DefineGlobal`                      | k (name)                                               | `( v -- )`                                           | define (records a `declare` event)                                                      |
| `GetBuiltin`                        | b                                                      | `( -- v )`                                           | `builtins[b]`                                                                           |
| `DefineBuiltin`                     | b                                                      | `( v -- )`                                           | library initialization only                                                             |
| `Declare`                           | n                                                      | `( -- )`                                             | no-op; the top n stack slots become declared locals (records `declare` events)          |
| `GetField` / `SetField`             | k (name)                                               | `( o -- v )` / `( o v -- )`                          | SPEC §7.9                                                                               |
| `GetIndex` / `SetIndex`             | —                                                      | `( o i -- v )` / `( o i v -- )`                      | SPEC §7.7–7.9                                                                           |
| `Add` `Sub` `Mul` `Div` `Mod` `Pow` | —                                                      | `( a b -- r )`                                       | SPEC §7.2                                                                               |
| `Neg` `Not`                         | —                                                      | `( a -- r )`                                         |                                                                                         |
| `Eq` `Ne` `Lt` `Le` `Gt` `Ge`       | —                                                      | `( a b -- bool )`                                    | SPEC §7.3                                                                               |
| `Range`                             | inclusive (0/1)                                        | `( a b -- range )`                                   |                                                                                         |
| `Jump`                              | target                                                 | `( -- )`                                             |                                                                                         |
| `JumpIfFalse`                       | target                                                 | `( c -- )`                                           | pops; jumps when falsy                                                                  |
| `AndJump`                           | target                                                 | `( a -- a )` or `( a -- )`                           | falsy: jump keeping `a`; else pop `a`                                                   |
| `OrJump`                            | target                                                 | same                                                 | truthy: jump keeping `a`; else pop `a`                                                  |
| `Call`                              | argc                                                   | `( f a1…an -- r )`                                   | §6.3                                                                                    |
| `Return`                            | —                                                      | `( v -- )`                                           | §6.3                                                                                    |
| `Closure`                           | k, then `isLocal, index` × `constants[k].upvalueCount` | `( -- closure )`                                     | push the closure **first**, then capture (so a local function can capture its own slot) |
| `List`                              | n                                                      | `( v1…vn -- list )`                                  |                                                                                         |
| `ListAppend`                        | —                                                      | `( list v -- list )`                                 |                                                                                         |
| `ListExtend`                        | —                                                      | `( list it -- list )`                                | append every element of iterable `it` (R013)                                            |
| `Record`                            | n                                                      | `( k1 v1 … kn vn -- rec )`                           | keys are string constants                                                               |
| `RecordSet`                         | —                                                      | `( rec k v -- rec )`                                 |                                                                                         |
| `RecordMerge`                       | —                                                      | `( rec other -- rec )`                               | R024 when `other` is not a record                                                       |
| `Interp`                            | n                                                      | `( v1…vn -- string )`                                | concatenation of `show(vi)`                                                             |
| `IterInit`                          | —                                                      | `( it -- iter )`                                     | R013 when not iterable                                                                  |
| `IterNext`                          | target                                                 | `( iter -- iter v )` or jump with `( iter -- iter )` | jump when exhausted                                                                     |
| `Destructure`                       | k (pattern)                                            | `( v -- b1…bm )`                                     | R014 on mismatch                                                                        |
| `MatchPattern`                      | k (pattern), target                                    | `( v -- v b1…bm )` or jump with `( v -- v )`         | bindings pushed only on success                                                         |
| `NoMatch`                           | —                                                      | `( v -- )`                                           | raises R015 with `v`                                                                    |

## 6. Runtime

### 6.1 Values (`values.ts`)

- `nil` → `null`, bools → `boolean`, numbers → `number`, strings → `string` (JS primitives).
- Heap objects are JS objects with a `type` tag and a numeric `id`:
  `list {items}`, `record {fields: Map<string, Value>}`, `closure {proto, upvalues: Cell[]}`,
  `native {name, minArgs, maxArgs, fn}`, `range {start, end, step, inclusive}`,
  `iterator {…}`, `cell {open, stackIndex, value, ownerFrameUid, slot}` (an upvalue).
- **Object ids** come from a counter in the VM state, starting at 1, incremented on every allocation
  (lists, records, closures, ranges, iterators, cells). Builtins (natives and library closures) have
  negative ids: `-(builtinIndex + 1)`.
- `show`, `repr`, `equals`, `typeName`, `articleType`, `isTruthy` live here and are shared by the VM,
  natives, inspector and CLI.

### 6.2 VM state

`stack: Value[]`, `frames: Frame[]` (`{closure, ip, base, uid}`), `openCells` (sorted by stack
index), `globals: Map<string, Value>` (insertion order = definition order), `time` (steps executed),
`nextObjectId`, `nextFrameUid` (the script frame is uid 1), `rng` (generator state, seeded with
`seed`), `status: 'running' | 'finished' | 'error'`, `error: RuntimeErrorInfo | null`.

The VM receives `{ builtins: Value[], libraryProtos: FunctionProto[] }` from `library.ts` via
`index.ts`; it never builds them itself.

### 6.3 Calls and returns

- `Call argc`: callee at `stack[top − argc]`.
  - native: check arity (R005) and run the native atomically within the same step; replace callee
    and args with the result.
  - closure: check arity (R005) and depth (R016) **before** mutating anything; push a frame
    `{base = top − argc, ip = 0, uid = nextFrameUid++}`; record a `declare` event for each parameter
    slot `1..arity` of the new frame.
  - anything else: R004.
- `Return`: pop the result, close cells for slots `>= base`, drop the frame's region, push the
  result. When the script frame returns, the run is `finished` with an empty stack and no frames.

### 6.4 Natives (`natives.ts`)

`createNatives(): Value[]` in `NATIVE_NAMES` order (functions as `native` objects; `PI`, `INF` as
numbers). A native receives `(ctx, args)`. `ctx` offers: `print(text)`, `alloc` helpers that assign
ids and record `alloc` events, write-event helpers for mutations (`push`, `insert`, `remove`, `pop`,
`delete`), the RNG, `time`, and `fail(code, message, hint?)`. Natives never call back into user
code.

### 6.5 Pattern matching

The VM matches a `PatternDesc` (§4.3.4) against a value per SPEC §6. A rest binding allocates a new
list. On success it pushes the bindings in order; `Destructure` raises R014 on failure,
`MatchPattern` jumps.

### 6.6 Errors

The VM builds a `RuntimeErrorInfo` at the moment of failure (code, message, hint, span of the failing
instruction, stack innermost-first). If the failing instruction belongs to library code, `span` is the
span of the `Call` instruction in the nearest user frame (SPEC §10.4). After an error the VM state may
be inconsistent; consumers never read it (the recorder rebuilds time `N` by replay).

### 6.7 Hooks (recording events)

`vm.hooks` is `null` during replay (fast path) and a `VMHooks` object while recording. The VM calls:

- `output(time, text)` for `print`;
- `event(time, kind, target, value)` with `kind` ∈ `'declare' | 'write'` for: `Declare` (locals),
  call parameters, `DefineGlobal` (`declare`); `SetLocal`, `SetUpvalue`, `SetGlobal`, `SetField`,
  `SetIndex`, record/list mutations by natives (`write`). Targets are `WriteTarget`s
  (`api-types.ts`): a `SetUpvalue` on an **open** cell is reported as a write to the owning frame's
  local slot; on a closed cell as a write to `{kind: 'cell'}`. `push` reports an element write at the
  new index; `insert` reports an element write at the index **and** an `object` write; `pop`,
  `remove` and `delete` report `object` writes (`delete` also a field write of `nil`);
- `alloc(time, objectId)` for every allocation;
- `cellClosed(time, cellId, ownerFrameUid, slot)` when an open cell is closed.

`time` is always the index of the step being executed.

### 6.8 Snapshots

`snapshot()` deep-copies all mutable state reachable from the stack, frames, globals and open cells,
preserving object identity and ids (a `Map` from original to copy). Strings, numbers, ranges,
natives, library closures and `FunctionProto`s are shared, never copied. `restore(s)` copies again,
so a snapshot can be restored any number of times. Both are O(reachable heap).

### 6.9 Library (`prelude.ts`, `library.ts`)

`prelude.ts` exports `PRELUDE_SOURCE`: Hindsight code containing **only** top-level `fn`
declarations, in `LIBRARY_NAMES` order. `getLibrary()` (lazy singleton) compiles it with
`mode: 'library'`, `firstProtoId: 0` (library protos are `debug.library = true`,
`source: 'prelude'`), runs it once in a VM whose builtins array has the natives filled in, collects
the closures stored by `DefineBuiltin`, renumbers their ids to `-(index + 1)`, and returns
`{ source, builtins, protos }`. In library mode, references to library names resolve to `GetBuiltin`,
and anything other than top-level `fn` declarations is an internal error.

## 7. Time travel

### 7.1 Recorder (`recorder.ts`) — implements `Recording` (`api-types.ts`)

`record(program, options)`, `recordAsync(program, options)`:

1. Create the VM with recording hooks. For each step `t`: append the location of the instruction
   about to execute (proto id, ip, depth = frames − 1) to the trace, take a snapshot when
   `t % interval == 0`, then `vm.step()`.
2. Stop when the VM finishes, errors, or `t == maxSteps` (outcome `step-limit`), or when aborted.
   On error at step `k`, `N = k` and the trace also stores the failing location as `locationAt(N)`.
3. **Snapshot thinning**: start with `interval = 256` and keep at most `snapshotBudget` (default 512) snapshots. When the budget is exceeded, drop every other snapshot (keeping time 0) and
   double the interval.
4. **Seek** `stateAt(t)`: restore the latest snapshot `<= t` and replay with `vm.runUntil(t)`
   (hooks off). Keep the VM positioned at the last seek, so a forward seek within the interval runs
   on without restoring. Cache recently built `StateView`s (small LRU).
5. Storage is columnar (typed arrays that grow by doubling) for the per-step trace and for events;
   object-per-step storage is not acceptable. Budget: recording 1,000,000 steps of a typical
   program must take under 2 seconds and stay under ~150 MB.
6. `recordAsync` runs in slices of ~8 ms, yielding to the event loop between slices
   (`setTimeout(0)`), reports `onProgress(time)`, and resolves with outcome `aborted` when its
   `AbortSignal` fires. `extend(extraSteps)` continues a `step-limit` recording from its end.

### 7.2 Navigator (`navigator.ts`)

Let `S(t)` = the instruction at `t` is a stmtStart, `U(t)` = it is user code (`source: 'main'`),
`D(t)` = depth, `L(t)` = the 1-based line of the instruction's span start. `D(N)` is the depth of
`locationAt(N)` when it exists, else 0. With **just-my-code** (JMC) on, add `U(t')` to every
predicate below.

| operation | forward result (else `N`)                 | backward result (else `0`)            |
| --------- | ----------------------------------------- | ------------------------------------- |
| step into | min `t' > t`: `S(t')`                     | max `t' < t`: `S(t')`                 |
| step over | min `t' > t`: `S(t') ∧ D(t') <= D(t)`     | max `t' < t`: `S(t') ∧ D(t') <= D(t)` |
| step out  | min `t' > t`: `D(t') < D(t)`              | max `t' < t`: `D(t') < D(t)`          |
| continue  | min `t' > t`: `S(t') ∧ U(t') ∧ L(t') ∈ B` | max `t' < t`: same                    |

`B` is the set of breakpoint lines. `lineHits(line)` lists every `t` with `S(t) ∧ U(t) ∧ L(t) = line`;
`lineHitCounts()` aggregates them. Linear scans over typed arrays are fast enough; precompute where
cheap.

### 7.3 Provenance

Events (`declare`, `write`, `alloc`, `cellClosed`) are indexed per target. `origin(target, before)`
returns the latest event with `time < before` among:

- events for exactly that target;
- for `element` targets: `object`-level events of the same object, and the object's `alloc`;
- for `field` targets: the object's `alloc`;
- for `object` targets: every field/element/object event of that object, and its `alloc`;
- for `cell` targets: events for the cell, and — before the cell's `cellClosed` time — events for the
  owning frame's local slot.

`history(target)` returns all of them in ascending time order. Event `value`s are stored as
`TracedValue` (primitives as-is, objects as `{ref: id}`).

### 7.4 Inspector (`inspector.ts`)

Builds a `StateView` (`api-types.ts`) from the VM positioned at time `t`:

- `frames`: outermost first. For each frame: uid, display name, proto id, ip, library flag; `span`
  and `stmtSpan` of the instruction at `ip` (for non-top frames, of the `Call` they are waiting on,
  i.e. the instruction just before `ip`); live non-hidden locals (`startIp <= ip < endIp` and inside
  the frame's stack region), in slot order, each with its `WriteTarget`; the closure's captured
  variables (name, value, target per §6.7); and `temps`, the stack values above the highest live
  local.
- `globals`: defined user globals in definition order with mutability (from the declaring
  statement).
- `heap`: objects reachable from frames and globals, breadth first, at most `heapLimit` (default 250) objects; `heapTruncated` when more exist. Builtins are never expanded.
- `ValueView` for references includes a `preview` (repr truncated to ~48 characters).
- At `t == N`: frames are empty when finished; when the outcome is an error or step limit, frames
  show the paused state and `error` is set for errors.

## 8. Public API (`src/core/index.ts`)

```ts
compile(source: string): CompileResult              // lex + parse + compile against the library
run(program, { maxSteps?, seed?, onOutput? }): RunResult   // fast, no recording
record(program, RecordOptions): Recording
recordAsync(program, RecordOptions & { signal?, onProgress?, sliceMs? }): Promise<Recording>
disassemble(program): string
getLibrarySource(): string
show, repr, LineIndex, and all types from api-types.ts / diagnostics.ts / span.ts
```

`compile` never throws for user input; it returns diagnostics sorted by position.

## 9. Command-line tool (`src/cli`)

`hindsight <command>`; run during development with `npm run sight -- <command>`.

| command                               | behavior                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `run FILE [--max-steps N] [--seed S]` | print output; on error print a diagnostic and exit 1                                           |
| `check FILE`                          | compile only; print diagnostics; exit 1 on errors                                              |
| `disasm FILE`                         | print the disassembly                                                                          |
| `replay FILE --at T [--max-steps N]`  | record, then print the state at time `T`: location, frames with locals, globals, output so far |
| `why FILE --line L --name X`          | record, then show every write to variable `X` declared on line `L` with values and times       |
| `test [DIR]`                          | run `.sight` files with `// expect` annotations (§10.2); summary; exit 1 on failure            |
| `repl`                                | interactive prompt; globals persist between entries                                            |

Diagnostics print Rust-style with a code frame and caret underline (`error[E020]: …`, `--> file:3:9`,
the source line, `^^^`, `= hint: …`), colored only when stdout is a TTY.

## 10. Testing

### 10.1 Unit tests

Every module has co-located tests. Coverage target: 80 %+ lines for `src/core`, `src/cli`, and the
non-visual parts of `src/studio`.

### 10.2 Conformance corpus (`tests/lang/**/*.sight`, run by `tests/corpus.test.ts`)

Annotations are line comments:

```
print(1 + 2)              // expect: 3
let x = undefined_thing   // expect compile error E020: undefined variable 'undefined_thing'
print([1][5])             // expect runtime error R007: index 5 is out of bounds
```

- `// expect: TEXT` — the next output line equals `TEXT` exactly (text after `expect: `, trailing
  whitespace removed). Output lines are matched in order.
- `// expect compile error [CODE]: TEXT` — compilation fails with an error on **this line** whose
  message contains `TEXT` (and whose code is `CODE` when given). Every compile error must be expected.
- `// expect runtime error [CODE]: TEXT` — the program compiles, produces exactly the preceding
  `expect:` lines, then stops with a runtime error on this line whose message contains `TEXT`.
- A file without error expectations must compile, finish within 5,000,000 steps, and print exactly the
  expected lines.
- The runner also records every passing program and checks that the recording's outputs equal the
  fast run's outputs.

### 10.3 Time-travel properties (`tests/timetravel.test.ts`, fast-check)

For corpus and generated programs: `stateAt(t)` equals the state reached by a fresh VM run to `t`;
seeking in random orders gives identical views; forward navigation results are always `> t` (or `N`)
and backward `< t` (or 0); stepping into then back returns to a stmtStart; `origin` never returns an
event at or after `before`.

### 10.4 End-to-end (`e2e/`)

Playwright against the dev server with the local Chrome (`channel: 'chrome'`): load, run an example,
step forwards and backwards, scrub the timeline, click output to jump, jump to a variable's origin,
toggle breakpoints, compile errors, sharing links.

## 11. Studio

The studio (`src/studio`) is a single-page React app (see the Studio section added in the UI phase).
It consumes only `src/core/index.ts`.
