import type { FunctionProto } from '../bytecode'
import type { Diagnostic } from '../diagnostics'
import { InternalError } from '../diagnostics'
import { LineIndex } from '../span'
import type { Span } from '../span'

export type CompileMode = 'main' | 'library'

/** The first top-level declaration of a global (SPEC §5.4). */
export interface GlobalDecl {
  readonly name: string
  readonly kind: 'let' | 'var' | 'fn'
  readonly mutable: boolean
  /** The binding name in the first declaration. */
  readonly declSpan: Span
  /** End offset of the first declaring statement (for E026, SPEC §5.3). */
  readonly declEnd: number
}

/** State shared by every function of one compilation. */
export class CompileContext {
  readonly diagnostics: Diagnostic[] = []
  readonly lineIndex: LineIndex
  /** First declarations in declaration order (empty in library mode). */
  readonly globals = new Map<string, GlobalDecl>()
  private readonly protoSlots: (FunctionProto | null)[] = []

  constructor(
    readonly source: string,
    readonly mode: CompileMode,
    readonly firstProtoId: number,
  ) {
    this.lineIndex = new LineIndex(source)
  }

  report(diagnostic: Diagnostic): void {
    this.diagnostics.push(diagnostic)
  }

  /** Protos are numbered in creation order, so the id is reserved when compilation starts. */
  reserveProtoId(): number {
    this.protoSlots.push(null)
    return this.firstProtoId + this.protoSlots.length - 1
  }

  storeProto(proto: FunctionProto): void {
    this.protoSlots[proto.id - this.firstProtoId] = proto
  }

  protos(): FunctionProto[] {
    return this.protoSlots.map((proto, i) => {
      if (proto === null) throw new InternalError(`proto ${this.firstProtoId + i} never finished`)
      return proto
    })
  }
}
