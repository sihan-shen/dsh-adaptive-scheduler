import { describe, expect, it } from 'vitest'
import { catalogAvailability, createAdaptiveScheduler, parseAdaptiveSchedulerConfig, strongestAllowedAlias } from '../src/index.ts'

export const schedulerConfig = {
  policyVersion: 'v0.3.0',
  catalog: [
    { alias: 'baseline', route: { provider: 'provider-disabled', model: 'baseline-disabled', maxTokens: 32000, modelFamily: 'deepseek' }, tier: 'baseline', taskTypes: ['code-fix', 'unknown'], toolFilter: ['targeted_verify', 'write_file'], paid: false, reliability: 70 },
    { alias: 'fallback', route: { provider: 'provider-disabled', model: 'fallback-disabled', maxTokens: 32000, modelFamily: 'deepseek' }, tier: 'fallback', taskTypes: ['code-fix', 'unknown'], toolFilter: ['targeted_verify', 'write_file'], paid: false, reliability: 80 },
    { alias: 'strong', route: { provider: 'provider-disabled', model: 'strong-disabled', maxTokens: 64000, reasoningEffort: 'high', modelFamily: 'deepseek' }, tier: 'strong', taskTypes: ['code-fix', 'code-new', 'research', 'summarize', 'review', 'tool-heavy', 'unknown'], toolFilter: ['targeted_verify', 'write_file'], paid: false, reliability: 100 },
  ],
  baselines: { 'code-fix': 'baseline', 'code-new': 'strong', research: 'baseline', summarize: 'baseline', review: 'strong', 'tool-heavy': 'strong', unknown: 'baseline' },
  stickyTtlMs: 900000, idleTtlMs: 300000, errorWindowMs: 300000, cooldownMs: 60000, escalationTtlMs: 600000, maxEscalationsPerTask: 1, maxRounds: 2, historyWindowSize: 32, historyMinSamples: 3,
} as const

export const request = { schemaVersion: 1, target: 'worker', taskId: 'session-1', objective: 'Fix parser failure', profile: { coding: 90, reasoning: 60, toolUse: 30, repoContext: 70, risk: 20, difficulty: 50 }, constraints: { maxWorkers: 1, maxOutputTokens: 64000, maxLatencyMs: 60000, allowPaidFallback: false, allowedProviders: ['provider-disabled'], requiredTools: ['targeted_verify'] } } as const
export const budget = { maxWorkers: 1, admittedWorkers: 0, maxPluginToolActions: 24, admittedPluginToolActions: 0, remainingWorkers: 1, remainingPluginToolActions: 24 } as const
export const rootRequest = { ...request, target: 'root', taskId: 'root-1', constraints: { ...request.constraints, maxWorkers: 0, requiredTools: ['write_file'] } } as const

describe('adaptive scheduler policy configuration', () => {
  it('accepts the bounded catalog configuration and reports unknown availability', () => {
    expect(parseAdaptiveSchedulerConfig(schedulerConfig)).toEqual(schedulerConfig)
    expect(catalogAvailability(schedulerConfig.catalog[0])).toEqual({ quota: 'unknown', price: 'unknown', health: 'unknown' })
  })

  it('rejects values outside strict policy boundaries and unknown fields', () => {
    expect(() => parseAdaptiveSchedulerConfig({ ...schedulerConfig, maxRounds: 5 })).toThrow()
    expect(() => parseAdaptiveSchedulerConfig({ ...schedulerConfig, catalog: [...schedulerConfig.catalog, { ...schedulerConfig.catalog[0], alias: 'baseline' }] })).toThrow()
    expect(() => parseAdaptiveSchedulerConfig({ ...schedulerConfig, endpoint: 'https://example.invalid' })).toThrow()
    expect(() => parseAdaptiveSchedulerConfig({ ...schedulerConfig, historyWindowSize: 2, historyMinSamples: 3 })).toThrow(/historyMinSamples/)
  })

  it('uses deterministic safety, budget, explicit-route, and baseline precedence', async () => {
    const scheduler = createAdaptiveScheduler(schedulerConfig, { now: () => 1000, generation: 'g1' })
    await expect(scheduler.schedule(request, budget, new AbortController().signal)).resolves.toMatchObject({ source: 'scheduler', route: { model: 'baseline-disabled' }, explanationCode: 'TASK_BASELINE' })
    await expect(createAdaptiveScheduler({ ...schedulerConfig, explicitRoutes: { worker: 'strong' } }, { generation: 'g1' }).schedule(request, budget, new AbortController().signal)).resolves.toMatchObject({ route: { model: 'strong-disabled' }, explanationCode: 'EXPLICIT_ROUTE' })
    await expect(createAdaptiveScheduler({ ...schedulerConfig, explicitRoutes: { root: 'strong' } }, { generation: 'g1' }).schedule(rootRequest, budget, new AbortController().signal)).resolves.toMatchObject({ mode: 'direct', workerCount: 0, route: { model: 'strong-disabled' }, explanationCode: 'EXPLICIT_ROUTE' })
    await expect(scheduler.schedule(rootRequest, budget, new AbortController().signal)).resolves.toMatchObject({ mode: 'direct', workerCount: 0, route: { model: 'baseline-disabled' }, explanationCode: 'TASK_BASELINE' })
    await expect(scheduler.schedule(request, { ...budget, remainingWorkers: 0, admittedWorkers: 1 }, new AbortController().signal)).rejects.toThrow('LOCAL_WORKER_BUDGET')
    await expect(scheduler.schedule({ ...request, constraints: { ...request.constraints, requiredTools: ['delegate_worker'] } }, budget, new AbortController().signal)).rejects.toThrow('SAFETY_GATE')
    await expect(scheduler.schedule({ ...request, constraints: { ...request.constraints, requiredTools: ['unknown_tool'] } }, budget, new AbortController().signal)).rejects.toThrow('NO_CATALOG_ROUTE')
    await expect(scheduler.schedule(request, { ...budget, admittedPluginToolActions: 24, remainingPluginToolActions: 0 }, new AbortController().signal)).rejects.toThrow('LOCAL_TOOL_BUDGET')
    await expect(scheduler.schedule({ ...request, taskId: 'high-impact', profile: { ...request.profile, risk: 90 } }, budget, new AbortController().signal)).resolves.toMatchObject({ route: { model: 'strong-disabled' }, explanationCode: 'HIGH_IMPACT_STRONG_ROUTE' })
  })

  it('uses unknown task coverage for high-impact strong routes and keeps catalog-order tie breaks', async () => {
    const wildcardConfig = parseAdaptiveSchedulerConfig({
      ...schedulerConfig,
      catalog: [
        { alias: 'unknown-strong', route: { provider: 'provider-disabled', model: 'unknown-strong-disabled', maxTokens: 32000, modelFamily: 'deepseek' }, tier: 'strong', taskTypes: ['unknown'], toolFilter: ['targeted_verify'], paid: false, reliability: 100 },
        ...schedulerConfig.catalog,
      ],
    })
    const highImpactRequest = { ...request, taskId: 'unknown-high-impact', objective: 'Implement a new parser', profile: { ...request.profile, risk: 90 }, constraints: { ...request.constraints, maxOutputTokens: 64000, requiredTools: ['targeted_verify'] } } as const
    await expect(createAdaptiveScheduler(wildcardConfig, { generation: 'g1' }).schedule(highImpactRequest, budget, new AbortController().signal)).resolves.toMatchObject({ route: { model: 'unknown-strong-disabled' }, explanationCode: 'HIGH_IMPACT_STRONG_ROUTE' })

    const tieConfig = parseAdaptiveSchedulerConfig({
      ...schedulerConfig,
      catalog: [
        { alias: 'tie-first', route: { provider: 'provider-disabled', model: 'tie-first-disabled', maxTokens: 32000, modelFamily: 'deepseek' }, tier: 'strong', taskTypes: ['code-fix'], toolFilter: ['targeted_verify'], paid: false, reliability: 100 },
        { alias: 'tie-second', route: { provider: 'provider-disabled', model: 'tie-second-disabled', maxTokens: 32000, modelFamily: 'deepseek' }, tier: 'strong', taskTypes: ['code-fix'], toolFilter: ['targeted_verify'], paid: false, reliability: 100 },
        ...schedulerConfig.catalog,
      ],
    })
    expect(strongestAllowedAlias(tieConfig, request)).toBe('tie-first')
  })

  it('rejects catalog routes that violate provider, token, and required-tool constraints', async () => {
    const scheduler = createAdaptiveScheduler(schedulerConfig)
    await expect(scheduler.schedule({ ...rootRequest, constraints: { ...rootRequest.constraints, allowedProviders: ['other-provider'] } }, budget, new AbortController().signal)).rejects.toThrow('NO_CATALOG_ROUTE')
    await expect(scheduler.schedule({ ...rootRequest, constraints: { ...rootRequest.constraints, maxOutputTokens: 16000 } }, budget, new AbortController().signal)).rejects.toThrow('NO_CATALOG_ROUTE')
    await expect(scheduler.schedule({ ...rootRequest, constraints: { ...rootRequest.constraints, requiredTools: ['targeted_verify', 'missing-tool'] } }, budget, new AbortController().signal)).rejects.toThrow('NO_CATALOG_ROUTE')
  })
})
