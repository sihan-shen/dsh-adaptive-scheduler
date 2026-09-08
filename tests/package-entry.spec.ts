import { describe, expect, it } from 'vitest'

describe('published adaptive scheduler package entry', () => {
  it('exports history and Cordis lifecycle through the package name', async () => {
    const entry = await import('@han_05/dsh-adaptive-scheduler')

    expect(entry.BoundedPerformanceHistory).toEqual(expect.any(Function))
    expect(entry.apply).toEqual(expect.any(Function))
    expect(entry.name).toBe('dsh-adaptive-scheduler')
    expect(entry.provide).toEqual(['adaptiveScheduler'])
    expect(entry.inject).toEqual([])
  })
})
