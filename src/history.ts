import { parseScheduleFeedbackV1 } from '@han_05/dsh-scheduling-contracts'
import type { ScheduleFeedbackV1 } from '@han_05/dsh-scheduling-contracts'
import type { RouteCatalogEntryV1, TaskTypeV1 } from './types.js'
import type { PendingSelectionV1, PerformanceHistoryOptions, TaskHistoryV1, EvidenceLevelV1 } from './types.js'

type LatencyBucket = keyof TaskHistoryV1['latencyBuckets']
type TokenBucket = keyof TaskHistoryV1['inputTokenBuckets']

interface Sample {
  readonly routeAlias: string
  readonly outcome: 'completed' | 'blocked' | 'failed' | 'budget-rejected' | 'verification-failed'
  readonly timestamp: number
  readonly configHash: string
  readonly promptProfileHash: string
  readonly explanationCode: string
  readonly latencyBucket: LatencyBucket
  readonly verified: boolean
}

interface RouteScore {
  success: number
  total: number
}

const LATENCY_BUCKETS: Record<LatencyBucket, number> = { unknown: 0, fast: 0, medium: 0, slow: 0 }
const TOKEN_BUCKETS: Record<TokenBucket, number> = { unknown: 0, small: 0, medium: 0, large: 0 }

function routeKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

function frozenBuckets<T extends Record<string, number>>(seed: T): Readonly<T> {
  return Object.freeze({ ...seed })
}

function latencyBucket(durationMs: number | undefined): LatencyBucket {
  if (durationMs === undefined) return 'unknown'
  if (durationMs <= 1_000) return 'fast'
  if (durationMs <= 10_000) return 'medium'
  return 'slow'
}

function evidenceLevel(samples: readonly Sample[]): EvidenceLevelV1 {
  return samples.every(sample => sample.verified) ? 'verified' : 'observed'
}

function combinedScore(scores: ReadonlyMap<string, RouteScore>, candidate: RouteCatalogEntryV1): RouteScore | undefined {
  const entries = [scores.get(candidate.alias), scores.get(routeKey(candidate.route.provider, candidate.route.model))].filter((score): score is RouteScore => score !== undefined)
  if (entries.length === 0) return undefined
  return entries.reduce((total, score) => ({ success: total.success + score.success, total: total.total + score.total }), { success: 0, total: 0 })
}

export class BoundedPerformanceHistory {
  private readonly windowSize: number
  private readonly pendingLimit: number
  private readonly minSamples: number
  private readonly now: () => number
  private readonly pending = new Map<string, PendingSelectionV1>()
  private readonly samples = new Map<TaskTypeV1, Sample[]>()
  private disposed = false

  constructor(options: PerformanceHistoryOptions) {
    this.windowSize = options.windowSize
    this.pendingLimit = Math.max(1, options.windowSize)
    this.minSamples = options.minSamples
    this.now = options.now ?? (() => Date.now())
  }

  private record(pending: PendingSelectionV1, feedback: ReturnType<typeof parseScheduleFeedbackV1>): void {
    const samples = this.samples.get(pending.taskType) ?? []
    samples.push({
      routeAlias: feedback.actual?.provider !== undefined && feedback.actual.model !== undefined
        ? routeKey(feedback.actual.provider, feedback.actual.model)
        : pending.routeAlias,
      outcome: feedback.outcome,
      timestamp: this.now(),
      configHash: pending.configHash,
      promptProfileHash: pending.promptProfileHash,
      explanationCode: pending.explanationCode,
      latencyBucket: latencyBucket(feedback.actual?.durationMs),
      verified: feedback.verification !== undefined && feedback.verification.length > 0 && feedback.verification.every(item => item.status === 'passed'),
    })
    if (samples.length > this.windowSize) samples.splice(0, samples.length - this.windowSize)
    this.samples.set(pending.taskType, samples)
  }

  observe(pending: PendingSelectionV1, feedbackValue: ScheduleFeedbackV1): void {
    if (this.disposed) return
    const feedback = parseScheduleFeedbackV1(feedbackValue)
    const selection = this.pending.get(feedback.requestId) ?? (pending.requestId === feedback.requestId ? pending : undefined)
    if (selection === undefined) return
    this.pending.delete(feedback.requestId)
    this.record(selection, feedback)
  }

  observeFeedback(feedbackValue: ScheduleFeedbackV1): void {
    if (this.disposed) return
    const feedback = parseScheduleFeedbackV1(feedbackValue)
    const selection = this.pending.get(feedback.requestId)
    if (selection === undefined) return
    this.pending.delete(feedback.requestId)
    this.record(selection, feedback)
  }

  remember(pending: PendingSelectionV1): void {
    if (this.disposed) return
    if (!this.pending.has(pending.requestId) && this.pending.size >= this.pendingLimit) {
      const oldest = this.pending.keys().next().value
      if (oldest !== undefined) this.pending.delete(oldest)
    }
    this.pending.set(pending.requestId, Object.freeze({ ...pending, route: Object.freeze({ ...pending.route }) }))
  }

  complete(requestId: string): void {
    this.pending.delete(requestId)
  }

  snapshot(taskType: TaskTypeV1): TaskHistoryV1 | undefined {
    if (this.disposed) return undefined
    const samples = this.samples.get(taskType)
    if (samples === undefined || samples.length === 0) return undefined
    const latency = { ...LATENCY_BUCKETS }
    const inputTokens = { ...TOKEN_BUCKETS }
    const outputTokens = { ...TOKEN_BUCKETS }
    const cacheTokens = { ...TOKEN_BUCKETS }
    for (const sample of samples) {
      latency[sample.latencyBucket]++
      inputTokens.unknown++
      outputTokens.unknown++
      cacheTokens.unknown++
    }
    const latest = samples.at(-1)!
    const snapshot: TaskHistoryV1 = {
      taskType,
      n: samples.length,
      success: samples.filter(sample => sample.outcome === 'completed').length,
      failure: samples.filter(sample => sample.outcome === 'failed' || sample.outcome === 'verification-failed').length,
      retry: samples.filter(sample => sample.explanationCode === 'TRANSIENT_FALLBACK').length,
      escalation: samples.filter(sample => sample.explanationCode === 'ADAPTIVE_ESCALATION' || sample.explanationCode === 'HANDOFF_ESCALATION').length,
      latencyBuckets: frozenBuckets(latency),
      inputTokenBuckets: frozenBuckets(inputTokens),
      outputTokenBuckets: frozenBuckets(outputTokens),
      cacheTokenBuckets: frozenBuckets(cacheTokens),
      latestTimestamp: latest.timestamp,
      configHash: latest.configHash,
      promptProfileHash: latest.promptProfileHash,
      evidenceLevel: evidenceLevel(samples),
    }
    return Object.freeze(snapshot)
  }

  hasEnoughEvidence(taskType: TaskTypeV1): boolean {
    const snapshot = this.snapshot(taskType)
    return snapshot !== undefined && snapshot.n >= this.minSamples
  }

  orderCandidates(taskType: TaskTypeV1, candidates: readonly RouteCatalogEntryV1[]): readonly RouteCatalogEntryV1[] {
    if (!this.hasEnoughEvidence(taskType) || candidates.length < 2) return Object.freeze([...candidates])
    const samples = this.samples.get(taskType) ?? []
    const scores = new Map<string, RouteScore>()
    for (const sample of samples) {
      const score = scores.get(sample.routeAlias) ?? { success: 0, total: 0 }
      score.total++
      if (sample.outcome === 'completed') score.success++
      scores.set(sample.routeAlias, score)
    }
    return Object.freeze(candidates.map((candidate, index) => ({ candidate, index })).sort((left, right) => {
      const leftScore = combinedScore(scores, left.candidate)
      const rightScore = combinedScore(scores, right.candidate)
      const leftRate = leftScore === undefined ? 0 : leftScore.success / leftScore.total
      const rightRate = rightScore === undefined ? 0 : rightScore.success / rightScore.total
      return rightRate - leftRate || left.index - right.index
    }).map(item => item.candidate))
  }

  dispose(): void {
    this.disposed = true
    this.pending.clear()
    this.samples.clear()
  }
}
