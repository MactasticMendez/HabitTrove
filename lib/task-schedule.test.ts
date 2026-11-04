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

  it('supports multi-week, multi-month and multi-year intervals with inclusive end dates', () => {
    const weekly = task({ taskRepeat: 'weekly', taskRepeatInterval: 2, taskRepeatUntil: '2026-04-25' })
    expect(isTaskScheduledOnDate(weekly, DateTime.fromISO('2026-04-04'), 'UTC')).toBe(false)
    expect(isTaskScheduledOnDate(weekly, DateTime.fromISO('2026-04-11'), 'UTC')).toBe(true)
    expect(isTaskScheduledOnDate(weekly, DateTime.fromISO('2026-04-25'), 'UTC')).toBe(true)
    expect(isTaskScheduledOnDate(weekly, DateTime.fromISO('2026-05-09'), 'UTC')).toBe(false)
    const monthly = task({ frequency: '2026-01-31T12:00:00Z', taskRepeat: 'monthly', taskRepeatInterval: 2 })
    expect(isTaskScheduledOnDate(monthly, DateTime.fromISO('2026-02-28'), 'UTC')).toBe(false)
    expect(isTaskScheduledOnDate(monthly, DateTime.fromISO('2026-03-31'), 'UTC')).toBe(true)
    const yearly = task({ frequency: '2024-02-29T12:00:00Z', taskRepeat: 'yearly', taskRepeatInterval: 2 })
    expect(isTaskScheduledOnDate(yearly, DateTime.fromISO('2025-02-28'), 'UTC')).toBe(false)
    expect(isTaskScheduledOnDate(yearly, DateTime.fromISO('2026-02-28'), 'UTC')).toBe(true)
  })

  it('uses local days for every-N-day task cadence across DST', () => {
    const item = task({ taskRepeat: 'daily', taskRepeatInterval: 2 })
    expect(isTaskScheduledOnDate(item, DateTime.fromISO('2026-03-29', { zone: 'Europe/London' }), 'Europe/London')).toBe(false)
    expect(isTaskScheduledOnDate(item, DateTime.fromISO('2026-03-30', { zone: 'Europe/London' }), 'Europe/London')).toBe(true)
  })

  it('keeps one overdue after-completion occurrence instead of accumulating daily debt', () => {
    const item = task({ schedule: { type: 'afterCompletion', interval: 10, unit: 'days', startsOn: '2026-03-01' },
      completions: ['2026-03-05T12:00:00Z'] })
    expect(getTaskMissedDates(item, DateTime.fromISO('2026-03-30'), 'UTC').map(day => day.toISODate()))
      .toEqual(['2026-03-15'])
    expect(getTaskProgress(item, 'UTC')).toBe(1)
  })

  it('does not count voided completion tombstones toward goals', () => {
    const item = task({ completions: ['2026-03-28T12:00:00Z'],
      completionRecords: [{ id: 'void', actorId: 'u', voided: true }] })
    expect(getTaskProgress(item, 'UTC')).toBe(0)
    expect(getTaskMissedDates(item, DateTime.fromISO('2026-03-30'), 'UTC').map(day => day.toISODate()))
      .toEqual(['2026-03-28'])
  })
})
