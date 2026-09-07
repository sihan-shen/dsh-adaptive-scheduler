import type { CapabilityRequestV1, RouteDecisionV1 } from '@ds-plugins/dsh-scheduling-contracts'
import type { AdaptiveSchedulerConfig, ProviderFailureFactV1, RouteSwitchRecordV1, StickyRouteStateV1, WorkerAffinityStateV1, RouteCatalogEntryV1 } from './types.js'
import { MAX_COOLDOWN_MS } from './config.js'

interface FailureRecordV1 extends ProviderFailureFactV1 {
  readonly at: number
}

interface EscalationStateV1 {
  readonly count: number
  readonly expiresAt: number
}

function requestKey(request: Pick<CapabilityRequestV1, 'taskId' | 'target'>): string {
  return `${request.taskId}:${request.target}`
}

function affinityKey(request: CapabilityRequestV1, generation: string): string | undefined {
  const workerId = request.affinity?.workerId
  if (request.target !== 'worker' || workerId === undefined) return undefined
  return JSON.stringify([generation, request.taskId, workerId])
}

function freezeRoute(route: RouteDecisionV1): RouteDecisionV1 {
  return Object.freeze({ ...route })
}

export class SchedulerStateStore {
  private readonly sticky = new Map<string, StickyRouteStateV1>()
  private readonly affinity = new Map<string, WorkerAffinityStateV1>()
  private readonly affinityRoutes = new Map<string, RouteDecisionV1>()
  private readonly failures = new Map<string, readonly FailureRecordV1[]>()
  private readonly escalations = new Map<string, EscalationStateV1>()
  private readonly cooldowns = new Map<string, number>()
  private readonly routeSwitches: RouteSwitchRecordV1[] = []

  constructor(private readonly config: AdaptiveSchedulerConfig) {}

  peekSticky(request: CapabilityRequestV1, generation: string): StickyRouteStateV1 | undefined {
    const state = this.sticky.get(requestKey(request))
    return state?.generation === generation ? state : undefined
  }

  takeSticky(request: CapabilityRequestV1, now: number, generation: string): StickyRouteStateV1 | undefined {
    const key = requestKey(request)
    const state = this.sticky.get(key)
    if (state === undefined || state.generation !== generation || now >= state.expiresAt || now >= state.idleExpiresAt) {
      this.sticky.delete(key)
      return undefined
    }
    const refreshed = Object.freeze({ ...state, lastUsedAt: now, idleExpiresAt: now + this.config.idleTtlMs })
    this.sticky.set(key, refreshed)
    return refreshed
  }

  rememberSticky(request: CapabilityRequestV1, alias: string, now: number, generation: string): StickyRouteStateV1 {
    const key = requestKey(request)
    const state = Object.freeze({
      requestId: request.taskId,
      phase: request.target,
      generation,
      alias,
      selectedAt: now,
      lastUsedAt: now,
      expiresAt: now + this.config.stickyTtlMs,
      idleExpiresAt: now + this.config.idleTtlMs,
    })
    this.sticky.set(key, state)
    return state
  }

  hydrateSticky(request: CapabilityRequestV1, alias: string, selectedAt: number, generation: string): StickyRouteStateV1 {
    return this.rememberSticky(request, alias, selectedAt, generation)
  }

  clearSticky(request: Pick<CapabilityRequestV1, 'taskId' | 'target'>): void {
    const key = requestKey(request)
    this.sticky.delete(key)
  }

  failuresFor(requestId: string, now: number): readonly FailureRecordV1[] {
    const active = (this.failures.get(requestId) ?? []).filter(failure => now - failure.at <= this.config.errorWindowMs)
    this.failures.set(requestId, active)
    return active
  }

  recordFailure(fact: ProviderFailureFactV1, now: number): void {
    const retryAfter = typeof fact.providerRetryAfterMs === 'number' && Number.isSafeInteger(fact.providerRetryAfterMs) && fact.providerRetryAfterMs >= 0
      ? Math.min(fact.providerRetryAfterMs, MAX_COOLDOWN_MS)
      : 0
    const normalizedFact = Object.freeze({
      requestId: fact.requestId,
      code: fact.code,
      ...(retryAfter === 0 ? {} : { providerRetryAfterMs: retryAfter }),
      at: now,
    })
    const records = [...(this.failures.get(fact.requestId) ?? []), normalizedFact]
    const bounded = records.slice(-this.config.historyWindowSize)
    this.failures.set(fact.requestId, Object.freeze(bounded))
    const cooldownUntil = now + Math.max(this.config.cooldownMs, retryAfter)
    for (const sticky of this.sticky.values()) {
      if (sticky.requestId === fact.requestId) this.cooldowns.set(`${fact.requestId}\u0000${sticky.alias}`, cooldownUntil)
    }
  }

  isCoolingDown(requestId: string, alias: string, now: number): boolean {
    const key = `${requestId}\u0000${alias}`
    const until = this.cooldowns.get(key)
    return until !== undefined && now < until
  }

  consumeExpiredCooldown(requestId: string, alias: string, now: number): boolean {
    const key = `${requestId}\u0000${alias}`
    const until = this.cooldowns.get(key)
    if (until === undefined || now < until) return false
    this.cooldowns.delete(key)
    return true
  }

  escalation(requestId: string, now: number): EscalationStateV1 | undefined {
    const state = this.escalations.get(requestId)
    if (state === undefined) return undefined
    if (now >= state.expiresAt) {
      this.escalations.delete(requestId)
      return undefined
    }
    return state
  }

  peekEscalation(requestId: string): EscalationStateV1 | undefined {
    return this.escalations.get(requestId)
  }

  markEscalation(requestId: string, now: number): EscalationStateV1 {
    const previous = this.escalations.get(requestId)
    const state = Object.freeze({ count: (previous?.count ?? 0) + 1, expiresAt: now + this.config.escalationTtlMs })
    this.escalations.set(requestId, state)
    return state
  }

  clearEscalation(request: Pick<CapabilityRequestV1, 'taskId' | 'target'>): void {
    this.escalations.delete(request.taskId)
    this.clearSticky(request)
    this.failures.delete(request.taskId)
  }

  freezeAffinity(request: CapabilityRequestV1, candidate: RouteCatalogEntryV1, generation: string): WorkerAffinityStateV1 | undefined {
    const workerId = request.affinity?.workerId
    if (request.target !== 'worker' || workerId === undefined) return undefined
    const key = affinityKey(request, generation)
    if (key === undefined) return undefined
    const existing = this.affinity.get(key)
    if (existing !== undefined) return existing
    const state = Object.freeze({
      workerId,
      requestId: request.taskId,
      generation,
      alias: candidate.alias,
      toolFilter: Object.freeze([...candidate.toolFilter]),
      maxDepth: 1 as const,
      outputSchema: 'handoff-v1' as const,
      maxTokens: candidate.route.maxTokens,
      background: false as const,
    })
    this.affinity.set(key, state)
    this.affinityRoutes.set(key, freezeRoute(candidate.route))
    return state
  }

  affinityFor(request: CapabilityRequestV1, generation: string): WorkerAffinityStateV1 | undefined {
    const key = affinityKey(request, generation)
    if (key === undefined) return undefined
    const state = this.affinity.get(key)
    return state?.generation === generation ? state : undefined
  }

  affinityRouteFor(request: CapabilityRequestV1, generation: string): RouteDecisionV1 | undefined {
    const key = affinityKey(request, generation)
    if (key === undefined) return undefined
    return this.affinityRoutes.get(key)
  }

  complete(requestId: string): void {
    for (const [key, sticky] of this.sticky) {
      if (sticky.requestId !== requestId) continue
      this.sticky.delete(key)
    }
    for (const [key, state] of this.affinity) {
      if (state.requestId !== requestId) continue
      this.affinity.delete(key)
      this.affinityRoutes.delete(key)
    }
    this.failures.delete(requestId)
    this.escalations.delete(requestId)
    for (const key of this.cooldowns.keys()) if (key.startsWith(`${requestId}\u0000`)) this.cooldowns.delete(key)
  }

  dispose(): void {
    this.sticky.clear()
    this.affinity.clear()
    this.affinityRoutes.clear()
    this.failures.clear()
    this.escalations.clear()
    this.cooldowns.clear()
    this.routeSwitches.length = 0
  }

  recordSwitch(record: RouteSwitchRecordV1): void {
    const frozen = Object.freeze({
      ...record,
      ...(record.previousRoute === undefined ? {} : { previousRoute: freezeRoute(record.previousRoute) }),
      nextRoute: freezeRoute(record.nextRoute),
    })
    this.routeSwitches.push(frozen)
    if (this.routeSwitches.length > 64) this.routeSwitches.shift()
  }

  switches(): readonly RouteSwitchRecordV1[] {
    return Object.freeze([...this.routeSwitches])
  }
}
