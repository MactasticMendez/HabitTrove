import { describe, expect, it } from 'bun:test'
import { DateTime } from 'luxon'
import type { Habit } from './types'
import { getTaskMissedDates, getTaskProgress, isTaskScheduledOnDate } from './task-schedule'

const task = (changes: Partial<Habit> = {}): Habit => ({
  id: 'task-1', name: 'Study', description: '', isTask: true,
  frequency: '2026-03-28T09:00:00.000Z', coinReward: 2, completions: [],
  ...changes,
})

describe('recurring task dates', () => {
  it('uses calendar days across daylight saving changes', () => {
    const item = task({ taskRepeat: 'daily' })
    expect(isTaskScheduledOnDate(item, DateTime.fromISO('2026-03-29', { zone: 'Europe/London' }), 'Europe/London')).toBe(true)
    expect(isTaskScheduledOnDate(item, DateTime.fromISO('2026-03-27', { zone: 'Europe/London' }), 'Europe/London')).toBe(false)
  })

  it('clamps a monthly task to the last day of a short month', () => {
    const item = task({ frequency: '2026-01-31T12:00:00.000Z', taskRepeat: 'monthly' })
    expect(isTaskScheduledOnDate(item, DateTime.fromISO('2026-02-28'), 'UTC')).toBe(true)
    expect(isTaskScheduledOnDate(item, DateTime.fromISO('2026-03-30'), 'UTC')).toBe(false)
  })

  it('finds missed occurrences without counting rejected submissions', () => {
    const item = task({
      taskRepeat: 'daily',
      completions: ['2026-03-28T09:00:00.000Z', '2026-03-29T09:00:00.000Z'],
      completionRecords: [
        { id: 'one', actorId: 'user', approval: 'approved' },
        { id: 'two', actorId: 'user', approval: 'rejected' },
      ],
    })
    expect(getTaskMissedDates(item, DateTime.fromISO('2026-03-30'), 'UTC').map(day => day.toISODate())).toEqual(['2026-03-29'])
    expect(getTaskProgress(item, 'UTC')).toBe(1)
  })

  it('counts completed dates toward task goals only after the daily target', () => {
    const item = task({ taskRepeat: 'daily', targetCompletions: 2,
      completions: ['2026-03-28T09:00:00.000Z', '2026-03-28T10:00:00.000Z', '2026-03-29T09:00:00.000Z'],
    })
    expect(getTaskProgress(item, 'UTC')).toBe(1)
    expect(getTaskMissedDates(item, DateTime.fromISO('2026-03-30'), 'UTC').map(day => day.toISODate()))
      .toEqual(['2026-03-29'])
  })

  it('keeps an incomplete one-off task overdue beyond the recurring lookback', () => {
    const item = task({ frequency: '2024-01-01T09:00:00.000Z', targetCompletions: 2,
      completions: ['2024-01-01T09:00:00.000Z'] })
    expect(getTaskMissedDates(item, DateTime.fromISO('2026-03-30'), 'UTC').map(day => day.toISODate()))
      .toEqual(['2024-01-01'])
  })
})
