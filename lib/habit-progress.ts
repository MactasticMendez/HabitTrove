import { DateTime } from 'luxon'
import type { Habit } from './types'
import { isHabitDue } from './utils'
import { isCountedCompletion } from './task-schedule'
import { getAfterCompletionCycles } from './flexible-schedule'

export function getPerHabitProgress(habit: Habit, today: DateTime, timezone: string, weekStartDay = 1, pausedDates: ReadonlySet<string> = new Set()): {
  streak: number
  weeklyDone: number
  weeklyDue: number
  graceUsed: boolean
} {
  if (habit.schedule?.type === 'anytime') {
    return { streak: 0, weeklyDone: 0, weeklyDue: 0, graceUsed: false }
  }
  const day = today.setZone(timezone).startOf('day')
  const weekStart = day.minus({ days: ((day.weekday % 7) - weekStartDay + 7) % 7 })
  if (habit.schedule?.type === 'afterCompletion') {
    const { completed, nextDue } = getAfterCompletionCycles(habit, timezone, day.endOf('day'))
    const activeCompletions = completed.filter(date => !pausedDates.has(date.toISODate()!))
    const weeklyDone = activeCompletions.filter(date => date >= weekStart).length
    const outstanding = !!nextDue && nextDue <= day && !pausedDates.has(nextDue.toISODate()!) &&
      !pausedDates.has(day.toISODate()!)
    return {
      streak: activeCompletions.filter(date => date >= day.minus({ days: 364 })).length,
      weeklyDone,
      weeklyDue: weeklyDone + (outstanding ? 1 : 0),
      graceUsed: outstanding && nextDue! < day,
    }
  }
  const target = habit.targetCompletions ?? 1
  let weeklyDone = 0
  let weeklyDue = 0
  let streak = 0
  let streakOpen = true
  let graceUsed = false
  let pendingGrace = false
  const counts = new Map<string, number>()
  habit.completions.forEach((timestamp, index) => {
    if (!isCountedCompletion(habit, index)) return
    const date = DateTime.fromISO(timestamp, { setZone: true }).setZone(timezone).toISODate()
    if (date) counts.set(date, (counts.get(date) ?? 0) + 1)
  })

  for (let offset = 0; offset < 365; offset++) {
    if (offset >= 7 && !streakOpen) break
    const date = day.minus({ days: offset })
    if (pausedDates.has(date.toISODate()!)) continue
    const due = isHabitDue({ habit: { ...habit, archived: false }, date, timezone })
    if (!due) continue
    const completed = (counts.get(date.toISODate()!) ?? 0) >= target
    if (date >= weekStart) {
      weeklyDue++
      if (completed) weeklyDone++
    }
    if (!streakOpen) continue
    if (completed) {
      streak++
      if (pendingGrace) {
        graceUsed = true
        pendingGrace = false
      }
    }
    else if (offset === 0 && streak === 0) continue
    else if (!graceUsed && !pendingGrace) pendingGrace = true
    else streakOpen = false
  }
  return { streak, weeklyDone, weeklyDue, graceUsed }
}
