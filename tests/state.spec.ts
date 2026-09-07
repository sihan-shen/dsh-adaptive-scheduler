import { describe, expect, it } from 'vitest'
import { createAdaptiveScheduler, SchedulerStateStore } from '../src/index.ts'
import { budget, request, schedulerConfig } from './policy.spec.ts'

const signal = new AbortController().signal

describe('adaptive scheduler state', () => {
  it('reuses one session route until fixed or idle expiry', async () => {
    let now = 1000
    const scheduler = createAdaptiveScheduler(schedulerConfig, { now: () => now, generation: 'g1' })
    const first = await scheduler.schedule(request, budget, signal)
    now += 100
    const sticky = await scheduler.schedule({ ...request, objective: 'Review the change' }, budget, signal)
    expect(sticky.route).toEqual(first.route)
    expect(sticky.explanationCode).toBe('STICKY_ROUTE')
    now += schedulerConfig.idleTtlMs + 1
    await expect(scheduler.schedule({ ...request, objective: 'Review the change' }, budget, signal)).resolves.toMatchObject({ explanationCode: 'TASK_BASELINE', route: { model: 'strong-disabled' } })
  })

  it('expires a sticky route at the exact fixed TTL boundary', async () => {
    let now = 1000
    const config = { ...schedulerConfig, stickyTtlMs: 100, idleTtlMs: 1000 }
    const scheduler = createAdaptiveScheduler(config, { now: () => now, generation: 'g1' })
    await scheduler.schedule(request, budget, signal)

    now += config.stickyTtlMs
    await expect(scheduler.schedule(request, budget, signal)).resolves.toMatchObject({
      explanationCode: 'TASK_BASELINE',
      route: { model: 'baseline-disabled' },
    })
  })

  it('isolates HMR generations and freezes logical worker affinity', async () => {
    const first = createAdaptiveScheduler(schedulerConfig, { generation: 'g1' })
    const next = createAdaptiveScheduler(schedulerConfig, { generation: 'g2' })
    const a = await first.schedule({ ...request, affinity: { workerId: 'worker-1' } }, budget, signal)
    const b = await next.schedule({ ...request, affinity: { workerId: 'worker-1' } }, budget, signal)
    expect(a.affinityKey).not.toBe(b.affinityKey)
    expect(() => (a.route as { model: string }).model = 'mutated').toThrow()
  })

  it('freezes one profile per generation, task, and worker invocation', () => {
    const state = new SchedulerStateStore(schedulerConfig)
    const workerRequest = { ...request, affinity: { workerId: 'worker-1' } }
    const baseline = schedulerConfig.catalog[0]
    const fallback = schedulerConfig.catalog[1]

    const first = state.freezeAffinity(workerRequest, baseline, 'g1')
    const repeated = state.freezeAffinity(workerRequest, fallback, 'g1')
    expect(repeated).toBe(first)
    expect(repeated).toMatchObject({ requestId: request.taskId, generation: 'g1', alias: 'baseline' })
    expect(() => { (first as { alias: string }).alias = 'fallback' }).toThrow()
    expect(() => { (first?.toolFilter as string[]).push('extra-tool') }).toThrow()
    expect(state.affinityFor(workerRequest, 'g1')).toBe(first)

    const nextGeneration = state.freezeAffinity(workerRequest, fallback, 'g2')
    expect(nextGeneration).not.toBe(first)
    expect(nextGeneration).toMatchObject({ generation: 'g2', alias: 'fallback' })
    expect(state.affinityFor(workerRequest, 'g1')).toBe(first)
    expect(state.affinityFor(workerRequest, 'g2')).toBe(nextGeneration)

    const otherTask = state.freezeAffinity({ ...workerRequest, taskId: 'session-2' }, fallback, 'g1')
    expect(otherTask).not.toBe(first)
    expect(otherTask).toMatchObject({ requestId: 'session-2', alias: 'fallback' })

    state.complete(request.taskId)
    expect(state.affinityFor(workerRequest, 'g1')).toBeUndefined()
    expect(state.affinityFor({ ...workerRequest, taskId: 'session-2' }, 'g1')).toBe(otherTask)
  })

  it('cleans all invocation state through scheduler completion', async () => {
    const scheduler = createAdaptiveScheduler(schedulerConfig, { generation: 'g1' })
    const workerRequest = {
      ...request,
      profile: { ...request.profile, risk: 90 },
      affinity: { workerId: 'worker-1' },
    }
    await expect(scheduler.schedule(workerRequest, budget, signal)).resolves.toMatchObject({ route: { model: 'strong-disabled' } })
    scheduler.recordFailure({ requestId: request.taskId, code: 'TIMEOUT' })
    scheduler.complete(request.taskId)
    await expect(scheduler.schedule({
      ...request,
      affinity: { workerId: 'worker-1' },
    }, budget, signal)).resolves.toMatchObject({
      explanationCode: 'TASK_BASELINE',
      route: { model: 'baseline-disabled' },
    })
  })

  it('hydrates durable stickiness with the original event timestamp', async () => {
    let now = 1_000
    const config = { ...schedulerConfig, stickyTtlMs: 100, idleTtlMs: 100 }
    const scheduler = createAdaptiveScheduler(config, { now: () => now, generation: 'g1' })
    scheduler.hydrate(request, {
      schemaVersion: 1,
      mode: 'single-worker',
      route: schedulerConfig.catalog[1].route,
      workerCount: 1,
      source: 'scheduler',
      policyVersion: schedulerConfig.policyVersion,
    }, 950)

    await expect(scheduler.schedule(request, budget, signal)).resolves.toMatchObject({
      explanationCode: 'STICKY_ROUTE',
      route: { model: 'fallback-disabled' },
    })
    now = 1_050
    await expect(scheduler.schedule(request, budget, signal)).resolves.toMatchObject({
      explanationCode: 'TASK_BASELINE',
      route: { model: 'baseline-disabled' },
    })
  })

  it('uses the frozen worker route on repeated scheduling', async () => {
    let now = 1000
    const scheduler = createAdaptiveScheduler(schedulerConfig, { now: () => now, generation: 'g1' })
    const workerRequest = { ...request, affinity: { workerId: 'worker-1' } }
    const first = await scheduler.schedule(workerRequest, budget, signal)

    scheduler.recordFailure({ requestId: request.taskId, code: 'TIMEOUT' })
    const repeated = await scheduler.schedule(workerRequest, budget, signal)
    expect(repeated.route).toEqual(first.route)
    expect(repeated.explanationCode).toBe('STICKY_ROUTE')
  })

  it('revalidates a frozen route when a later request tightens token constraints', async () => {
    const scheduler = createAdaptiveScheduler(schedulerConfig, { generation: 'g1' })
    const highImpactRequest = {
      ...request,
      profile: { ...request.profile, risk: 90 },
      affinity: { workerId: 'worker-1' },
    } as const
    await expect(scheduler.schedule(highImpactRequest, budget, signal)).resolves.toMatchObject({
      route: { model: 'strong-disabled', maxTokens: 64000 },
    })

    const tightenedRequest = {
      ...highImpactRequest,
      profile: { ...highImpactRequest.profile, risk: 20 },
      constraints: { ...highImpactRequest.constraints, maxOutputTokens: 32000 },
    } as const
    await expect(scheduler.schedule(tightenedRequest, budget, signal)).rejects.toThrow('NO_CATALOG_ROUTE')
  })
})
