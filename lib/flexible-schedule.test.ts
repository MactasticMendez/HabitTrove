import { describe, expect, test } from 'bun:test'
import { DateTime } from 'luxon'
import type { Habit } from './types'
import { getAfterCompletionCycles, getNextAfterCompletionDate, isAfterCompletionDue } from './flexible-schedule'

const item = (changes: Partial<Habit> = {}): Habit => ({
  id: 'relative', name: 'Replace filter', description: '', frequency: 'FREQ=DAILY', coinReward: 1,
  completions: [], schedule: { type: 'afterCompletion', interval: 10, unit: 'days', startsOn: '2026-03-01' },
  ...changes,
})
const utc = (date: string) => DateTime.fromISO(date, { zone: 'UTC' })

describe('completion-relative schedules', () => {
  test('retains one overdue obligation and starts the next interval from the actual completion day', () => {
    const habit = item({ completions: ['2026-03-05T12:00:00Z'] })
    expect(isAfterCompletionDue(habit, utc('2026-02-28'), 'UTC')).toBe(false)
    expect(isAfterCompletionDue(habit, utc('2026-03-04'), 'UTC')).toBe(true)
    expect(isAfterCompletionDue(habit, utc('2026-03-05'), 'UTC')).toBe(true)
    expect(isAfterCompletionDue(habit, utc('2026-03-14'), 'UTC')).toBe(false)
    expect(isAfterCompletionDue(habit, utc('2026-03-15'), 'UTC')).toBe(true)
    expect(getNextAfterCompletionDate(habit, 'UTC', utc('2026-03-20'))?.toISODate()).toBe('2026-03-15')
    expect(getAfterCompletionCycles(habit, 'UTC', utc('2026-03-20')).completed.map(date => date.toISODate()))
      .toEqual(['2026-03-05'])
  })

  test('only approved target-reaching days advance the next due date', () => {
    const habit = item({ targetCompletions: 2,
      completions: ['2026-03-01T10:00:00Z', '2026-03-01T11:00:00Z', '2026-03-02T12:00:00Z',
        '2026-03-02T13:00:00Z', '2026-03-03T12:00:00Z'],
      completionRecords: [
        { id: 'one', actorId: 'u' }, { id: 'two', actorId: 'u', approval: 'pending' },
        { id: 'three', actorId: 'u' }, { id: 'four', actorId: 'u', approval: 'rejected' },
        { id: 'five', actorId: 'u', voided: true },
      ],
    })
    expect(getNextAfterCompletionDate(habit, 'UTC', utc('2026-03-10'))?.toISODate()).toBe('2026-03-01')
    habit.completionRecords![1] = { id: 'two', actorId: 'u', approval: 'approved' }
    expect(getNextAfterCompletionDate(habit, 'UTC', utc('2026-03-10'))?.toISODate()).toBe('2026-03-11')
  })

  test('sorts completion dates and ignores early completions outside the current cycle', () => {
    const habit = item({ completions: ['2026-03-14T12:00:00Z', '2026-03-01T12:00:00Z', '2026-03-05T12:00:00Z'] })
    const cycles = getAfterCompletionCycles(habit, 'UTC', utc('2026-03-20'))
    expect(cycles.completed.map(date => date.toISODate())).toEqual(['2026-03-01', '2026-03-14'])
    expect(cycles.nextDue?.toISODate()).toBe('2026-03-24')
  })

  test('uses local calendar intervals across DST and month ends', () => {
    const habit = item({ schedule: { type: 'afterCompletion', interval: 2, unit: 'days', startsOn: '2026-03-28' },
      completions: ['2026-03-28T23:30:00Z'] })
    const next = getNextAfterCompletionDate(habit, 'Europe/London', utc('2026-04-01'))!
    expect(next.toISODate()).toBe('2026-03-30')
    expect(next.hour).toBe(0)
    const monthly = item({ schedule: { type: 'afterCompletion', interval: 1, unit: 'months', startsOn: '2026-01-01' },
      completions: ['2026-01-31T12:00:00Z'] })
    expect(getNextAfterCompletionDate(monthly, 'UTC', utc('2026-02-01'))?.toISODate()).toBe('2026-02-28')
  })

  test('honors end dates for overdue and future obligations', () => {
    const habit = item({ schedule: { type: 'afterCompletion', interval: 10, unit: 'days', startsOn: '2026-03-01', endsOn: '2026-03-10' } })
    expect(isAfterCompletionDue(habit, utc('2026-03-10'), 'UTC')).toBe(true)
    expect(isAfterCompletionDue(habit, utc('2026-03-11'), 'UTC')).toBe(false)
    expect(getNextAfterCompletionDate(habit, 'UTC', utc('2026-03-11'))).toBeNull()
    expect(getNextAfterCompletionDate({ ...habit, completions: ['2026-03-05T12:00:00Z'] }, 'UTC', utc('2026-03-06'))).toBeNull()
  })
})
