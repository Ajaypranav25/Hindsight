/**
 * Clause templates for contract inference (ARCHITECTURE §7.17), in the manner of Daikon's likely
 * invariants: each template is instantiated over a function's parameters and its result, and a
 * candidate survives only when it held in every observed call. The clause texts are Hindsight
 * expressions that use only builtins (SPEC §9), so they can be pasted into a `fn` header.
 */
import {
  listContains,
  listItems,
  type Plain,
  plainEquals,
  plainLength,
  plainList,
  roundHalfAway,
  sortableItems,
  sortedItems,
  typeName,
  uniqueItems,
} from './infer-values'

/** One returned call of the function, as plain data. */
export interface Observation {
  readonly entry: number
  /** Identifier parameters at entry, by parameter position. */
  readonly before: readonly Plain[]
  /** The same parameters when the call returned (lists and records may have changed). */
  readonly after: readonly Plain[]
  readonly result: Plain
  /** `average(xs = [1, 2]) returned 1.5` */
  readonly example: string
}

/** An identifier parameter: its name and position. */
export interface Param {
  readonly name: string
  readonly index: number
}

export type TemplateKind =
  | 'equals'
  | 'image'
  | 'arith'
  | 'linear'
  | 'sorted'
  | 'subset'
  | 'member'
  | 'length'
  | 'order'
  | 'non-empty'
  | 'sign'
  | 'type'
  | 'non-nil'

/** Lower comes first among clauses with equal support. */
export const TEMPLATE_PRIORITY: Readonly<Record<TemplateKind, number>> = {
  equals: 0,
  image: 1,
  arith: 2,
  linear: 3,
  sorted: 4,
  subset: 5,
  member: 6,
  length: 7,
  order: 8,
  'non-empty': 9,
  sign: 10,
  type: 11,
  'non-nil': 12,
}

export interface Candidate {
  readonly kind: 'requires' | 'ensures'
  readonly template: TemplateKind
  readonly clause: string
  /** The variable it constrains (a parameter name or `result`). */
  readonly subject: string
  /** Only one type satisfies it, so type and nil checks of `subject` are implied. */
  readonly typed: boolean
  /** `result == EXPR`: the contract oracle trusts every call that satisfies it (§7.6). */
  readonly pins: boolean
  /** Parameter positions whose distinct values count as its support (empty: all of them). */
  readonly reads: readonly number[]
  holds(observation: Observation): boolean | null
  /** Whether a call says anything about it (an empty result says nothing about sortedness). */
  informative(observation: Observation): boolean
}

type Get = (observation: Observation) => Plain
type Num = (observation: Observation) => number | null

const ALWAYS = (): boolean => true
const LINEAR_MAX_FACTOR = 10
const LINEAR_MAX_OFFSET = 1000
/** Distinct source values a linear relation needs: two always fit a line. */
const LINEAR_MIN_SOURCES = 3

function every<T>(items: readonly T[], test: (item: T) => boolean): boolean {
  return items.every(test)
}

function isNumber(value: Plain): value is number {
  return typeof value === 'number' && !Number.isNaN(value)
}

function numberOf(value: Plain): number | null {
  return isNumber(value) ? value : null
}

/** Every candidate for `params` over `observations` (not yet checked against them all). */
export function candidatesFor(
  params: readonly Param[],
  observations: readonly Observation[],
): Candidate[] {
  const found: Candidate[] = []
  for (const param of params) {
    const get: Get = (o) => o.before[param.index]!
    found.push(...variableCandidates('requires', param.name, [param.index], get, observations))
  }
  found.push(...variableCandidates('ensures', 'result', [], (o) => o.result, observations))
  found.push(...sortedCandidate(observations))
  for (const param of params) found.push(...relationCandidates(param, params, observations))
  for (let i = 0; i < params.length; i++) {
    for (let j = i + 1; j < params.length; j++) {
      found.push(...arithmeticCandidates(params[i]!, params[j]!, observations))
    }
  }
  found.push(...linearCandidates(params, observations))
  return found
}

function candidate(
  fields: Omit<Candidate, 'informative' | 'typed' | 'pins' | 'reads'> &
    Partial<Pick<Candidate, 'informative' | 'typed' | 'pins' | 'reads'>>,
): Candidate {
  return { informative: ALWAYS, typed: false, pins: false, reads: [], ...fields }
}

/** Type, nil, sign and emptiness clauses about one variable. */
function variableCandidates(
  kind: 'requires' | 'ensures',
  name: string,
  reads: readonly number[],
  get: Get,
  observations: readonly Observation[],
): Candidate[] {
  const found: Candidate[] = []
  const types = new Set(observations.map((o) => typeName(get(o))))
  const base = { kind, subject: name, reads }
  const [only] = types
  if (types.size === 1 && only !== null && only !== undefined && only !== 'nil') {
    found.push(
      candidate({
        ...base,
        template: 'type',
        clause: `type(${name}) == "${only}"`,
        holds: (o) => typeName(get(o)) === only,
      }),
    )
  } else if (!types.has('nil') && !types.has(null)) {
    found.push(
      candidate({
        ...base,
        template: 'non-nil',
        clause: `${name} != nil`,
        holds: (o) => get(o) !== null,
      }),
    )
  }
  if (every(observations, (o) => isNumber(get(o))))
    found.push(...signCandidate(base, get, observations))
  const lengths = observations.map((o) => plainLength(get(o)))
  if (only !== 'record' && lengths.every((length) => length !== null && length > 0)) {
    found.push(
      candidate({
        ...base,
        template: 'non-empty',
        clause: `len(${name}) > 0`,
        holds: (o) => (plainLength(get(o)) ?? 0) > 0,
      }),
    )
  }
  return found
}

function signCandidate(
  base: { kind: 'requires' | 'ensures'; subject: string; reads: readonly number[] },
  get: Get,
  observations: readonly Observation[],
): Candidate[] {
  const values = observations.map((o) => get(o) as number)
  const tests: [string, (x: number) => boolean][] = [
    ['> 0', (x) => x > 0],
    ['>= 0', (x) => x >= 0],
    ['< 0', (x) => x < 0],
    ['<= 0', (x) => x <= 0],
  ]
  const fit = tests.find(([, test]) => values.every(test))
  if (fit === undefined) return []
  const [text, test] = fit
  return [
    candidate({
      ...base,
      template: 'sign',
      typed: true,
      clause: `${base.subject} ${text}`,
      holds: (o) => isNumber(get(o)) && test(get(o) as number),
    }),
  ]
}

function sortedCandidate(observations: readonly Observation[]): Candidate[] {
  if (!every(observations, (o) => sortableItems(o.result) !== null)) return []
  return [
    candidate({
      kind: 'ensures',
      template: 'sorted',
      subject: 'result',
      typed: true,
      clause: 'result == sort(result)',
      holds: (o) => {
        const items = sortableItems(o.result)
        return items !== null && sortedItems(items).every((item, i) => item === items[i])
      },
      informative: (o) => (plainLength(o.result) ?? 0) >= 2,
    }),
  ]
}

/** Clauses relating the result to one parameter (at the return). */
function relationCandidates(
  param: Param,
  params: readonly Param[],
  observations: readonly Observation[],
): Candidate[] {
  const p = param.name
  const after: Get = (o) => o.after[param.index]!
  const base = { kind: 'ensures' as const, reads: [param.index] }
  const found: Candidate[] = [
    candidate({
      ...base,
      template: 'equals',
      subject: 'result',
      pins: true,
      clause: `result == ${p}`,
      holds: (o) => plainEquals(o.result, after(o)),
    }),
  ]
  if (every(observations, (o) => isNumber(o.result) && isNumber(after(o)))) {
    found.push(...orderCandidates(param, observations))
  }
  if (every(observations, (o) => sameSized(o.result, after(o)))) {
    found.push(...lengthCandidates(param, observations))
  }
  if (every(observations, (o) => listItems(after(o)) !== null)) {
    found.push(
      candidate({
        ...base,
        template: 'member',
        subject: 'result',
        clause: `contains(${p}, result)`,
        holds: (o) => listContains(listItems(after(o))!, o.result),
      }),
    )
    if (every(observations, (o) => listItems(o.result) !== null)) {
      const item = lambdaName(params)
      found.push(
        candidate({
          ...base,
          template: 'subset',
          subject: 'result',
          typed: true,
          clause: `all(result, |${item}| contains(${p}, ${item}))`,
          holds: (o) => subsetOf(listItems(o.result), listItems(after(o))),
          informative: (o) => (plainLength(o.result) ?? 0) > 0,
        }),
      )
    }
  }
  found.push(...imageCandidates(param, observations))
  return found
}

/** Two lists or two strings: lengths worth comparing (a record's size is another matter). */
function sameSized(a: Plain, b: Plain): boolean {
  const kind = typeName(a)
  return (kind === 'list' || kind === 'string') && typeName(b) === kind
}

/** A lambda parameter name that no function parameter shadows. */
function lambdaName(params: readonly Param[]): string {
  const taken = new Set(params.map((param) => param.name))
  return ['x', 'v', 'item', 'element'].find((name) => !taken.has(name)) ?? 'it_'
}

function subsetOf(items: readonly Plain[] | null, of: readonly Plain[] | null): boolean | null {
  if (items === null || of === null) return null
  let unknown = false
  for (const item of items) {
    const found = listContains(of, item)
    if (found === false) return false
    if (found === null) unknown = true
  }
  return unknown ? null : true
}

function orderCandidates(param: Param, observations: readonly Observation[]): Candidate[] {
  const pairs = observations.map((o) => [o.result as number, o.after[param.index] as number])
  if (pairs.every(([r, p]) => r === p)) return []
  const found: Candidate[] = []
  const add = (op: string, test: (r: number, p: number) => boolean) =>
    found.push(
      candidate({
        kind: 'ensures',
        template: 'order',
        subject: 'result',
        typed: true,
        reads: [param.index],
        clause: `result ${op} ${param.name}`,
        holds: (o) => {
          const r = numberOf(o.result)
          const p = numberOf(o.after[param.index]!)
          return r !== null && p !== null && test(r, p)
        },
      }),
    )
  if (pairs.every(([r, p]) => r! < p!)) add('<', (r, p) => r < p)
  else if (pairs.every(([r, p]) => r! <= p!)) add('<=', (r, p) => r <= p)
  if (pairs.every(([r, p]) => r! > p!)) add('>', (r, p) => r > p)
  else if (pairs.every(([r, p]) => r! >= p!)) add('>=', (r, p) => r >= p)
  return found
}

function lengthCandidates(param: Param, observations: readonly Observation[]): Candidate[] {
  const pairs = observations.map((o) => [
    plainLength(o.result)!,
    plainLength(o.after[param.index]!)!,
  ])
  const tests: [string, (r: number, p: number) => boolean][] = [
    ['==', (r, p) => r === p],
    ['<=', (r, p) => r <= p],
    ['>=', (r, p) => r >= p],
  ]
  const fit = tests.find(([, test]) => pairs.every(([r, p]) => test(r!, p!)))
  if (fit === undefined) return []
  const [op, test] = fit
  return [
    candidate({
      kind: 'ensures',
      template: 'length',
      subject: 'result',
      reads: [param.index],
      clause: `len(result) ${op} len(${param.name})`,
      holds: (o) => {
        const r = plainLength(o.result)
        const p = plainLength(o.after[param.index]!)
        return r !== null && p !== null && test(r, p)
      },
    }),
  ]
}

interface Image {
  readonly name: string
  /** Whether it applies to the value (in every call it must). */
  readonly applies: (value: Plain) => boolean
  readonly apply: (value: Plain) => Plain | undefined
}

const numberImage = (name: string, f: (x: number) => number): Image => ({
  name,
  applies: isNumber,
  apply: (value) => f(value as number),
})

const IMAGES: readonly Image[] = [
  { name: 'len', applies: (v) => plainLength(v) !== null, apply: (v) => plainLength(v)! },
  {
    name: 'sum',
    applies: (v) => listItems(v)?.every(isNumber) === true,
    apply: (v) => (listItems(v) as number[]).reduce((total, x) => total + x, 0),
  },
  ...(['min', 'max'] as const).map((name): Image => ({
    name,
    applies: (v) => {
      const items = listItems(v)
      return items !== null && items.length > 0 && items.every(isNumber)
    },
    apply: (v) => Math[name](...(listItems(v) as number[])),
  })),
  {
    name: 'sort',
    applies: (v) => sortableItems(v) !== null,
    apply: (v) => plainList(sortedItems(sortableItems(v)!)),
  },
  {
    name: 'reverse',
    applies: (v) => typeof v === 'string' || listItems(v) !== null,
    apply: (v) =>
      typeof v === 'string' ? [...v].reverse().join('') : plainList([...listItems(v)!].reverse()),
  },
  {
    name: 'uniq',
    applies: (v) => listItems(v) !== null,
    apply: (v) => {
      const kept = uniqueItems(listItems(v)!)
      return kept === null ? undefined : plainList(kept)
    },
  },
  ...(['upper', 'lower', 'trim'] as const).map((name): Image => ({
    name,
    applies: (v) => typeof v === 'string',
    apply: (v) => {
      const s = v as string
      return name === 'upper' ? s.toUpperCase() : name === 'lower' ? s.toLowerCase() : s.trim()
    },
  })),
  numberImage('abs', Math.abs),
  numberImage('floor', Math.floor),
  numberImage('ceil', Math.ceil),
  numberImage('round', roundHalfAway),
]

/** `result == F(p)` for builtins F that apply to the parameter in every call. */
function imageCandidates(param: Param, observations: readonly Observation[]): Candidate[] {
  const after: Get = (o) => o.after[param.index]!
  return IMAGES.filter((image) => every(observations, (o) => image.applies(after(o)))).map(
    (image) =>
      candidate({
        kind: 'ensures',
        template: 'image',
        subject: 'result',
        pins: true,
        reads: [param.index],
        clause: `result == ${image.name}(${param.name})`,
        holds: (o) => {
          const value = image.apply(after(o))
          return value === undefined ? null : plainEquals(o.result, value)
        },
      }),
  )
}

/** `result == p + q` and friends for two numeric (or two string, or two list) parameters. */
function arithmeticCandidates(
  p: Param,
  q: Param,
  observations: readonly Observation[],
): Candidate[] {
  const kinds = new Set(
    observations.flatMap((o) => [typeName(o.before[p.index]!), typeName(o.before[q.index]!)]),
  )
  const [kind] = kinds
  if (kinds.size !== 1 || (kind !== 'number' && kind !== 'string' && kind !== 'list')) return []
  const value = (o: Observation, param: Param) => o.after[param.index]!
  const join = (x: Plain, y: Plain): Plain | undefined => {
    if (typeof x === 'number' && typeof y === 'number') return x + y
    if (typeof x === 'string' && typeof y === 'string') return x + y
    const a = listItems(x)
    const b = listItems(y)
    return a === null || b === null ? undefined : plainList([...a, ...b])
  }
  const forms: [string, (o: Observation) => Plain | undefined][] = [
    [`${p.name} + ${q.name}`, (o) => join(value(o, p), value(o, q))],
    [`${q.name} + ${p.name}`, (o) => join(value(o, q), value(o, p))],
  ]
  if (kind === 'number') {
    const num = (o: Observation, param: Param) => value(o, param) as number
    forms.splice(1, 1)
    forms.push(
      [`${p.name} - ${q.name}`, (o) => num(o, p) - num(o, q)],
      [`${q.name} - ${p.name}`, (o) => num(o, q) - num(o, p)],
      [`${p.name} * ${q.name}`, (o) => num(o, p) * num(o, q)],
    )
  }
  return forms.map(([text, compute]) =>
    candidate({
      kind: 'ensures',
      template: 'arith',
      subject: 'result',
      pins: true,
      reads: [p.index, q.index],
      clause: `result == ${text}`,
      holds: (o) => {
        const expected = compute(o)
        return expected === undefined ? null : plainEquals(o.result, expected)
      },
    }),
  )
}

interface Term {
  readonly text: string
  readonly value: Num
  readonly reads: readonly number[]
  /** `len(p)` rather than `p` itself. */
  readonly length: boolean
}

/**
 * `result == a * x + b` (and `len(result) == …`) with small integers `a != 0` and `b`, found from
 * two calls with different `x` and kept only when it fits every call exactly. `x` is a numeric
 * parameter or the length of a list or string parameter.
 */
function linearCandidates(
  params: readonly Param[],
  observations: readonly Observation[],
): Candidate[] {
  const sources: Term[] = []
  for (const param of params) {
    const value = (o: Observation) => o.before[param.index]!
    if (every(observations, (o) => isNumber(value(o)))) {
      sources.push({
        text: param.name,
        value: (o) => numberOf(value(o)),
        reads: [param.index],
        length: false,
      })
    } else if (
      every(observations, (o) => plainLength(value(o)) !== null && typeName(value(o)) !== 'record')
    ) {
      sources.push({
        text: `len(${param.name})`,
        value: (o) => plainLength(value(o)),
        reads: [param.index],
        length: true,
      })
    }
  }
  const targets: Term[] = []
  if (every(observations, (o) => isNumber(o.result))) {
    targets.push({ text: 'result', value: (o) => numberOf(o.result), reads: [], length: false })
  } else if (every(observations, (o) => plainLength(o.result) !== null)) {
    targets.push({
      text: 'len(result)',
      value: (o) => plainLength(o.result),
      reads: [],
      length: true,
    })
  }
  const found: Candidate[] = []
  for (const target of targets) {
    for (const source of sources) {
      const fit = lineThrough(observations, source.value, target.value)
      if (fit === null) continue
      const [a, b] = fit
      // Identity relations belong to the equality, length and image templates.
      if (a === 1 && b === 0 && (target.length === source.length || !target.length)) continue
      found.push(
        candidate({
          kind: 'ensures',
          template: 'linear',
          subject: 'result',
          typed: true,
          pins: target.text === 'result',
          reads: source.reads,
          clause: `${target.text} == ${linearText(a, source.text, b)}`,
          holds: (o) => {
            const x = source.value(o)
            const y = target.value(o)
            return x !== null && y !== null && y === a * x + b
          },
        }),
      )
    }
  }
  return found
}

/** Small integers `[a, b]` with `y == a * x + b` through two calls with different `x`, or null. */
function lineThrough(
  observations: readonly Observation[],
  x: Num,
  y: Num,
): [number, number] | null {
  const points = observations.map((o) => [x(o), y(o)] as const)
  if (points.some(([px, py]) => px === null || py === null)) return null
  const distinct = new Set(points.map(([px]) => px))
  if (distinct.size < LINEAR_MIN_SOURCES) return null
  const [x1, y1] = points[0]!
  const second = points.find(([px]) => px !== x1)!
  const [x2, y2] = second
  const a = (y2! - y1!) / (x2! - x1!)
  const b = y1! - a * x1!
  if (!Number.isInteger(a) || !Number.isInteger(b) || a === 0) return null
  if (Math.abs(a) > LINEAR_MAX_FACTOR || Math.abs(b) > LINEAR_MAX_OFFSET) return null
  return [a, b]
}

/** `2 * n + 1`, `n - 1`, `-n`, `3 * len(xs)`. */
export function linearText(a: number, x: string, b: number): string {
  const term = a === 1 ? x : a === -1 ? `-${x}` : `${a} * ${x}`
  if (b === 0) return term
  return b > 0 ? `${term} + ${b}` : `${term} - ${-b}`
}
