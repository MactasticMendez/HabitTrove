import { describe, expect, test } from 'bun:test'
import { DateTime } from 'luxon'
import type { Habit } from './types'
import { reminderDueDate } from './reminders'

const task: Habit = {
  id: 't', name: 'Study', description: '', isTask: true,
  frequency: '2026-03-09T12:00:00Z', coinReward: 1, completions: [], reminderTime: '14:00',
}

describe('reminder timing', () => {
  test('waits until the configured lead and still alerts when opened late', () => {
    expect(reminderDueDate(task, DateTime.fromISO('2026-03-09T13:49:00Z'), 'UTC', 10)).toBeNull()
    expect(reminderDueDate(task, DateTime.fromISO('2026-03-09T13:50:00Z'), 'UTC', 10)).toBe('2026-03-09')
    expect(reminderDueDate(task, DateTime.fromISO('2026-03-09T18:00:00Z'), 'UTC', 10)).toBe('2026-03-09')
  })
  test('handles an alert before midnight for a task due tomorrow', () => {
    const tomorrow = { ...task, frequency: '2026-03-10T12:00:00Z', reminderTime: '00:10' }
    expect(reminderDueDate(tomorrow, DateTime.fromISO('2026-03-09T23:45:00Z'), 'UTC', 30)).toBe('2026-03-10')
  })
  test('does not remind for a completed task', () => {
    const completed = { ...task, completions: ['2026-03-09T12:00:00Z'] }
    expect(reminderDueDate(completed, DateTime.fromISO('2026-03-09T18:00:00Z'), 'UTC', 10)).toBeNull()
  })
})
