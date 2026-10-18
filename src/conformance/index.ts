/** The conformance corpus annotation parser and checker (docs/ARCHITECTURE.md §10.2). */
export {
  parseAnnotation,
  parseAnnotations,
  splitAnnotations,
  type Annotation,
  type ErrorAnnotation,
  type MalformedAnnotation,
  type OutputAnnotation,
} from './annotations'
export {
  CONFORMANCE_MAX_STEPS,
  CONFORMANCE_SEED,
  checkSource,
  outputLines,
  type CheckResult,
  type ConformanceApi,
  type RecordingSummary,
} from './check'
export { compareRunWithRecording } from './compare-recording'
export { describeReported, matchesAnnotation, type ReportedError } from './reported'
