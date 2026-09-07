import type { Context, Plugin } from '@deepseek-ai/cordis'
import { Config, parseAdaptiveSchedulerConfig } from './config.js'
import { createAdaptiveScheduler } from './scheduler.js'
import type { AdaptiveSchedulerConfig, AdaptiveSchedulerRuntime, ProviderFailureCodeV1 } from './types.js'

const FAILURE_CODES = new Set<ProviderFailureCodeV1>(['QUOTA', 'RATE_LIMIT', 'AUTH', 'SERVER', 'TIMEOUT', 'TRANSPORT'])

interface RequestErrorPayload {
  readonly agent: {
    readonly session: {
      readonly id: unknown
      readonly header: { readonly parentSession?: unknown }
    }
  }
  readonly failure: {
    readonly code: string
    readonly providerRetryAfterMs?: number
  }
}

interface EventContext {
  provide(name: string, value: unknown): () => void
  on(name: 'agent/request-error', listener: (payload: RequestErrorPayload, next: () => Promise<unknown>) => Promise<unknown>): () => void
  on(name: 'session/disposed', listener: (session: { readonly id: unknown; readonly header: { readonly parentSession?: unknown } }) => void): () => void
}

export const name = 'dsh-adaptive-scheduler'
export const provide = ['adaptiveScheduler'] as const
export const inject = [] as const

export const apply: Plugin.Function<AdaptiveSchedulerConfig> = (ctx: Context, rawConfig: AdaptiveSchedulerConfig): void => {
  const config = parseAdaptiveSchedulerConfig(rawConfig)
  const runtime = createAdaptiveScheduler(config, { generation: crypto.randomUUID() })
  const eventContext = ctx as unknown as EventContext
  ctx.effect(() => {
    const disposeService = eventContext.provide('adaptiveScheduler', runtime)
    const disposeFailures = eventContext.on('agent/request-error', async ({ agent, failure }, next) => {
      if (FAILURE_CODES.has(failure.code as ProviderFailureCodeV1)) {
        runtime.recordFailure({
          requestId: String(agent.session.id),
          code: failure.code as ProviderFailureCodeV1,
          ...(failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: failure.providerRetryAfterMs }),
        })
      }
      return next()
    })
    const disposeSessions = eventContext.on('session/disposed', session => {
      runtime.disposeSession(String(session.id))
    })
    return async () => {
      disposeSessions()
      disposeFailures()
      disposeService()
      await runtime.dispose?.()
    }
  }, 'dsh-adaptive-scheduler: service generation')
}

apply.Config = Config
apply.inject = inject
apply.provide = [...provide]

export type { AdaptiveSchedulerRuntime }
