import type { AdaptiveSchedulerService, CapabilityRequestV1, RouteDecisionV1, ScheduleDecisionV1 } from '@han_05/dsh-scheduling-contracts'

export type TaskTypeV1 = 'code-fix' | 'code-new' | 'research' | 'summarize' | 'review' | 'tool-heavy' | 'unknown'
export type RouteTierV1 = 'baseline' | 'fallback' | 'strong'
export type EvidenceLevelV1 = 'observed' | 'heuristic' | 'verified'

export interface PendingSelectionV1 {
  readonly requestId: string
  readonly taskType: TaskTypeV1
  readonly routeAlias: string
  readonly route: RouteDecisionV1
  readonly explanationCode: string
  readonly configHash: string
  readonly promptProfileHash: string
}

export interface TaskHistoryV1 {
  readonly taskType: TaskTypeV1
  readonly n: number
  readonly success: number
  readonly failure: number
  readonly retry: number
  readonly escalation: number
  readonly latencyBuckets: Readonly<Record<'unknown' | 'fast' | 'medium' | 'slow', number>>
  readonly inputTokenBuckets: Readonly<Record<'unknown' | 'small' | 'medium' | 'large', number>>
  readonly outputTokenBuckets: Readonly<Record<'unknown' | 'small' | 'medium' | 'large', number>>
  readonly cacheTokenBuckets: Readonly<Record<'unknown' | 'small' | 'medium' | 'large', number>>
  readonly latestTimestamp: number
  readonly configHash: string
  readonly promptProfileHash: string
  readonly evidenceLevel: EvidenceLevelV1
}

export interface PerformanceHistoryOptions {
  readonly windowSize: number
  readonly minSamples: number
  readonly now?: () => number
}

export interface RouteCatalogEntryV1 {
  readonly alias: string
  readonly route: RouteDecisionV1
  readonly tier: RouteTierV1
  readonly taskTypes: readonly TaskTypeV1[]
  readonly toolFilter: readonly string[]
  readonly paid: boolean
  readonly reliability: number
}

export interface AdaptiveSchedulerConfig {
  readonly policyVersion: string
  readonly catalog: readonly RouteCatalogEntryV1[]
  readonly baselines: Readonly<Record<TaskTypeV1, string>>
  readonly explicitRoutes?: { readonly root?: string; readonly worker?: string }
  readonly stickyTtlMs: number
  readonly idleTtlMs: number
  readonly errorWindowMs: number
  readonly cooldownMs: number
  readonly escalationTtlMs: number
  readonly maxEscalationsPerTask: number
  readonly maxRounds: number
  readonly historyWindowSize: number
  readonly historyMinSamples: number
}

export interface SchedulerOptions {
  readonly now?: () => number
  readonly generation?: string
}

export type ProviderFailureCodeV1 = 'QUOTA' | 'RATE_LIMIT' | 'AUTH' | 'SERVER' | 'TIMEOUT' | 'TRANSPORT'

export interface ProviderFailureFactV1 {
  readonly requestId: string
  readonly code: ProviderFailureCodeV1
  readonly providerRetryAfterMs?: number
}

export interface StickyRouteStateV1 {
  readonly requestId: string
  readonly phase: 'root' | 'worker'
  readonly generation: string
  readonly alias: string
  readonly selectedAt: number
  readonly lastUsedAt: number
  readonly expiresAt: number
  readonly idleExpiresAt: number
}

export interface WorkerAffinityStateV1 {
  readonly workerId: string
  readonly requestId: string
  readonly generation: string
  readonly alias: string
  readonly toolFilter: readonly string[]
  readonly maxDepth: 1
  readonly outputSchema: 'handoff-v1'
  readonly maxTokens: number
  readonly background: false
}

export type RouteSwitchReasonV1 = 'EXPLICIT_ROUTE' | 'TRANSIENT_FALLBACK' | 'ADAPTIVE_ESCALATION' | 'HANDOFF_ESCALATION' | 'PHASE_BOUNDARY' | 'TTL_EXPIRED' | 'IDLE_EXPIRED' | 'COOLDOWN_EXPIRED'

export interface RouteSwitchRecordV1 {
  readonly requestId: string
  readonly generation: string
  readonly reason: RouteSwitchReasonV1
  readonly previousRoute?: RouteDecisionV1
  readonly nextRoute: RouteDecisionV1
  readonly at: number
}

export interface CatalogAvailabilityV1 {
  readonly quota: 'unknown'
  readonly price: 'unknown'
  readonly health: 'unknown'
}

export interface AdaptiveSchedulerRuntime extends AdaptiveSchedulerService {
  recordFailure(fact: ProviderFailureFactV1): void
  switches(): readonly RouteSwitchRecordV1[]
  hydrate(request: CapabilityRequestV1, decision: ScheduleDecisionV1, selectedAt: number): void
  complete(requestId: string): void
  disposeSession(requestId: string): void
  readonly generation: string
}
