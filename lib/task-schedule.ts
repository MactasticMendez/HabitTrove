import { DateTime } from 'luxon'
import type { Habit } from './types'
import { getAfterCompletionCycles, getNextAfterCompletionDate, isAfterCompletionDue } from './flexible-schedule'

export function isCountedCompletion(habit: Habit, index: number): boolean {
  const record = habit.completionRecords?.[index]
  return !record?.voided && record?.approval !== 'rejected'
}

export function isApprovedCompletion(habit: Habit, index: number): boolean {
  const record = habit.completionRecords?.[index]
  return !record?.voided && record?.approval !== 'rejected' && record?.approval !== 'pending'
}

export function isTaskScheduledOnDate(habit: Habit, date: DateTime, timezone: string): boolean {
  if (!habit.isTask) return false
  if (habit.schedule?.type === 'afterCompletion') return isAfterCompletionDue(habit, date, timezone)
  const anchor = DateTime.fromISO(habit.frequency, { setZone: true }).setZone(timezone).startOf('day')
  const day = date.setZone(timezone).startOf('day')
  if (!anchor.isValid || day < anchor) return false
  if (habit.taskRepeatUntil && day.toISODate()! > habit.taskRepeatUntil) return false
  if (!habit.taskRepeat) return day.hasSame(anchor, 'day')
  const interval = habit.taskRepeatInterval ?? 1
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 365) return false

  if (habit.taskRepeat === 'daily') return Math.round(day.diff(anchor, 'days').days) % interval === 0
  if (habit.taskRepeat === 'weekly') return Math.round(day.diff(anchor, 'days').days) % (7 * interval) === 0
  if (habit.taskRepeat === 'monthly') {
    const months = (day.year - anchor.year) * 12 + day.month - anchor.month
    return months % interval === 0 && day.day === Math.min(anchor.day, day.daysInMonth ?? 31)
  }
  return (day.year - anchor.year) % interval === 0 && day.month === anchor.month &&
    day.day === Math.min(anchor.day, day.daysInMonth ?? 31)
}

export function getTaskMissedDates(habit: Habit, today: DateTime, timezone: string): DateTime[] {
  if (!habit.isTask || habit.archived) return []
  const todayStart = today.setZone(timezone).startOf('day')
  if (habit.schedule?.type === 'afterCompletion') {
    const due = getNextAfterCompletionDate(habit, timezone, todayStart.endOf('day'))
    const end = habit.schedule.endsOn
      ? DateTime.fromISO(habit.schedule.endsOn, { zone: timezone }).endOf('day') : null
    if (!due || due >= todayStart || end && todayStart > end) return []
    return [due]
  }
  const anchor = DateTime.fromISO(habit.frequency, { setZone: true }).setZone(timezone).startOf('day')
  if (!anchor.isValid || anchor >= todayStart) return []
  if (!habit.taskRepeat) {
    return habit.completions.filter((_, index) => isCountedCompletion(habit, index)).length >=
      (habit.targetCompletions ?? 1) ? [] : [anchor]
  }
  const start = anchor > todayStart.minus({ days: 365 }) ? anchor : todayStart.minus({ days: 365 })
  const counts = new Map<string, number>()
  habit.completions.forEach((value, index) => {
    if (!isCountedCompletion(habit, index)) return
    const day = DateTime.fromISO(value, { setZone: true }).setZone(timezone).toISODate()!
    counts.set(day, (counts.get(day) ?? 0) + 1)
  })
  const missed: DateTime[] = []
  for (let day = start; day < todayStart; day = day.plus({ days: 1 })) {
    if (isTaskScheduledOnDate(habit, day, timezone) &&
        (counts.get(day.toISODate()!) ?? 0) < (habit.targetCompletions ?? 1)) missed.push(day)
  }
  return missed
}

export function getTaskProgress(habit: Habit, timezone: string): number {
  if (habit.schedule?.type === 'afterCompletion') {
    const latest = habit.completions.reduce((maximum, value) => {
      const timestamp = DateTime.fromISO(value, { setZone: true }).toMillis()
      return Number.isFinite(timestamp) ? Math.max(maximum, timestamp) : maximum
    }, 0)
    return getAfterCompletionCycles(habit, timezone, DateTime.fromMillis(latest)).completed.length
  }
  const counts = new Map<string, number>()
  habit.completions.forEach((value, index) => {
    if (!isApprovedCompletion(habit, index)) return
    const day = DateTime.fromISO(value, { setZone: true }).setZone(timezone).toISODate()!
    counts.set(day, (counts.get(day) ?? 0) + 1)
  })
  return [...counts.values()].filter(count => count >= (habit.targetCompletions ?? 1)).length
}
