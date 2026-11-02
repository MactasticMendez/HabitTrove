import { useAtom, atom } from 'jotai'
import { useTranslations } from 'next-intl'
import { habitsAtom, coinsAtom, settingsAtom, usersAtom, habitFreqMapAtom, currentUserAtom } from '@/lib/atoms'
import { recordHabitCompletion, undoHabitCompletion, saveHabitsData, reorderHabitItems } from '@/app/actions/data'
import { Habit, Permission, SafeUser, User } from '@/lib/types'
import { toast } from '@/hooks/use-toast'
import { DateTime } from 'luxon'
import {
  getNowInMilliseconds,
  getTodayInTimezone,
  isSameDate,
  getUndoableCompletionIndex,
  t2d,
  d2t,
  getNow,
  getCompletionsForDate,
  getISODate,
  d2s,
  playSound,
  checkPermission
} from '@/lib/utils'
import { ToastAction } from '@/components/ui/toast'
import { Undo2 } from 'lucide-react'


function handlePermissionCheck(
  user: SafeUser | User | undefined,
  resource: 'habit' | 'wishlist' | 'coins',
  action: 'write' | 'interact',
  tCommon: (key: string, values?: Record<string, any>) => string
): boolean {
  if (!user) {
    toast({
      title: tCommon("authenticationRequiredTitle"),
      description: tCommon("authenticationRequiredDescription"),
      variant: "destructive",
    })
    return false
  }

  if (!user.isAdmin && !checkPermission(user.permissions, resource, action)) {
    toast({
      title: tCommon("permissionDeniedTitle"),
      description: tCommon("permissionDeniedDescription", { action, resource }),
      variant: "destructive",
    })
    return false
  }

  return true
}


export function useHabits() {
  const t = useTranslations('useHabits');
  const tCommon = useTranslations('Common');
  const [usersData] = useAtom(usersAtom)
  const [currentUser] = useAtom(currentUserAtom)
  const [habitsData, setHabitsData] = useAtom(habitsAtom)
  const [, setCoins] = useAtom(coinsAtom)
  const [settings] = useAtom(settingsAtom)
  const [habitFreqMap] = useAtom(habitFreqMapAtom)

  const completeHabit = async (habit: Habit) => {
    if (!handlePermissionCheck(currentUser, 'habit', 'interact', tCommon)) return
    const timezone = settings.system.timezone
    const today = getTodayInTimezone(timezone)
    const completionsToday = getCompletionsForDate({
      habit, date: today, timezone
    })
    const target = habit.targetCompletions || 1
    if (completionsToday >= target) {
      toast({
        title: t("alreadyCompletedTitle"),
        description: t("alreadyCompletedDescription"),
        variant: "destructive",
      })
      return
    }
    try {
      const result = await recordHabitCompletion(habit.id, d2t({ dateTime: getNow({ timezone }) }))
      const updatedHabits = habitsData.habits.map(item => item.id === habit.id ? result.habit : item)
      setHabitsData({ habits: updatedHabits })
      setCoins(result.coins)
      if (result.targetReached) playSound()
      toast({
        title: result.targetReached ? t("completedTitle") : t("progressTitle"),
        description: result.rewarded
          ? t("earnedCoinsDescription", { coinReward: habit.coinReward })
          : t("progressDescription", { count: completionsToday + 1, target }),
        action: <ToastAction altText={tCommon('undoButton')} className="gap-2"
          onClick={() => undoComplete(result.habit, result.completionIndex, result.completionTimestamp)}>
          <Undo2 className="h-4 w-4" />{tCommon('undoButton')}
        </ToastAction>
      })
      return { updatedHabits, newBalance: result.coins.balance, newTransactions: result.coins.transactions }
    } catch {
      toast({ title: tCommon('errorTitle'), description: tCommon('permissionDeniedDescription', { action: 'interact', resource: 'habit' }), variant: 'destructive' })
    }
  }

  const undoComplete = async (habit: Habit, selectedIndex?: number, selectedTimestamp?: string) => {
    if (!handlePermissionCheck(currentUser, 'habit', 'interact', tCommon)) return
    const timezone = settings.system.timezone
    const today = t2d({ timestamp: getTodayInTimezone(timezone), timezone })
    const index = selectedIndex ?? getUndoableCompletionIndex(habit, currentUser?.id, today, timezone)
    const timestamp = selectedTimestamp ?? habit.completions[index]
    if (index < 0 || !timestamp) {
      toast({
        title: t("noCompletionsToUndoTitle"),
        description: t("noCompletionsToUndoDescription"),
        variant: "destructive",
      })
      return
    }
    try {
      const result = await undoHabitCompletion(habit.id, index, timestamp)
      const updatedHabits = habitsData.habits.map(item => item.id === habit.id ? result.habit : item)
      setHabitsData({ habits: updatedHabits })
      setCoins(result.coins)
      const undoneDate = t2d({ timestamp, timezone })
      toast({
        title: t("completionUndoneTitle"),
        description: t("completionUndoneDescription", {
          count: getCompletionsForDate({ habit: result.habit, date: undoneDate, timezone }),
          target: habit.targetCompletions || 1
        }),
        action: <ToastAction altText={tCommon('redoButton')}
          onClick={() => isSameDate(undoneDate, today)
            ? completeHabit(result.habit) : completePastHabit(result.habit, undoneDate)}>
          <Undo2 className="h-4 w-4" />{tCommon('redoButton')}
        </ToastAction>
      })
      return { updatedHabits, newBalance: result.coins.balance, newTransactions: result.coins.transactions }
    } catch {
      toast({ title: tCommon('errorTitle'), description: tCommon('permissionDeniedDescription', { action: 'interact', resource: 'habit' }), variant: 'destructive' })
    }
  }

  const saveHabit = async (habit: Omit<Habit, 'id'> & { id?: string }) => {
    if (!handlePermissionCheck(currentUser, 'habit', 'write', tCommon)) return
    const storedHabit = habitsData.habits.find(item => item.id === habit.id)
    const newHabit = {
      ...storedHabit,
      ...habit,
      id: habit.id || getNowInMilliseconds().toString(),
      position: storedHabit?.position ?? (habit.id ? habit.position :
        Math.max(-1, ...habitsData.habits.filter(item => Boolean(item.isTask) === Boolean(habit.isTask))
          .map((item, index) => item.position ?? index)) + 1),
      ...(storedHabit?.completionRecords && { completionRecords: storedHabit.completionRecords }),
    }
    const updatedHabits = habit.id
      ? habitsData.habits.map(h => h.id === habit.id ? newHabit : h)
      : [...habitsData.habits, newHabit]

    await saveHabitsData({ habits: updatedHabits })
    setHabitsData({ habits: updatedHabits })
    return updatedHabits
  }

  const reorderHabits = async (orderedIds: string[], isTask: boolean) => {
    if (!handlePermissionCheck(currentUser, 'habit', 'write', tCommon)) return
    const updated = await reorderHabitItems(orderedIds, isTask)
    setHabitsData(updated)
  }

  const deleteHabit = async (id: string) => {
    if (!handlePermissionCheck(currentUser, 'habit', 'write', tCommon)) return
    const updatedHabits = habitsData.habits.filter(h => h.id !== id)
    await saveHabitsData({ habits: updatedHabits })
    setHabitsData({ habits: updatedHabits })
    return updatedHabits
  }

  const completePastHabit = async (habit: Habit, date: DateTime) => {
    if (!handlePermissionCheck(currentUser, 'habit', 'interact', tCommon)) return
    const timezone = settings.system.timezone
    const dateKey = getISODate({ dateTime: date, timezone })

    // Check if already completed on this date
    const completionsOnDate = habit.completions.filter(completion =>
      isSameDate(t2d({ timestamp: completion, timezone }), date)
    ).length
    const target = habit.targetCompletions || 1

    if (completionsOnDate >= target) {
      toast({
        title: t("alreadyCompletedPastDateTitle"),
        description: t("alreadyCompletedPastDateDescription", { dateKey: d2s({ dateTime: date, timezone, format: 'yyyy-MM-dd' }) }),
        variant: "destructive",
      })
      return
    }

    // Use current time but with the past date
    const now = getNow({ timezone })
    const completionDateTime = date.set({
      hour: now.hour,
      minute: now.minute,
      second: now.second,
      millisecond: now.millisecond
    })
    const completionTimestamp = d2t({ dateTime: completionDateTime })
    try {
      const result = await recordHabitCompletion(habit.id, completionTimestamp)
      const updatedHabits = habitsData.habits.map(item => item.id === habit.id ? result.habit : item)
      setHabitsData({ habits: updatedHabits })
      setCoins(result.coins)
      toast({
        title: result.targetReached ? t("completedTitle") : t("progressTitle"),
        description: result.rewarded
          ? t("earnedCoinsPastDateDescription", { coinReward: habit.coinReward, dateKey })
          : t("progressPastDateDescription", { count: completionsOnDate + 1, target, dateKey }),
        action: <ToastAction altText={tCommon('undoButton')} className="gap-2"
          onClick={() => undoComplete(result.habit, result.completionIndex, result.completionTimestamp)}>
          <Undo2 className="h-4 w-4" />{tCommon('undoButton')}
        </ToastAction>
      })
      return { updatedHabits, newBalance: result.coins.balance, newTransactions: result.coins.transactions }
    } catch {
      toast({ title: tCommon('errorTitle'), description: tCommon('permissionDeniedDescription', { action: 'interact', resource: 'habit' }), variant: 'destructive' })
    }
  }

  const archiveHabit = async (id: string) => {
    if (!handlePermissionCheck(currentUser, 'habit', 'write', tCommon)) return
    const updatedHabits = habitsData.habits.map(h =>
      h.id === id ? { ...h, archived: true } : h
    )
    await saveHabitsData({ habits: updatedHabits })
    setHabitsData({ habits: updatedHabits })
  }

  const unarchiveHabit = async (id: string) => {
    if (!handlePermissionCheck(currentUser, 'habit', 'write', tCommon)) return
    const updatedHabits = habitsData.habits.map(h =>
      h.id === id ? { ...h, archived: false } : h
    )
    await saveHabitsData({ habits: updatedHabits })
    setHabitsData({ habits: updatedHabits })
  }

  return {
    completeHabit,
    undoComplete,
    saveHabit,
    reorderHabits,
    deleteHabit,
    completePastHabit,
    archiveHabit,
    unarchiveHabit,
    habitFreqMap,
  }
}
