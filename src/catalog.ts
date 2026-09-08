import type { CapabilityRequestV1, RouteDecisionV1 } from '@han_05/dsh-scheduling-contracts'
import type { AdaptiveSchedulerConfig, CatalogAvailabilityV1, RouteCatalogEntryV1, TaskTypeV1 } from './types.js'

interface CandidateSnapshot {
  readonly route: RouteDecisionV1
  readonly toolFilter: readonly string[]
}

export function catalogAvailability(_entry: RouteCatalogEntryV1): CatalogAvailabilityV1 {
  return { quota: 'unknown', price: 'unknown', health: 'unknown' }
}

export function strongestAllowedAlias(config: AdaptiveSchedulerConfig, request: CapabilityRequestV1): string | undefined {
  const taskType = classifyTaskType(request)
  const candidates = config.catalog.filter(entry => entry.tier === 'strong' && (entry.taskTypes.includes(taskType) || entry.taskTypes.includes('unknown')) && routeAllowed(entry, request))
  let strongest: RouteCatalogEntryV1 | undefined
  for (const candidate of candidates) if (strongest === undefined || candidate.reliability > strongest.reliability) strongest = candidate
  return strongest?.alias
}

export function resolveCatalogCandidate(config: AdaptiveSchedulerConfig, alias: string | undefined, request: CapabilityRequestV1, snapshot?: CandidateSnapshot): RouteCatalogEntryV1 | undefined {
  if (alias === undefined) return undefined
  const candidate = config.catalog.find(entry => entry.alias === alias)
  if (candidate === undefined || !routeAllowed(candidate, request, snapshot?.route, snapshot?.toolFilter)) return undefined
  if (snapshot === undefined) return candidate
  return Object.freeze({
    ...candidate,
    route: Object.freeze({ ...snapshot.route }),
    toolFilter: Object.freeze([...snapshot.toolFilter]),
  })
}

function routeAllowed(entry: RouteCatalogEntryV1, request: CapabilityRequestV1, route = entry.route, toolFilter = entry.toolFilter): boolean {
  const taskType = classifyTaskType(request)
  if (!entry.taskTypes.includes(taskType) && !entry.taskTypes.includes('unknown')) return false
  if (entry.paid && !request.constraints.allowPaidFallback) return false
  if (request.constraints.allowedProviders !== undefined && !request.constraints.allowedProviders.includes(route.provider)) return false
  if (route.maxTokens > request.constraints.maxOutputTokens) return false
  return request.constraints.requiredTools.every(tool => toolFilter.includes(tool))
}

function classifyTaskType(request: CapabilityRequestV1): TaskTypeV1 {
  const objective = request.objective.toLowerCase()
  if (/\b(summar(?:ize|y)|condense|tl;dr)\b/u.test(objective)) return 'summarize'
  if (/\b(research|investigate|explore|compare|find out)\b/u.test(objective)) return 'research'
  if (/\b(review|audit|critique|inspect)\b/u.test(objective)) return 'review'
  if (/\b(fix|bug|error|failure|repair|patch|regression)\b/u.test(objective)) return 'code-fix'
  if (/\b(implement|add|create|build|new feature|introduce)\b/u.test(objective)) return 'code-new'
  if (request.constraints.requiredTools.length > 1 || request.profile.toolUse >= 80) return 'tool-heavy'
  return 'unknown'
}

export { classifyTaskType }
