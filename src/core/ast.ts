/**
 * The Hindsight abstract syntax tree (docs/SPEC.md §3). Every node has a `span` covering its full
 * source text. Nodes are plain immutable data; nothing mutates a tree after the parser builds it.
 */
import type { Span } from './span'

// ---------------------------------------------------------------------------------------------
// Program and statements

export interface Program {
  readonly kind: 'Program'
  readonly body: readonly Stmt[]
  readonly span: Span
}

export type Stmt =
  | ExprStmt
  | LetStmt
  | FnDecl
  | AssignStmt
  | ReturnStmt
  | BreakStmt
  | ContinueStmt
  | WhileStmt
  | ForStmt
  | BlockStmt

export interface ExprStmt {
  readonly kind: 'ExprStmt'
  readonly expr: Expr
  readonly span: Span
}

/** `let PATTERN = init` (mutable = false) or `var PATTERN = init` (mutable = true). */
export interface LetStmt {
  readonly kind: 'Let'
  readonly mutable: boolean
  readonly pattern: Pattern
  readonly init: Expr
  readonly span: Span
}

/** `fn name(params) { body }`. `fn.name` equals `name`. */
export interface FnDecl {
  readonly kind: 'FnDecl'
  readonly name: string
  readonly nameSpan: Span
  readonly fn: FunctionExpr
  readonly span: Span
}

export type AssignOp = '=' | '+=' | '-=' | '*=' | '/=' | '%='

export interface AssignStmt {
  readonly kind: 'Assign'
  readonly op: AssignOp
  readonly target: Ident | Member | Index
  readonly value: Expr
  readonly span: Span
}

export interface ReturnStmt {
  readonly kind: 'Return'
  readonly value: Expr | null
  readonly span: Span
}

export interface BreakStmt {
  readonly kind: 'Break'
  readonly span: Span
}

export interface ContinueStmt {
  readonly kind: 'Continue'
  readonly span: Span
}

export interface WhileStmt {
  readonly kind: 'While'
  readonly cond: Expr
  readonly body: Block
  readonly span: Span
}

export interface ForStmt {
  readonly kind: 'For'
  readonly pattern: Pattern
  readonly iterable: Expr
  readonly body: Block
  /** The `for PATTERN in ITERABLE` header, excluding the body. */
  readonly headerSpan: Span
  readonly span: Span
}

/** A block used as a statement (introduces a scope; its value is discarded). */
export interface BlockStmt {
  readonly kind: 'BlockStmt'
  readonly block: Block
  readonly span: Span
}

/** `{ statements }`. Used for bodies; not an expression on its own (see SPEC §3.1). */
export interface Block {
  readonly kind: 'Block'
  readonly body: readonly Stmt[]
  readonly span: Span
}

// ---------------------------------------------------------------------------------------------
// Expressions

export type Expr =
  | NumberLit
  | StringLit
  | TemplateLit
  | BoolLit
  | NilLit
  | Ident
  | ListLit
  | RecordLit
  | Unary
  | Binary
  | Logical
  | Call
  | Index
  | Member
  | FunctionExpr
  | IfExpr
  | MatchExpr

export interface NumberLit {
  readonly kind: 'Number'
  readonly value: number
  readonly span: Span
}

export interface StringLit {
  readonly kind: 'String'
  readonly value: string
  readonly span: Span
}

/** An interpolated string. `quasis.length === exprs.length + 1`; quasis may be empty strings. */
export interface TemplateLit {
  readonly kind: 'Template'
  readonly quasis: readonly string[]
  readonly exprs: readonly Expr[]
  readonly span: Span
}

export interface BoolLit {
  readonly kind: 'Bool'
  readonly value: boolean
  readonly span: Span
}

export interface NilLit {
  readonly kind: 'Nil'
  readonly span: Span
}

export interface Ident {
  readonly kind: 'Ident'
  readonly name: string
  readonly span: Span
}

export interface Spread {
  readonly kind: 'Spread'
  readonly expr: Expr
  readonly span: Span
}

export interface ListLit {
  readonly kind: 'List'
  readonly items: readonly (Expr | Spread)[]
  readonly span: Span
}

/** `key: value`, `"key": value`, or shorthand `key` (value is then an `Ident` for `key`). */
export interface RecordField {
  readonly kind: 'Field'
  readonly key: string
  readonly keySpan: Span
  readonly value: Expr
  readonly shorthand: boolean
  readonly span: Span
}

export interface RecordLit {
  readonly kind: 'Record'
  readonly items: readonly (RecordField | Spread)[]
  readonly span: Span
}

export interface Unary {
  readonly kind: 'Unary'
  readonly op: '-' | 'not'
  readonly operand: Expr
  readonly span: Span
}

export type BinaryOp =
  '+' | '-' | '*' | '/' | '%' | '**' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '..' | '..='

export interface Binary {
  readonly kind: 'Binary'
  readonly op: BinaryOp
  readonly left: Expr
  readonly right: Expr
  readonly opSpan: Span
  readonly span: Span
}

export interface Logical {
  readonly kind: 'Logical'
  readonly op: 'and' | 'or'
  readonly left: Expr
  readonly right: Expr
  readonly span: Span
}

/** A call. `pipe` is true when the call was written with `|>` (SPEC §7.11). */
export interface Call {
  readonly kind: 'Call'
  readonly callee: Expr
  readonly args: readonly Expr[]
  readonly pipe: boolean
  readonly span: Span
}

export interface Index {
  readonly kind: 'Index'
  readonly object: Expr
  readonly index: Expr
  readonly span: Span
}

export interface Member {
  readonly kind: 'Member'
  readonly object: Expr
  readonly name: string
  readonly nameSpan: Span
  readonly span: Span
}

/**
 * A function: `fn name(...) {...}` (via FnDecl), `fn(...) {...}` or a lambda `|...| body`.
 * `name` is the declared name for FnDecl and null otherwise; the compiler infers display names for
 * `let x = <function>` (SPEC §7.12).
 */
export interface FunctionExpr {
  readonly kind: 'Function'
  readonly name: string | null
  readonly params: readonly Pattern[]
  readonly body: Block | Expr
  readonly form: 'fn' | 'lambda'
  readonly span: Span
}

export interface IfExpr {
  readonly kind: 'If'
  readonly cond: Expr
  readonly then: Block
  readonly else: Block | IfExpr | null
  readonly span: Span
}

export interface MatchArm {
  readonly kind: 'Arm'
  readonly pattern: Pattern
  readonly guard: Expr | null
  readonly body: Block | Expr
  readonly span: Span
}

export interface MatchExpr {
  readonly kind: 'Match'
  readonly subject: Expr
  readonly arms: readonly MatchArm[]
  readonly span: Span
}

// ---------------------------------------------------------------------------------------------
// Patterns (SPEC §6)

export type Pattern =
  | WildcardPattern
  | BindPattern
  | LiteralPattern
  | RangePattern
  | ListPattern
  | RecordPattern
  | OrPattern

export interface WildcardPattern {
  readonly kind: 'PWildcard'
  readonly span: Span
}

export interface BindPattern {
  readonly kind: 'PBind'
  readonly name: string
  readonly span: Span
}

export interface LiteralPattern {
  readonly kind: 'PLiteral'
  readonly value: number | string | boolean | null
  readonly span: Span
}

export interface RangePattern {
  readonly kind: 'PRange'
  readonly start: number
  readonly end: number
  readonly inclusive: boolean
  readonly span: Span
}

/** `...name` binds the middle items; `...` and `..._` discard them (name = null). */
export interface RestPattern {
  readonly kind: 'PRest'
  readonly name: string | null
  readonly span: Span
}

/** `[before..., ...rest, after...]`; without a rest element, `after` is empty. */
export interface ListPattern {
  readonly kind: 'PList'
  readonly before: readonly Pattern[]
  readonly rest: RestPattern | null
  readonly after: readonly Pattern[]
  readonly span: Span
}

export interface RecordPatternField {
  readonly key: string
  readonly keySpan: Span
  readonly pattern: Pattern
  readonly shorthand: boolean
  readonly span: Span
}

export interface RecordPattern {
  readonly kind: 'PRecord'
  readonly fields: readonly RecordPatternField[]
  readonly span: Span
}

export interface OrPattern {
  readonly kind: 'POr'
  readonly alternatives: readonly Pattern[]
  readonly span: Span
}
