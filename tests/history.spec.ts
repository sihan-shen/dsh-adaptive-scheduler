import { describe, expect, it } from 'vitest'
import { BoundedPerformanceHistory, createAdaptiveScheduler } from '../src/index.ts'
import { budget, request, schedulerConfig } from './policy.spec.ts'

const pendingCodeFix = {
  requestId: 'session-1',
  taskType: 'code-fix',
  routeAlias: 'baseline',
  route: { provider: 'provider-disabled', model: 'baseline-disabled', maxTokens: 32000 },
  explanationCode: 'TASK_BASELINE',
  configHash: 'config-hash',
  promptProfileHash: 'prompt-hash',
} as const

const pendingReview = {
  ...pendingCodeFix,
  requestId: 'session-2',
  taskType: 'review',
  routeAlias: 'strong',
  route: { provider: 'provider-disabled', model: 'strong-disabled', maxTokens: 64000, reasoningEffort: 'high' },
} as const

const signal = new AbortController().signal

describe('bounded performance history', () => {
  it('rotates a fixed window and never invents token measurements', () => {
    let now = 1000
    const history = new BoundedPerformanceHistory({ windowSize: 3, minSamples: 2, now: () => now++ })
    for (const outcome of ['failed', 'completed', 'completed', 'completed'] as const) {
      history.observe(pendingCodeFix, { schemaVersion: 1, requestId: 'session-1', outcome, actual: { durationMs: 25 } })
    }
    expect(history.snapshot('code-fix')).toMatchObject({
      n: 3,
      success: 3,
      failure: 0,
      evidenceLevel: 'observed',
      inputTokenBuckets: { unknown: 3, small: 0, medium: 0, large: 0 },
      outputTokenBuckets: { unknown: 3, small: 0, medium: 0, large: 0 },
      cacheTokenBuckets: { unknown: 3, small: 0, medium: 0, large: 0 },
    })
  })

  it('marks passing verification as verified and sparse history as non-authoritative', () => {
    const history = new BoundedPerformanceHistory({ windowSize: 8, minSamples: 3, now: () => 1000 })
    history.observe(pendingReview, {
      schemaVersion: 1,
      requestId: 'session-2',
      outcome: 'completed',
      verification: [{ schemaVersion: 1, commandName: 'typecheck', args: [], exitCode: 0, status: 'passed', stdout: '', stderr: '', truncated: false, durationMs: 2 }],
    })
    expect(history.snapshot('review')).toMatchObject({ n: 1, evidenceLevel: 'verified' })
    expect(history.hasEnoughEvidence('review')).toBe(false)
  })

  it('uses the weakest provenance level for a mixed verification window', () => {
    const history = new BoundedPerformanceHistory({ windowSize: 8, minSamples: 1, now: () => 1000 })
    history.observe(pendingReview, {
      schemaVersion: 1,
      requestId: 'session-2',
      outcome: 'completed',
      verification: [{ schemaVersion: 1, commandName: 'typecheck', args: [], exitCode: 0, status: 'passed', stdout: '', stderr: '', truncated: false, durationMs: 2 }],
    })
    history.observe({ ...pendingReview, requestId: 'session-3' }, {
      schemaVersion: 1,
      requestId: 'session-3',
      outcome: 'failed',
    })

    expect(history.snapshot('review')).toMatchObject({ n: 2, evidenceLevel: 'observed' })
  })

  it('reorders only catalog candidates after enough evidence', async () => {
    const scheduler = createAdaptiveScheduler(schedulerConfig, { generation: 'g1' })
    for (let index = 0; index < 3; index++) {
      await scheduler.schedule({ ...request, taskId: `failed-${index}` }, budget, signal)
      scheduler.observe?.({ schemaVersion: 1, requestId: `failed-${index}`, outcome: 'failed' })
      await scheduler.schedule({ ...request, taskId: `passed-${index}` }, budget, signal)
      scheduler.observe?.({ schemaVersion: 1, requestId: `passed-${index}`, outcome: 'completed', actual: { provider: 'provider-disabled', model: 'fallback-disabled', durationMs: 25 } })
    }
    await expect(scheduler.schedule({ ...request, taskId: 'history-choice' }, budget, signal)).resolves.toMatchObject({ route: { model: 'fallback-disabled' }, explanationCode: 'HISTORY_ORDERED_CANDIDATE' })
    const explicit = createAdaptiveScheduler({ ...schedulerConfig, explicitRoutes: { worker: 'strong' } }, { generation: 'g2' })
    await expect(explicit.schedule({ ...request, taskId: 'explicit-choice' }, budget, signal)).resolves.toMatchObject({ route: { model: 'strong-disabled' }, explanationCode: 'EXPLICIT_ROUTE' })
  })

  it('returns detached snapshots and preserves candidate order on ties', () => {
    const history = new BoundedPerformanceHistory({ windowSize: 4, minSamples: 1, now: () => 1000 })
    history.observe(pendingCodeFix, { schemaVersion: 1, requestId: 'session-1', outcome: 'completed' })
    const candidates = schedulerConfig.catalog.slice(0, 2)
    const ordered = history.orderCandidates('code-fix', candidates)
    expect(ordered.map(candidate => candidate.alias)).toEqual(['baseline', 'fallback'])
    expect(Object.isFrozen(history.snapshot('code-fix'))).toBe(true)
  })

  it('discards the oldest pending selection at the bounded global limit', () => {
    const history = new BoundedPerformanceHistory({ windowSize: 2, minSamples: 1, now: () => 1000 })
    const first = { ...pendingCodeFix, requestId: 'pending-1' }
    const second = { ...pendingCodeFix, requestId: 'pending-2' }
    const third = { ...pendingCodeFix, requestId: 'pending-3' }

    history.remember(first)
    history.remember(second)
    history.remember(third)
    history.observeFeedback({ schemaVersion: 1, requestId: 'pending-1', outcome: 'completed' })
    expect(history.snapshot('code-fix')).toBeUndefined()

    history.observeFeedback({ schemaVersion: 1, requestId: 'pending-3', outcome: 'completed' })
    expect(history.snapshot('code-fix')).toMatchObject({ n: 1, success: 1 })
  })
})
