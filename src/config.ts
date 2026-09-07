import { MAX_SCHEDULING_IDENTIFIER_BYTES, MAX_SCHEDULING_ITEMS, parseRouteDecisionV1 } from '@ds-plugins/dsh-scheduling-contracts'
import type { AdaptiveSchedulerConfig, RouteCatalogEntryV1, RouteTierV1, TaskTypeV1 } from './types.js'

export const MAX_STICKY_TTL_MS = 3_600_000
export const MAX_IDLE_TTL_MS = 900_000
export const MAX_ERROR_WINDOW_MS = 600_000
export const MAX_COOLDOWN_MS = 600_000
export const MAX_ESCALATION_TTL_MS = 3_600_000
export const MAX_ESCALATIONS_PER_TASK = 2
export const MAX_ROUNDS = 4
export const MAX_HISTORY_WINDOW_SIZE = 64

const TASK_TYPES = ['code-fix', 'code-new', 'research', 'summarize', 'review', 'tool-heavy', 'unknown'] as const
const CONFIG_KEYS = ['policyVersion', 'catalog', 'baselines', 'explicitRoutes', 'stickyTtlMs', 'idleTtlMs', 'errorWindowMs', 'cooldownMs', 'escalationTtlMs', 'maxEscalationsPerTask', 'maxRounds', 'historyWindowSize', 'historyMinSamples'] as const
const CATALOG_KEYS = ['alias', 'route', 'tier', 'taskTypes', 'toolFilter', 'paid', 'reliability'] as const
const ROUTE_KEYS = ['root', 'worker'] as const
const textEncoder = new TextEncoder()
type RecordValue = Record<string, unknown>

function fail(path: string, message: string): never { throw new TypeError(`${path} ${message}`) }

function record(value: unknown, path: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object')
  return value as RecordValue
}

function exactKeys(value: RecordValue, path: string, keys: readonly string[]): void {
  const allowed = new Set(keys)
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !allowed.has(key)) fail(`${path}.${String(key)}`, 'is not allowed')
}

function required(value: RecordValue, key: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${path}.${key}`, 'is required')
  return value[key]
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a non-empty identifier')
  if (value.includes('\0')) fail(path, 'must not contain a NUL byte')
  if (textEncoder.encode(value).byteLength > MAX_SCHEDULING_IDENTIFIER_BYTES) fail(path, `must not exceed ${MAX_SCHEDULING_IDENTIFIER_BYTES} UTF-8 bytes`)
  return value
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean')
  return value
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail(path, `must be an integer between ${minimum} and ${maximum}`)
  return value
}

function boundedNumber(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) fail(path, `must be between ${minimum} and ${maximum}`)
  return value
}

function stringArray(value: unknown, path: string, requireItems: boolean): readonly string[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  if (value.length === 0 && requireItems) fail(path, 'must not be empty')
  if (value.length > MAX_SCHEDULING_ITEMS) fail(path, `must not contain more than ${MAX_SCHEDULING_ITEMS} items`)
  const result = value.map((item, index) => identifier(item, `${path}[${index}]`))
  if (new Set(result).size !== result.length) fail(path, 'must not contain duplicate values')
  return result
}

function taskTypes(value: unknown, path: string): readonly TaskTypeV1[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  if (value.length === 0) fail(path, 'must not be empty')
  if (value.length > TASK_TYPES.length) fail(path, `must not contain more than ${TASK_TYPES.length} items`)
  const result = value.map((item, index) => {
    if (!TASK_TYPES.includes(item as TaskTypeV1)) fail(`${path}[${index}]`, 'is unsupported')
    return item as TaskTypeV1
  })
  if (new Set(result).size !== result.length) fail(path, 'must not contain duplicate values')
  return result
}

function catalogEntry(value: unknown, index: number): RouteCatalogEntryV1 {
  const path = `catalog[${index}]`
  const entry = record(value, path)
  exactKeys(entry, path, CATALOG_KEYS)
  const tier = required(entry, 'tier', path)
  if (tier !== 'baseline' && tier !== 'fallback' && tier !== 'strong') fail(`${path}.tier`, 'is unsupported')
  return {
    alias: identifier(required(entry, 'alias', path), `${path}.alias`),
    route: parseRouteDecisionV1(required(entry, 'route', path)),
    tier: tier as RouteTierV1,
    taskTypes: taskTypes(required(entry, 'taskTypes', path), `${path}.taskTypes`),
    toolFilter: stringArray(required(entry, 'toolFilter', path), `${path}.toolFilter`, false),
    paid: booleanValue(required(entry, 'paid', path), `${path}.paid`),
    reliability: boundedNumber(required(entry, 'reliability', path), `${path}.reliability`, 0, 100),
  }
}

function baselines(value: unknown): Readonly<Record<TaskTypeV1, string>> {
  const input = record(value, 'baselines')
  exactKeys(input, 'baselines', TASK_TYPES)
  return Object.fromEntries(TASK_TYPES.map(taskType => [taskType, identifier(required(input, taskType, 'baselines'), `baselines.${taskType}`)])) as Record<TaskTypeV1, string>
}

function explicitRoutes(value: unknown): AdaptiveSchedulerConfig['explicitRoutes'] {
  if (value === undefined) return undefined
  const input = record(value, 'explicitRoutes')
  exactKeys(input, 'explicitRoutes', ROUTE_KEYS)
  const result: { root?: string; worker?: string } = {}
  for (const key of ROUTE_KEYS) if (Object.prototype.hasOwnProperty.call(input, key)) result[key] = identifier(input[key], `explicitRoutes.${key}`)
  return result
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as RecordValue)) deepFreeze(child)
  return Object.freeze(value)
}

export function parseAdaptiveSchedulerConfig(value: unknown): AdaptiveSchedulerConfig {
  const config = record(value, 'config')
  exactKeys(config, 'config', CONFIG_KEYS)
  const catalogValue = required(config, 'catalog', 'config')
  if (!Array.isArray(catalogValue)) fail('catalog', 'must be an array')
  if (catalogValue.length === 0) fail('catalog', 'must not be empty')
  if (catalogValue.length > MAX_SCHEDULING_ITEMS) fail('catalog', `must not contain more than ${MAX_SCHEDULING_ITEMS} items`)
  const catalog = catalogValue.map(catalogEntry)
  const aliases = new Set<string>()
  for (const entry of catalog) {
    if (aliases.has(entry.alias)) fail('catalog', `contains duplicate alias ${JSON.stringify(entry.alias)}`)
    aliases.add(entry.alias)
  }
  const parsedBaselines = baselines(required(config, 'baselines', 'config'))
  const parsedExplicitRoutes = explicitRoutes(config.explicitRoutes)
  for (const [taskType, alias] of Object.entries(parsedBaselines)) if (!aliases.has(alias)) fail(`baselines.${taskType}`, `references unknown catalog alias ${JSON.stringify(alias)}`)
  for (const key of ROUTE_KEYS) {
    const alias = parsedExplicitRoutes?.[key]
    if (alias !== undefined && !aliases.has(alias)) fail(`explicitRoutes.${key}`, `references unknown catalog alias ${JSON.stringify(alias)}`)
  }
  const historyWindowSize = boundedInteger(required(config, 'historyWindowSize', 'config'), 'historyWindowSize', 1, MAX_HISTORY_WINDOW_SIZE)
  const historyMinSamples = boundedInteger(required(config, 'historyMinSamples', 'config'), 'historyMinSamples', 1, MAX_HISTORY_WINDOW_SIZE)
  if (historyMinSamples > historyWindowSize) fail('historyMinSamples', 'must not exceed historyWindowSize')
  return deepFreeze({
    policyVersion: identifier(required(config, 'policyVersion', 'config'), 'policyVersion'),
    catalog,
    baselines: parsedBaselines,
    ...(parsedExplicitRoutes === undefined ? {} : { explicitRoutes: parsedExplicitRoutes }),
    stickyTtlMs: boundedInteger(required(config, 'stickyTtlMs', 'config'), 'stickyTtlMs', 1, MAX_STICKY_TTL_MS),
    idleTtlMs: boundedInteger(required(config, 'idleTtlMs', 'config'), 'idleTtlMs', 1, MAX_IDLE_TTL_MS),
    errorWindowMs: boundedInteger(required(config, 'errorWindowMs', 'config'), 'errorWindowMs', 1, MAX_ERROR_WINDOW_MS),
    cooldownMs: boundedInteger(required(config, 'cooldownMs', 'config'), 'cooldownMs', 1, MAX_COOLDOWN_MS),
    escalationTtlMs: boundedInteger(required(config, 'escalationTtlMs', 'config'), 'escalationTtlMs', 1, MAX_ESCALATION_TTL_MS),
    maxEscalationsPerTask: boundedInteger(required(config, 'maxEscalationsPerTask', 'config'), 'maxEscalationsPerTask', 0, MAX_ESCALATIONS_PER_TASK),
    maxRounds: boundedInteger(required(config, 'maxRounds', 'config'), 'maxRounds', 1, MAX_ROUNDS),
    historyWindowSize,
    historyMinSamples,
  })
}

export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: '@ds-plugins/dsh-adaptive-scheduler',
    validate(value: unknown) {
      try { return { value: parseAdaptiveSchedulerConfig(value) } } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : 'invalid configuration' }] }
      }
    },
  },
}
