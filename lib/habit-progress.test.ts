import { describe, expect, test } from 'bun:test'
import { DateTime } from 'luxon'
import { getPerHabitProgress } from './habit-progress'
import type { Habit } from './types'

const task: Habit = {
  id: 't', name: 'Daily task', description: '', isTask: true,
  frequency: '2026-03-06T12:00:00.000Z', taskRepeat: 'daily',
  coinReward: 1, completions: ['2026-03-07T12:00:00.000Z', '2026-03-08T12:00:00.000Z'],
}

describe('per-item progress', () => {
  test('counts due dates and keeps a streak through an unfinished current day', () => {
    expect(getPerHabitProgress(task, DateTime.fromISO('2026-03-09T12:00:00Z'), 'UTC', 5))
      .toEqual({ streak: 2, weeklyDone: 2, weeklyDue: 4, graceUsed: false })
  })
  test('rejected completions do not advance progress', () => {
    const rejected = { ...task, completionRecords: [null, { id: 'r', actorId: 'u', approval: 'rejected' as const }] }
    expect(getPerHabitProgress(rejected, DateTime.fromISO('2026-03-09T12:00:00Z'), 'UTC', 5))
      .toEqual({ streak: 1, weeklyDone: 1, weeklyDue: 4, graceUsed: true })
  })
  test('a second missed occurrence ends the streak', () => {
    const missed = { ...task, completions: ['2026-03-06T12:00:00Z'] }
    expect(getPerHabitProgress(missed, DateTime.fromISO('2026-03-09T12:00:00Z'), 'UTC', 5).streak).toBe(0)
  })
  test('status dates do not count as due or break the streak', () => {
    const progress = getPerHabitProgress(task, DateTime.fromISO('2026-03-09T12:00:00Z'), 'UTC', 5,
      new Set(['2026-03-06']))
    expect(progress.weeklyDue).toBe(3)
    expect(progress.streak).toBe(2)
  })

  test('any-time events do not create daily obligations or streak pressure', () => {
    expect(getPerHabitProgress({ ...task, isTask: false,
      schedule: { type: 'anytime', recordingPolicy: 'both' } }, DateTime.fromISO('2026-03-09'), 'UTC'))
      .toEqual({ streak: 0, weeklyDone: 0, weeklyDue: 0, graceUsed: false })
  })

  test('completion-relative progress counts cycles with at most one overdue obligation', () => {
    const habit: Habit = { ...task, isTask: false,
      schedule: { type: 'afterCompletion', interval: 2, unit: 'days', startsOn: '2026-03-01' },
      completions: ['2026-03-02T12:00:00Z', '2026-03-05T12:00:00Z'],
    }
    expect(getPerHabitProgress(habit, DateTime.fromISO('2026-03-15'), 'UTC'))
      .toEqual({ streak: 2, weeklyDone: 0, weeklyDue: 1, graceUsed: true })
    expect(getPerHabitProgress(habit, DateTime.fromISO('2026-03-05'), 'UTC'))
      .toEqual({ streak: 2, weeklyDone: 2, weeklyDue: 2, graceUsed: false })
  })
})
