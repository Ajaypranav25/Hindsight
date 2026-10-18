/**
 * The builtin table order (docs/SPEC.md §9). Builtin index = position in BUILTIN_NAMES: natives
 * first, then library functions. The compiler emits `GetBuiltin index`; natives.ts must create
 * natives in NATIVE_NAMES order; prelude.ts must declare library functions in LIBRARY_NAMES order.
 */
export const NATIVE_NAMES = [
  'print',
  'str',
  'repr',
  'type',
  'len',
  'num',
  'list',
  'range',
  'assert',
  'panic',
  'push',
  'pop',
  'insert',
  'remove',
  'slice',
  'reverse',
  'sort',
  'contains',
  'index_of',
  'join',
  'min',
  'max',
  'copy',
  'keys',
  'values',
  'entries',
  'has',
  'get',
  'delete',
  'upper',
  'lower',
  'trim',
  'split',
  'replace',
  'starts_with',
  'ends_with',
  'repeat',
  'chars',
  'char_code',
  'from_char_code',
  'pad_start',
  'pad_end',
  'abs',
  'floor',
  'ceil',
  'sqrt',
  'sin',
  'cos',
  'log',
  'round',
  'atan2',
  'random',
  'random_int',
  'seed',
  'steps',
  'PI',
  'INF',
] as const

export const LIBRARY_NAMES = [
  'map',
  'filter',
  'reduce',
  'each',
  'find',
  'find_index',
  'any',
  'all',
  'count',
  'sum',
  'sort_by',
  'zip',
  'enumerate',
  'flat_map',
  'flatten',
  'take',
  'drop',
  'uniq',
  'group_by',
  'min_by',
  'max_by',
  'times',
  'chunk',
] as const

export type NativeName = (typeof NATIVE_NAMES)[number]
export type LibraryName = (typeof LIBRARY_NAMES)[number]
export type BuiltinName = NativeName | LibraryName

export const BUILTIN_NAMES: readonly BuiltinName[] = [...NATIVE_NAMES, ...LIBRARY_NAMES]

export const NATIVE_COUNT = NATIVE_NAMES.length
export const LIBRARY_COUNT = LIBRARY_NAMES.length

const INDEX: ReadonlyMap<string, number> = new Map(BUILTIN_NAMES.map((name, i) => [name, i]))

/** The builtin index of `name`, or -1 when `name` is not a builtin. */
export function builtinIndex(name: string): number {
  return INDEX.get(name) ?? -1
}

export function isBuiltinName(name: string): name is BuiltinName {
  return INDEX.has(name)
}

/** True for library (prelude) builtins, false for natives. */
export function isLibraryIndex(index: number): boolean {
  return index >= NATIVE_COUNT && index < NATIVE_COUNT + LIBRARY_COUNT
}
