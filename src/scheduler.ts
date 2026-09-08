import { parseBudgetViewV1, parseCapabilityRequestV1, parseScheduleDecisionV1, parseScheduleFeedbackV1 } from '@han_05/dsh-scheduling-contracts'
import type { BudgetViewV1, CapabilityRequestV1, RouteDecisionV1, ScheduleDecisionV1, ScheduleFeedbackV1 } from '@han_05/dsh-scheduling-contracts'
import { classifyTaskType, resolveCatalogCandidate, strongestAllowedAlias } from './catalog.js'
import { BoundedPerformanceHistory } from './history.js'
import { SchedulerStateStore } from './state.js'
import type { AdaptiveSchedulerConfig, AdaptiveSchedulerRuntime, PendingSelectionV1, ProviderFailureFactV1, RouteCatalogEntryV1, RouteSwitchReasonV1, SchedulerOptions, TaskTypeV1 } from './types.js'

export class SchedulingError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.name = 'SchedulingError'; this.code = code }
}

interface Selection {
  readonly candidate: RouteCatalogEntryV1
  readonly reason: string
  readonly taskType: TaskTypeV1
}

const TRANSIENT_FAILURES = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])

function stableHash(value: string): string {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function decisionFor(request: CapabilityRequestV1, config: AdaptiveSchedulerConfig, generation: string, candidate: RouteCatalogEntryV1, explanationCode: string): ScheduleDecisionV1 {
  return parseScheduleDecisionV1({
    schemaVersion: 1,
    mode: request.target === 'worker' ? 'single-worker' : 'direct',
    route: candidate.route,
    workerCount: request.target === 'worker' ? 1 : 0,
    source: 'scheduler',
    policyVersion: config.policyVersion,
    affinityKey: `${request.taskId}:${request.target}:${generation}:${candidate.alias}`,
    explanationCode,
  })
}

function baselineSelection(config: AdaptiveSchedulerConfig, request: CapabilityRequestV1): Selection {
  if (request.target === 'worker' && request.constraints.maxWorkers === 0) throw new SchedulingError('SAFETY_GATE')
  if (request.target === 'worker' && request.constraints.requiredTools.includes('delegate_worker')) throw new SchedulingError('SAFETY_GATE')
  const taskType = classifyTaskType(request)
  const explicitAlias = config.explicitRoutes?.[request.target]
  const highImpactAlias = explicitAlias === undefined && request.profile.risk >= 80 ? strongestAllowedAlias(config, request) : undefined
  const alias = explicitAlias ?? highImpactAlias ?? config.baselines[taskType]
  const candidate = resolveCatalogCandidate(config, alias, request)
  if (candidate === undefined) throw new SchedulingError('NO_CATALOG_ROUTE')
  const reason = explicitAlias !== undefined ? 'EXPLICIT_ROUTE' : highImpactAlias !== undefined ? 'HIGH_IMPACT_STRONG_ROUTE' : 'TASK_BASELINE'
  return { candidate, reason, taskType }
}

export function createAdaptiveScheduler(config: AdaptiveSchedulerConfig, options: SchedulerOptions = {}): AdaptiveSchedulerRuntime {
  const generation = options.generation ?? 'default'
  const now = options.now ?? (() => Date.now())
  const state = new SchedulerStateStore(config)
  const history = new BoundedPerformanceHistory({ windowSize: config.historyWindowSize, minSamples: config.historyMinSamples, now })
  const configHash = stableHash(JSON.stringify(config))

  function rememberSelection(request: CapabilityRequestV1, candidate: RouteCatalogEntryV1, explanationCode: string): void {
    const pending: PendingSelectionV1 = {
      requestId: request.taskId,
      taskType: classifyTaskType(request),
      routeAlias: candidate.alias,
      route: candidate.route,
      explanationCode,
      configHash,
      promptProfileHash: stableHash(candidate.route.promptProfile ?? 'default'),
    }
    history.remember(pending)
  }

  function historyCandidate(request: CapabilityRequestV1, taskType: TaskTypeV1): RouteCatalogEntryV1 | undefined {
    if (!history.hasEnoughEvidence(taskType)) return undefined
    const candidates = config.catalog.flatMap(entry => {
      const candidate = resolveCatalogCandidate(config, entry.alias, request)
      return candidate === undefined ? [] : [candidate]
    })
    return history.orderCandidates(taskType, candidates)[0]
  }

  function recordSwitch(request: CapabilityRequestV1, previous: RouteCatalogEntryV1 | undefined, next: RouteCatalogEntryV1, reason: RouteSwitchReasonV1, at: number): void {
    if (previous?.alias === next.alias) return
    state.recordSwitch({ requestId: request.taskId, generation, reason, ...(previous === undefined ? {} : { previousRoute: previous.route }), nextRoute: next.route, at })
  }

  function fallbackSelection(request: CapabilityRequestV1, timestamp: number): RouteCatalogEntryV1 | undefined {
    for (const entry of config.catalog) {
      if (entry.tier !== 'fallback') continue
      if (state.isCoolingDown(request.taskId, entry.alias, timestamp)) continue
      const candidate = resolveCatalogCandidate(config, entry.alias, request)
      if (candidate !== undefined) return candidate
    }
    return undefined
  }

  function matchingHydrationCandidate(request: CapabilityRequestV1, route: RouteDecisionV1): RouteCatalogEntryV1 | undefined {
    const entry = config.catalog.find(candidate =>
      candidate.route.provider === route.provider
      && candidate.route.model === route.model
      && candidate.route.reasoningEffort === route.reasoningEffort
      && candidate.route.promptProfile === route.promptProfile
      && candidate.route.modelFamily === route.modelFamily
      && route.maxTokens <= candidate.route.maxTokens,
    )
    return entry === undefined
      ? undefined
      : resolveCatalogCandidate(config, entry.alias, request, { route, toolFilter: entry.toolFilter })
  }

  function cooldownAlternative(request: CapabilityRequestV1, current: RouteCatalogEntryV1, timestamp: number): RouteCatalogEntryV1 | undefined {
    const tierOrder = current.tier === 'baseline'
      ? ['fallback', 'strong'] as const
      : current.tier === 'fallback'
        ? ['strong', 'baseline'] as const
        : ['fallback', 'baseline'] as const
    for (const tier of tierOrder) {
      let best: RouteCatalogEntryV1 | undefined
      for (const entry of config.catalog) {
        if (entry.tier !== tier || state.isCoolingDown(request.taskId, entry.alias, timestamp)) continue
        const candidate = resolveCatalogCandidate(config, entry.alias, request)
        if (candidate !== undefined && (best === undefined || candidate.reliability > best.reliability)) best = candidate
      }
      if (best !== undefined) return best
    }
    return undefined
  }

  return {
    generation,
    recordFailure(fact: ProviderFailureFactV1): void {
      state.recordFailure(fact, now())
    },
    switches() {
      return state.switches()
    },
    hydrate(requestValue: CapabilityRequestV1, decisionValue: ScheduleDecisionV1, selectedAt: number): void {
      const request = parseCapabilityRequestV1(requestValue)
      const decision = parseScheduleDecisionV1(decisionValue)
      if (!Number.isSafeInteger(selectedAt) || selectedAt < 0) throw new TypeError('selectedAt must be a non-negative safe integer')
      const expectedMode = request.target === 'worker' ? 'single-worker' : 'direct'
      const expectedWorkers = request.target === 'worker' ? 1 : 0
      if (decision.mode !== expectedMode || decision.workerCount !== expectedWorkers) throw new TypeError('hydrated decision target shape is invalid')
      const candidate = matchingHydrationCandidate(request, decision.route)
      if (candidate !== undefined) state.hydrateSticky(request, candidate.alias, selectedAt, generation)
    },
    observe(feedbackValue: ScheduleFeedbackV1): void {
      const feedback = parseScheduleFeedbackV1(feedbackValue)
      history.observeFeedback(feedback)
    },
    async schedule(requestValue: CapabilityRequestV1, budgetValue: BudgetViewV1, signal: AbortSignal): Promise<ScheduleDecisionV1> {
      const request = parseCapabilityRequestV1(requestValue)
      const budget = parseBudgetViewV1(budgetValue)
      if (signal.aborted) throw signal.reason ?? new DOMException('Scheduling cancelled', 'AbortError')
      if (request.target === 'worker' && budget.remainingWorkers < 1) throw new SchedulingError('LOCAL_WORKER_BUDGET')
      if (budget.remainingPluginToolActions < 1) throw new SchedulingError('LOCAL_TOOL_BUDGET')
      const timestamp = now()
      const selected = baselineSelection(config, request)
      const failures = state.failuresFor(request.taskId, timestamp)
      if (failures.some(failure => failure.code === 'QUOTA')) throw new SchedulingError('QUOTA_EXHAUSTED')
      if (failures.some(failure => failure.code === 'AUTH')) throw new SchedulingError('NON_TRANSIENT_FAILURE')
      if (failures.length > config.maxRounds) throw new SchedulingError('ESCALATION_ROUNDS_EXHAUSTED')

      const explicitRoute = config.explicitRoutes?.[request.target] !== undefined
      const highImpactRoute = !explicitRoute && request.profile.risk >= 80
      const handoffEscalation = !explicitRoute && !highImpactRoute && (request.priorHandoff?.status === 'failed' || request.priorHandoff?.status === 'blocked')
      const previousSticky = state.peekSticky(request, generation)
      const previousEscalation = state.peekEscalation(request.taskId)
      const escalation = state.escalation(request.taskId, timestamp)
      const escalationExpired = previousEscalation !== undefined && escalation === undefined
      if (escalationExpired) state.clearSticky(request)
      const sticky = state.takeSticky(request, timestamp, generation)

      let candidate = selected.candidate
      let reason = selected.reason
      let switchReason: RouteSwitchReasonV1 | undefined
      let previousCandidate: RouteCatalogEntryV1 | undefined = previousSticky === undefined ? undefined : resolveCatalogCandidate(config, previousSticky.alias, request)
      if (escalationExpired) switchReason = 'TTL_EXPIRED'
      else if (previousSticky !== undefined && sticky === undefined) switchReason = timestamp >= previousSticky.expiresAt ? 'TTL_EXPIRED' : 'IDLE_EXPIRED'

      if (explicitRoute || highImpactRoute) {
        previousCandidate = sticky === undefined ? previousCandidate : resolveCatalogCandidate(config, sticky.alias, request)
        switchReason = explicitRoute ? 'EXPLICIT_ROUTE' : 'PHASE_BOUNDARY'
      } else if (handoffEscalation) {
        const strongAlias = strongestAllowedAlias(config, request)
        const strong = resolveCatalogCandidate(config, strongAlias, request)
        if (strong !== undefined) {
          candidate = strong
          reason = 'HANDOFF_ESCALATION'
          previousCandidate = sticky === undefined ? previousCandidate : resolveCatalogCandidate(config, sticky.alias, request)
          switchReason = 'HANDOFF_ESCALATION'
        }
      } else if (escalation !== undefined) {
        const escalated = strongestAllowedAlias(config, request)
        const escalatedCandidate = resolveCatalogCandidate(config, escalated, request)
        if (escalatedCandidate !== undefined) {
          candidate = escalatedCandidate
          reason = sticky?.alias === candidate.alias ? 'STICKY_ROUTE' : 'ADAPTIVE_ESCALATION'
          previousCandidate = sticky === undefined ? previousCandidate : resolveCatalogCandidate(config, sticky.alias, request)
          switchReason = 'ADAPTIVE_ESCALATION'
        }
      } else if (sticky !== undefined && sticky.alias !== selected.candidate.alias && state.consumeExpiredCooldown(request.taskId, selected.candidate.alias, timestamp)) {
        previousCandidate = resolveCatalogCandidate(config, sticky.alias, request)
        candidate = selected.candidate
        reason = selected.reason
        switchReason = 'COOLDOWN_EXPIRED'
      } else if (sticky !== undefined) {
        previousCandidate = resolveCatalogCandidate(config, sticky.alias, request)
        if (previousCandidate !== undefined) {
          candidate = previousCandidate
          reason = 'STICKY_ROUTE'
          if (state.isCoolingDown(request.taskId, previousCandidate.alias, timestamp) && previousCandidate.tier === 'baseline') {
            const fallback = fallbackSelection(request, timestamp)
            if (fallback !== undefined) {
              candidate = fallback
              reason = 'TRANSIENT_FALLBACK'
              switchReason = 'TRANSIENT_FALLBACK'
            } else {
              const strongAlias = strongestAllowedAlias(config, request)
              const strong = resolveCatalogCandidate(config, strongAlias, request)
              if (strong !== undefined) {
                candidate = strong
                reason = 'ADAPTIVE_ESCALATION'
                switchReason = 'ADAPTIVE_ESCALATION'
              }
            }
          } else if (state.isCoolingDown(request.taskId, previousCandidate.alias, timestamp) && previousCandidate.tier === 'fallback') {
            if ((state.escalation(request.taskId, timestamp)?.count ?? 0) >= config.maxEscalationsPerTask) throw new SchedulingError('ESCALATION_ROUNDS_EXHAUSTED')
            const strongAlias = strongestAllowedAlias(config, request)
            const strong = resolveCatalogCandidate(config, strongAlias, request)
            if (strong !== undefined) {
              candidate = strong
              reason = 'ADAPTIVE_ESCALATION'
              switchReason = 'ADAPTIVE_ESCALATION'
            }
          }
        }
      } else {
        const historicalCandidate = historyCandidate(request, selected.taskType)
        if (historicalCandidate !== undefined && historicalCandidate.alias !== selected.candidate.alias) {
          candidate = historicalCandidate
          reason = 'HISTORY_ORDERED_CANDIDATE'
        }
      }

      if (!handoffEscalation && TRANSIENT_FAILURES.has(failures.at(-1)?.code ?? '') && sticky === undefined) {
        candidate = selected.candidate
        reason = selected.reason
      }

      if (state.isCoolingDown(request.taskId, candidate.alias, timestamp)) {
        const cooled = candidate
        const alternate = cooldownAlternative(request, cooled, timestamp)
        if (alternate === undefined) throw new SchedulingError('NO_CATALOG_ROUTE')
        previousCandidate ??= cooled
        candidate = alternate
        reason = alternate.tier === 'strong' ? 'ADAPTIVE_ESCALATION' : 'TRANSIENT_FALLBACK'
        switchReason = alternate.tier === 'strong' ? 'ADAPTIVE_ESCALATION' : 'TRANSIENT_FALLBACK'
      }

      const frozenAffinity = state.affinityFor(request, generation)
      if (frozenAffinity !== undefined) {
        const frozenRoute = state.affinityRouteFor(request, generation)
        if (frozenRoute === undefined) throw new SchedulingError('NO_CATALOG_ROUTE')
        const frozenCandidate = resolveCatalogCandidate(config, frozenAffinity.alias, request, { route: frozenRoute, toolFilter: frozenAffinity.toolFilter })
        if (frozenCandidate === undefined) throw new SchedulingError('NO_CATALOG_ROUTE')
        candidate = frozenCandidate
        reason = 'STICKY_ROUTE'
        switchReason = undefined
      }

      if (candidate !== selected.candidate && switchReason === undefined && reason !== 'HISTORY_ORDERED_CANDIDATE') switchReason = 'TTL_EXPIRED'
      if (switchReason !== undefined) recordSwitch(request, previousCandidate, candidate, switchReason, timestamp)
      if (reason === 'ADAPTIVE_ESCALATION') state.markEscalation(request.taskId, timestamp)
      if (sticky === undefined || sticky.alias !== candidate.alias) state.rememberSticky(request, candidate.alias, timestamp, generation)
      state.freezeAffinity(request, candidate, generation)
      rememberSelection(request, candidate, reason)
      const decision = decisionFor(request, config, generation, candidate, reason)
      return decision
    },
    complete(requestId: string): void {
      state.complete(requestId)
      history.complete(requestId)
    },
    disposeSession(requestId: string): void {
      state.complete(requestId)
      history.complete(requestId)
    },
    async dispose(): Promise<void> {
      history.dispose()
      state.dispose()
    },
  }
}
