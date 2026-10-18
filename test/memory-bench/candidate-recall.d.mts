// 类型声明：bench-adapter.ts 以 TS 导入 candidate-recall.mjs。

export interface CandidateSourceMeta {
  diaId?: string
  sessionId?: string
}

export interface CandidateItem {
  draft?: { sourceIds?: readonly string[] }
}

export function candidateDiaIds(
  candidateIds: readonly string[],
  context: {
    sourceMeta: ReadonlyMap<string, CandidateSourceMeta>
    itemById: ReadonlyMap<string, CandidateItem>
  },
): string[]
