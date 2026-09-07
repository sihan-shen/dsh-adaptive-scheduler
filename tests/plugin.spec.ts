import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, createAdaptiveScheduler, inject, name, provide } from '../src/index.ts'
import { budget, request, schedulerConfig } from './policy.spec.ts'

describe('adaptive scheduler Cordis plugin', () => {
  it('exports stable lifecycle metadata and an apply entry', () => {
    expect(name).toBe('dsh-adaptive-scheduler')
    expect(provide).toEqual(['adaptiveScheduler'])
    expect(inject).toEqual([])
    expect(apply).toEqual(expect.any(Function))
  })

  it('provides one bounded service and disposes its generation', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(apply, schedulerConfig)
    const service = ctx.get('adaptiveScheduler')
    expect(service).toMatchObject({
      schedule: expect.any(Function),
      hydrate: expect.any(Function),
      observe: expect.any(Function),
      complete: expect.any(Function),
      disposeSession: expect.any(Function),
    })
    await fiber.dispose()
    expect(ctx.get('adaptiveScheduler')).toBeUndefined()
  })

  it('records dispatched request failures and stops recording after teardown', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(apply, schedulerConfig)
    const service = ctx.get('adaptiveScheduler')!
    const dispatchFailure = (requestId: string) => ctx.events.waterfall('agent/request-error', {
      agent: { session: { id: requestId, header: {} } },
      failure: { code: 'QUOTA' },
    }, async () => undefined)

    await dispatchFailure('event-before-dispose')
    await expect(service.schedule({ ...request, taskId: 'event-before-dispose' }, budget, new AbortController().signal)).rejects.toThrow('QUOTA_EXHAUSTED')

    await fiber.dispose()
    await dispatchFailure('event-after-dispose')
    await expect(service.schedule({ ...request, taskId: 'event-after-dispose' }, budget, new AbortController().signal)).resolves.toMatchObject({ explanationCode: 'TASK_BASELINE' })
  })

  it('clears session state on disposal so a reused id starts clean', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(apply, schedulerConfig)
    const service = ctx.get('adaptiveScheduler')!
    const taskId = 'reused-session-id'
    await expect(service.schedule({
      ...request,
      taskId,
      profile: { ...request.profile, risk: 90 },
      affinity: { workerId: `${taskId}:worker:1` },
    }, budget, new AbortController().signal)).resolves.toMatchObject({ route: { model: 'strong-disabled' } })

    ctx.emit('session/disposed' as never, { id: taskId, header: {} } as never)

    await expect(service.schedule({
      ...request,
      taskId,
      affinity: { workerId: `${taskId}:worker:1` },
    }, budget, new AbortController().signal)).resolves.toMatchObject({
      explanationCode: 'TASK_BASELINE',
      route: { model: 'baseline-disabled' },
    })
    await fiber.dispose()
  })

  it('does not clear root scheduling state when a child worker session is disposed', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(apply, schedulerConfig)
    const service = ctx.get('adaptiveScheduler')!
    const taskId = 'live-root-with-disposed-child'
    const rootRequest = {
      ...request,
      target: 'root' as const,
      taskId,
      constraints: { ...request.constraints, maxWorkers: 0 as const },
    }
    await service.schedule(rootRequest, budget, new AbortController().signal)
    service.recordFailure({ requestId: taskId, code: 'TIMEOUT' })
    await expect(service.schedule(rootRequest, budget, new AbortController().signal)).resolves.toMatchObject({
      route: { model: 'fallback-disabled' },
    })

    ctx.emit('session/disposed' as never, {
      id: 'disposed-child',
      header: { parentSession: taskId },
    } as never)

    await expect(service.schedule(rootRequest, budget, new AbortController().signal)).resolves.toMatchObject({
      explanationCode: 'STICKY_ROUTE',
      route: { model: 'fallback-disabled' },
    })
    await fiber.dispose()
  })

  it('does not attribute a child worker request failure to its live root session', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(apply, schedulerConfig)
    const service = ctx.get('adaptiveScheduler')!
    const taskId = 'root-with-child-failure'
    const rootRequest = {
      ...request,
      target: 'root' as const,
      taskId,
      constraints: { ...request.constraints, maxWorkers: 0 as const },
    }
    await service.schedule(rootRequest, budget, new AbortController().signal)

    await ctx.events.waterfall('agent/request-error', {
      agent: { session: { id: 'failed-child', header: { parentSession: taskId } } },
      failure: { code: 'TIMEOUT' },
    } as never, async () => undefined)

    await expect(service.schedule(rootRequest, budget, new AbortController().signal)).resolves.toMatchObject({
      explanationCode: 'STICKY_ROUTE',
      route: { model: 'baseline-disabled' },
    })
    await fiber.dispose()
  })

  it('clears the entire state store when the runtime is disposed', async () => {
    const scheduler = createAdaptiveScheduler(schedulerConfig, { generation: 'g1' })
    const taskId = 'runtime-dispose'
    await scheduler.schedule({
      ...request,
      taskId,
      profile: { ...request.profile, risk: 90 },
      affinity: { workerId: `${taskId}:worker:1` },
    }, budget, new AbortController().signal)

    await scheduler.dispose?.()

    await expect(scheduler.schedule({
      ...request,
      taskId,
      affinity: { workerId: `${taskId}:worker:1` },
    }, budget, new AbortController().signal)).resolves.toMatchObject({
      explanationCode: 'TASK_BASELINE',
      route: { model: 'baseline-disabled' },
    })
  })

  it('escalates a later request from bounded failed Handoff feedback', async () => {
    const scheduler = createAdaptiveScheduler(schedulerConfig, { generation: 'g1' })
    await scheduler.schedule(request, budget, new AbortController().signal)
    scheduler.observe?.({ schemaVersion: 1, requestId: request.taskId, outcome: 'failed', handoff: { schemaVersion: 1, status: 'failed', summary: 'Parser remains blocked.', changedFiles: [], decisions: [], verification: [], blockers: ['Schema mismatch.'] } })
    await expect(scheduler.schedule({ ...request, priorHandoff: { schemaVersion: 1, status: 'failed', summary: 'Parser remains blocked.', changedFiles: [], decisions: [], verification: [], blockers: ['Schema mismatch.'] } }, budget, new AbortController().signal)).resolves.toMatchObject({ route: { model: 'strong-disabled' }, explanationCode: 'HANDOFF_ESCALATION' })
  })
})
