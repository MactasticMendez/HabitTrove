import { describe, expect, test } from 'bun:test'
import { DateTime } from 'luxon'
import { Habit } from './types'
import { getActivityDays, getCurrentStreak } from './activity'

const habit = { id: 'habit', isTask: false } as Habit
const task = { id: 'task', isTask: true } as Habit

describe('activity summaries', () => {
  test('counts completed habits and tasks by configured calendar day', () => {
    const today = DateTime.fromISO('2026-03-09', { zone: 'America/New_York' })
    const completions = new Map([
      ['2026-03-07', [habit]],
      ['2026-03-08', [habit, task]],
      ['2026-03-09', [task]],
    ])
    expect(getActivityDays(completions, today, 3)).toEqual([
      { date: '2026-03-07', habits: 1, tasks: 0, total: 1 },
      { date: '2026-03-08', habits: 1, tasks: 1, total: 2 },
      { date: '2026-03-09', habits: 0, tasks: 1, total: 1 },
    ])
    expect(getCurrentStreak(completions, today)).toBe(3)
  })

  test('preserves a streak until the current local day ends and stops at a gap', () => {
    const today = DateTime.fromISO('2026-11-01', { zone: 'America/New_York' })
    const completions = new Map([
      ['2026-10-29', [habit]],
      ['2026-10-31', [habit]],
    ])
    expect(getCurrentStreak(completions, today)).toBe(1)
    expect(getCurrentStreak(new Map(), today)).toBe(0)
  })

  test('status dates pause a streak without adding completions', () => {
    const today = DateTime.fromISO('2026-11-03', { zone: 'UTC' })
    const completions = new Map([
      ['2026-11-01', [habit]],
      ['2026-11-03', [habit]],
    ])
    expect(getCurrentStreak(completions, today)).toBe(1)
    expect(getCurrentStreak(completions, today, new Set(['2026-11-02']))).toBe(2)
    expect(getCurrentStreak(new Map([['2026-11-01', [habit]]]), today,
      new Set(['2026-11-02', '2026-11-03']))).toBe(1)
  })
})
