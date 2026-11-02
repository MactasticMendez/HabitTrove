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
  const todayStart = today.setZone(timezone).startOf('day')
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
  const counts = new Map<string, number>()
  habit.completions.forEach((value, index) => {
    if (!isApprovedCompletion(habit, index)) return
    const day = DateTime.fromISO(value, { setZone: true }).setZone(timezone).toISODate()!
    counts.set(day, (counts.get(day) ?? 0) + 1)
  })
  return [...counts.values()].filter(count => count >= (habit.targetCompletions ?? 1)).length
}
