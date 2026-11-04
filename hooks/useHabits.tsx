import { useRef, useState } from 'react'
import { useAtom } from 'jotai'
import { useTranslations } from 'next-intl'
import { habitsAtom, coinsAtom, settingsAtom, usersAtom, habitFreqMapAtom, currentUserAtom } from '@/lib/atoms'
import { recordHabitCompletion, undoHabitCompletion, recordHabitSlip, undoHabitSlip, saveHabitsData, reorderHabitItems, toggleTaskChecklistItem } from '@/app/actions/data'
import { Habit, SafeUser, User } from '@/lib/types'
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
  hasPermission,
  isHabitDueToday,
  isHabitDue,
  uuid
} from '@/lib/utils'
import { ToastAction } from '@/components/ui/toast'
import { Undo2 } from 'lucide-react'


function handlePermissionCheck(
  user: SafeUser | User | undefined,
  resource: 'habit' | 'wishlist' | 'coins',
  action: 'write' | 'interact',
  tCommon: (key: string, values?: Record<string, string | number>) => string
): boolean {
  if (!user) {
    toast({
      title: tCommon("authenticationRequiredTitle"),
      description: tCommon("authenticationRequiredDescription"),
      variant: "destructive",
    })
    return false
  }

  if (!hasPermission(user, resource, action)) {
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
  const inFlight = useRef(new Set<string>())
  const retryRequests = useRef(new Map<string, { requestId: string; timestamp: string }>())
  const [recordingIds, setRecordingIds] = useState<ReadonlySet<string>>(new Set())

  const canRecordHabit = (habit: Habit, date?: DateTime): boolean => {
    if (!currentUser) return false
    if (habit.schedule?.type !== 'anytime') return hasPermission(currentUser, 'habit', 'interact') &&
      (habit.schedule?.type !== 'afterCompletion' || (date ? isHabitDue({ habit, date, timezone: settings.system.timezone }) : isHabitDueToday({ habit, timezone: settings.system.timezone })))
    const assignee = habit.userIds?.[0]
    const policy = habit.schedule.recordingPolicy
    const isMember = assignee === currentUser.id && hasPermission(currentUser, 'habit', 'interact')
    const isManager = !!assignee && !!(currentUser.isAdmin || currentUser.managedUserIds?.includes(assignee))
    return (policy !== 'manager' && isMember) || (policy !== 'member' && isManager)
  }

  const submitHabitCompletion = async (habit: Habit, timestamp: string, photo?: File) => {
    if (!canRecordHabit(habit, DateTime.fromISO(timestamp, { setZone: true }))) {
      toast({ title: tCommon('permissionDeniedTitle'), description: t('recordingNotAllowed'), variant: 'destructive' })
      return
    }
    const requestKey = `${currentUser?.id}:${habit.id}:${habit.userIds?.[0] ?? ''}`
    if (inFlight.current.has(requestKey)) return
    inFlight.current.add(requestKey)
    setRecordingIds(previous => new Set([...previous, habit.id]))
    try {
      const evidence = photo ? new FormData() : undefined
      if (photo) evidence!.set('evidence', photo)
      const anytime = habit.schedule?.type === 'anytime'
      const request = anytime ? retryRequests.current.get(requestKey) ?? { requestId: uuid(), timestamp } : undefined
      if (request) retryRequests.current.set(requestKey, request)
      const result = await recordHabitCompletion(habit.id, request?.timestamp ?? timestamp, evidence,
        request ? { beneficiaryId: habit.userIds?.[0], requestId: request.requestId } : undefined)
      retryRequests.current.delete(requestKey)
      setHabitsData(previous => ({ habits: previous.habits.map(item => item.id === habit.id ? result.habit : item) }))
      setCoins(result.coins)
      return result
    } finally {
      inFlight.current.delete(requestKey)
      setRecordingIds(previous => new Set([...previous].filter(id => id !== habit.id)))
    }
  }


  const completeHabit = async (habit: Habit, photo?: File) => {
    const timezone = settings.system.timezone
    const today = getTodayInTimezone(timezone)
    const completionsToday = getCompletionsForDate({
      habit, date: today, timezone
    })
    const target = habit.targetCompletions || 1
    if (habit.schedule?.type !== 'anytime' && completionsToday >= target) {
      toast({
        title: t("alreadyCompletedTitle"),
        description: t("alreadyCompletedDescription"),
        variant: "destructive",
      })
      return
    }
    try {
      const result = await submitHabitCompletion(habit, d2t({ dateTime: getNow({ timezone }) }), photo)
      if (!result) return
      const updatedHabits = habitsData.habits.map(item => item.id === habit.id ? result.habit : item)
      if (result.targetReached) playSound()
      toast({
        title: result.pending ? t('pendingApprovalTitle') : result.targetReached ? t("completedTitle") : t("progressTitle"),
        description: result.pending ? t('pendingApprovalDescription') : result.rewarded
          ? habit.schedule?.type === 'anytime' && habit.userIds?.[0] !== currentUser?.id
            ? t('earnedForMember', { username: usersData.users.find(user => user.id === habit.userIds?.[0])?.username ?? t('assignedMember'), coinReward: result.rewardAmount })
            : t("earnedCoinsDescription", { coinReward: result.rewardAmount })
          : habit.schedule?.type === 'anytime' ? t('actionRecordedDescription')
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

  const logSlip = async (habit: Habit) => {
    if (!handlePermissionCheck(currentUser, 'habit', 'interact', tCommon)) return
    try {
      const result = await recordHabitSlip(habit.id, d2t({ dateTime: getNow({ timezone: settings.system.timezone }) }))
      setHabitsData(previous => ({ habits: previous.habits.map(item => item.id === habit.id ? result.habit : item) }))
      setCoins(result.coins)
      toast({ title: t('slipRecorded'), description: t('slipPenalty', { count: result.penalty }) })
    } catch {
      toast({ title: tCommon('errorTitle'), description: t('slipError'), variant: 'destructive' })
    }
  }

  const undoSlip = async (habit: Habit, slipId: string) => {
    if (!handlePermissionCheck(currentUser, 'habit', 'interact', tCommon)) return
    try {
      const result = await undoHabitSlip(habit.id, slipId)
      setHabitsData(previous => ({ habits: previous.habits.map(item => item.id === habit.id ? result.habit : item) }))
      setCoins(result.coins)
      toast({ title: t('slipUndone') })
    } catch {
      toast({ title: tCommon('errorTitle'), description: t('slipError'), variant: 'destructive' })
    }
  }

  const undoComplete = async (habit: Habit, selectedIndex?: number, selectedTimestamp?: string) => {
    const anytimeManager = habit.schedule?.type === 'anytime' && currentUser &&
      (currentUser.isAdmin || currentUser.managedUserIds?.includes(habit.userIds?.[0] ?? ''))
    if (!anytimeManager && !handlePermissionCheck(currentUser, 'habit', 'interact', tCommon)) return
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
      setHabitsData(previous => ({ habits: previous.habits.map(item => item.id === habit.id ? result.habit : item) }))
      setCoins(result.coins)
      const undoneDate = t2d({ timestamp, timezone })
      toast({
        title: t("completionUndoneTitle"),
        description: habit.schedule?.type === 'anytime' ? t('actionUndoneDescription') : t("completionUndoneDescription", {
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
      createdBy: storedHabit ? storedHabit.createdBy : currentUser?.id,
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

  const toggleChecklistItem = async (habitId: string, itemId: string, completed: boolean) => {
    if (!handlePermissionCheck(currentUser, 'habit', 'interact', tCommon)) return
    try {
      const updated = await toggleTaskChecklistItem(habitId, itemId, completed)
      setHabitsData(previous => ({ habits: previous.habits.map(item => item.id === habitId ? updated : item) }))
    } catch {
      toast({ title: tCommon('errorTitle'), description: t('checklistUpdateFailed'), variant: 'destructive' })
    }
  }

  const deleteHabit = async (id: string) => {
    if (!handlePermissionCheck(currentUser, 'habit', 'write', tCommon)) return
    const updatedHabits = habitsData.habits.filter(h => h.id !== id)
    await saveHabitsData({ habits: updatedHabits })
    setHabitsData({ habits: updatedHabits })
    return updatedHabits
  }

  const completePastHabit = async (habit: Habit, date: DateTime, photo?: File) => {
    const timezone = settings.system.timezone
    const dateKey = getISODate({ dateTime: date, timezone })

    // Check if already completed on this date
    const completionsOnDate = getCompletionsForDate({ habit, date, timezone })
    const target = habit.targetCompletions || 1

    if (habit.schedule?.type !== 'anytime' && completionsOnDate >= target) {
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
      const result = await submitHabitCompletion(habit, completionTimestamp, photo)
      if (!result) return
      const updatedHabits = habitsData.habits.map(item => item.id === habit.id ? result.habit : item)
      toast({
        title: result.pending ? t('pendingApprovalTitle') : result.targetReached ? t("completedTitle") : t("progressTitle"),
        description: result.pending ? t('pendingApprovalDescription') : result.rewarded
          ? habit.schedule?.type === 'anytime' && habit.userIds?.[0] !== currentUser?.id
            ? t('earnedForMember', { username: usersData.users.find(user => user.id === habit.userIds?.[0])?.username ?? t('assignedMember'), coinReward: result.rewardAmount })
            : t("earnedCoinsPastDateDescription", { coinReward: result.rewardAmount, dateKey })
          : habit.schedule?.type === 'anytime' ? t('actionRecordedDescription')
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
    canRecordHabit,
    isRecording: (habitId: string) => recordingIds.has(habitId),
    completeHabit,
    logSlip,
    undoSlip,
    undoComplete,
    saveHabit,
    reorderHabits,
    toggleChecklistItem,
    deleteHabit,
    completePastHabit,
    archiveHabit,
    unarchiveHabit,
    habitFreqMap,
  }
}
