/**
 * Runtime value helpers (ARCHITECTURE §6.1): classification, truthiness, equality, text
 * representations, range arithmetic and iteration. Every algorithm over user data is iterative.
 */
export {
  SIZE_LIMIT,
  MEMORY_LIMIT,
  articleType,
  isBuiltinValue,
  isCallable,
  isHeapObject,
  isList,
  isRange,
  isRecord,
  isTruthy,
  typeName,
} from './values-guards'
export { equals } from './values-equal'
export { formatNumber, preview, repr, reprKey, reprWithin, show, showWithin } from './values-show'
export { rangeAccepts, rangeContains, rangeElement, rangeLength } from './values-range'
export { collectElements, elementCount, isIterable, type IterableValue } from './values-iter'
