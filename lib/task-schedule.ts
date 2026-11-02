import { DateTime } from 'luxon'
import type { Habit } from './types'

export function isCountedCompletion(habit: Habit, index: number): boolean {
  return habit.completionRecords?.[index]?.approval !== 'rejected'
}

export function isApprovedCompletion(habit: Habit, index: number): boolean {
  const approval = habit.completionRecords?.[index]?.approval
  return approval !== 'rejected' && approval !== 'pending'
}

export function isTaskScheduledOnDate(habit: Habit, date: DateTime, timezone: string): boolean {
  if (!habit.isTask) return false
  const anchor = DateTime.fromISO(habit.frequency, { setZone: true }).setZone(timezone).startOf('day')
  const day = date.setZone(timezone).startOf('day')
  if (!anchor.isValid || day < anchor) return false
  if (!habit.taskRepeat) return day.hasSame(anchor, 'day')

  if (habit.taskRepeat === 'daily') return true
  if (habit.taskRepeat === 'weekly') return Math.round(day.diff(anchor, 'days').days) % 7 === 0
  if (habit.taskRepeat === 'monthly') {
    return day.day === Math.min(anchor.day, day.daysInMonth ?? 31)
  }
  return day.month === anchor.month && day.day === Math.min(anchor.day, day.daysInMonth ?? 31)
}

export function getTaskMissedDates(habit: Habit, today: DateTime, timezone: string): DateTime[] {
  if (!habit.isTask || habit.archived) return []
  if (!habit.taskRepeat && habit.completions.some((_, index) => isCountedCompletion(habit, index))) return []
  const todayStart = today.setZone(timezone).startOf('day')
  const anchor = DateTime.fromISO(habit.frequency, { setZone: true }).setZone(timezone).startOf('day')
  if (!anchor.isValid || anchor >= todayStart) return []
  const start = anchor > todayStart.minus({ days: 365 }) ? anchor : todayStart.minus({ days: 365 })
  const completedDays = new Set(habit.completions.flatMap((value, index) =>
    isCountedCompletion(habit, index)
      ? [DateTime.fromISO(value, { setZone: true }).setZone(timezone).toISODate()]
      : []))
  const missed: DateTime[] = []
  for (let day = start; day < todayStart; day = day.plus({ days: 1 })) {
    if (isTaskScheduledOnDate(habit, day, timezone) && !completedDays.has(day.toISODate())) missed.push(day)
  }
  return missed
}

export function getTaskProgress(habit: Habit): number {
  return habit.completions.reduce((count, _, index) => count + Number(isApprovedCompletion(habit, index)), 0)
}
