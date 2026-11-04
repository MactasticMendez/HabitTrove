import { DateTime } from 'luxon'
import type { Habit } from './types'

function approvedTargetDays(habit: Habit, timezone: string, through: DateTime): DateTime[] {
  const counts = new Map<string, number>()
  for (const [index, timestamp] of habit.completions.entries()) {
    const record = habit.completionRecords?.[index]
    if (record?.voided || record?.approval === 'pending' || record?.approval === 'rejected') continue
    const completion = DateTime.fromISO(timestamp, { setZone: true }).setZone(timezone)
    if (!completion.isValid || completion > through) continue
    const key = completion.toISODate()!
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts]
    .filter(([, count]) => count >= (habit.targetCompletions ?? 1))
    .map(([date]) => DateTime.fromISO(date, { zone: timezone }).startOf('day'))
    .sort((a, b) => a.toMillis() - b.toMillis())
}

export function getAfterCompletionCycles(habit: Habit, timezone: string, through: DateTime): {
  completed: DateTime[]
  nextDue: DateTime | null
} {
  const schedule = habit.schedule
  if (schedule?.type !== 'afterCompletion') return { completed: [], nextDue: null }
  let nextDue = DateTime.fromISO(schedule.startsOn, { zone: timezone }).startOf('day')
  const endsOn = schedule.endsOn
    ? DateTime.fromISO(schedule.endsOn, { zone: timezone }).endOf('day') : null
  if (!nextDue.isValid || !Number.isSafeInteger(schedule.interval) || schedule.interval < 1 ||
      schedule.interval > 365 || !['days', 'weeks', 'months', 'years'].includes(schedule.unit) ||
      endsOn && !endsOn.isValid) return { completed: [], nextDue: null }

  const completed: DateTime[] = []
  for (const date of approvedTargetDays(habit, timezone, through)) {
    if (date < nextDue || endsOn && date > endsOn) continue
    completed.push(date)
    nextDue = date.plus({ [schedule.unit]: schedule.interval }).startOf('day')
  }
  return { completed, nextDue: endsOn && (nextDue > endsOn || through > endsOn) ? null : nextDue }
}

export function getNextAfterCompletionDate(habit: Habit, timezone: string, asOf: DateTime = DateTime.now()): DateTime | null {
  return getAfterCompletionCycles(habit, timezone, asOf).nextDue
}

export function isAfterCompletionDue(habit: Habit, date: DateTime, timezone: string): boolean {
  const day = date.setZone(timezone).startOf('day')
  if (!day.isValid || habit.schedule?.type !== 'afterCompletion') return false
  const endsOn = habit.schedule.endsOn
    ? DateTime.fromISO(habit.schedule.endsOn, { zone: timezone }).startOf('day') : null
  if (endsOn && day > endsOn) return false
  // A completion on the date being queried still belongs to that date's obligation.
  const next = getNextAfterCompletionDate(habit, timezone, day.minus({ milliseconds: 1 }))
  return !!next && next <= day
}
