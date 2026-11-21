/**
 * Function contracts at run time (SPEC §7.16): `Check k` pops a clause's value and raises R026
 * (`requires`) or R027 (`ensures`) when it is falsy. A failed precondition blames the caller, so
 * its hint names the arguments; a failed postcondition blames the function, so its hint gives the
 * value it returned.
 */
import type { ContractConst } from './bytecode'
import type { Frame, Value } from './runtime-types'
import { isTruthy, preview } from './values'
import { raise } from './vm-errors'
import type { MachineState } from './vm-state'

/** Reprs in contract hints are cut like those of R014/R015 (SPEC §11). */
const HINT_REPR_LENGTH = 60

/** `Check`: `( v -- )`; raises when `v` is falsy. */
export function checkContract(m: MachineState, frame: Frame, contract: ContractConst): void {
  const value = m.stack.pop() as Value
  if (isTruthy(value)) return
  if (contract.kind === 'requires') {
    raise('R026', `precondition failed: ${contract.text}`, argumentsHint(m, frame, contract))
  }
  // The clauses of a return run with the returned value just below them (bound to `result`).
  const result = m.stack[m.stack.length - 1] as Value
  const name = contract.fn === 'lambda' ? 'lambda' : `'${contract.fn}'`
  raise(
    'R027',
    `postcondition failed: ${contract.text}`,
    `${name} returned ${preview(result, HINT_REPR_LENGTH)}`,
  )
}

/** `the caller passed xs = [], n = 3`: the parameters keep the arguments (they are immutable). */
function argumentsHint(m: MachineState, frame: Frame, contract: ContractConst): string {
  if (contract.params.length === 0) return 'the caller passed no arguments'
  const parts = contract.params.map((param, i) => {
    const value = m.stack[frame.base + 1 + i] as Value
    return `${param} = ${preview(value, HINT_REPR_LENGTH)}`
  })
  return `the caller passed ${parts.join(', ')}`
}
