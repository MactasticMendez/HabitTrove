import { Habit, User } from '@/lib/types'
import { useAtom } from 'jotai'
import { settingsAtom, pomodoroAtom, browserSettingsAtom, usersAtom, currentUserAtom } from '@/lib/atoms'
import { getCompletionsForToday, getNow, getUndoableCompletionIndex, isTaskOverdue, convertMachineReadableFrequencyToHumanReadable } from '@/lib/utils'
import { getTaskMissedDates, getTaskProgress, isCountedCompletion } from '@/lib/task-schedule'
import { getPerHabitProgress } from '@/lib/habit-progress'
import { getNextAfterCompletionDate } from '@/lib/flexible-schedule'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Coins, Edit, Check, Undo2, MoreVertical, Pin } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useEffect, useState } from 'react'
import { useHabits } from '@/hooks/useHabits'
import { useTranslations } from 'next-intl'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'
import { hasPermission } from '@/lib/utils'
import { HabitContextMenuItems } from './HabitContextMenuItems'
import DrawingDisplay from './DrawingDisplay'
import { DateTime } from 'luxon'

interface HabitItemProps {
  habit: Habit
  compact?: boolean
  onEdit: () => void
  onDelete: () => void
}

const renderUserAvatars = (habit: Habit, currentUser: User | null, usersData: { users: User[] }) => {
  if (!habit.userIds || habit.userIds.length <= 1) return null;

  return (
    <div className="flex -space-x-2 ml-2 flex-shrink-0">
      {habit.userIds?.filter((u) => u !== currentUser?.id).map(userId => {
        const user = usersData.users.find(u => u.id === userId)
        if (!user) return null
        return (
          <Avatar key={user.id} className="h-6 w-6">
            <AvatarImage src={user?.avatarPath && `/api/avatars/${user.avatarPath.split('/').pop()}` || ""} />
            <AvatarFallback>{user.username[0]}</AvatarFallback>
          </Avatar>
        )
      })}
    </div>
  );
};


export default function HabitItem({ habit, compact = false, onEdit, onDelete }: HabitItemProps) {
  const { completeHabit, completePastHabit, undoComplete, toggleChecklistItem, logSlip, undoSlip, canRecordHabit, isRecording } = useHabits()
  const [settings] = useAtom(settingsAtom)
  const [_, setPomo] = useAtom(pomodoroAtom)
  const completionsToday = getCompletionsForToday({ habit, timezone: settings.system.timezone })
  const target = habit.targetCompletions || 1
  const anytime = habit.schedule?.type === 'anytime'
  const isCompletedToday = !anytime && completionsToday >= target
  const [isHighlighted, setIsHighlighted] = useState(false)
  const [photo, setPhoto] = useState<File | undefined>()
  const [photoError, setPhotoError] = useState('')
  const [busy, setBusy] = useState(false)
  const t = useTranslations('HabitItem');
  const [usersData] = useAtom(usersAtom)
  const [currentUser] = useAtom(currentUserAtom)
  const canWrite = hasPermission(currentUser, 'habit', 'write')
  const canInteract = hasPermission(currentUser, 'habit', 'interact')
  const canRecord = canRecordHabit(habit)
  const canUndoAction = canInteract || anytime && !!currentUser &&
    !!(currentUser.isAdmin || currentUser.managedUserIds?.includes(habit.userIds?.[0] ?? ''))
  const undoIndex = getUndoableCompletionIndex(habit, currentUser?.id, getNow({ timezone: settings.system.timezone }), settings.system.timezone)
  const canUndo = completionsToday > 0 && undoIndex >= 0
  const [browserSettings] = useAtom(browserSettingsAtom)
  const isTasksView = browserSettings.viewType === 'tasks'
  const isRecurRule = !habit.isTask
  const today = DateTime.now().setZone(settings.system.timezone)
  const missedDates = habit.isTask ? getTaskMissedDates(habit, today, settings.system.timezone) : []
  const progress = getPerHabitProgress(habit, today, settings.system.timezone, settings.system.weekStartDay,
    new Set(currentUser?.statusDays?.map(day => day.date) ?? []))
  const pendingToday = habit.completions.some((timestamp, index) =>
    isCountedCompletion(habit, index) && habit.completionRecords?.[index]?.approval === 'pending' &&
    DateTime.fromISO(timestamp).setZone(settings.system.timezone).hasSame(today, 'day'))
  const slipToday = habit.slips?.find(slip => DateTime.fromISO(slip.timestamp).setZone(settings.system.timezone).hasSame(today, 'day'))
  const negativeOwner = !habit.isNegative || habit.userIds?.[0] === currentUser?.id
  const nextDue = habit.schedule?.type === 'afterCompletion'
    ? getNextAfterCompletionDate(habit, settings.system.timezone) : null
  const frequencyLabel = habit.schedule?.type === 'anytime' ? t('anytimeSchedule')
    : habit.schedule?.type === 'afterCompletion' ? t(nextDue ? 'afterCompletionSchedule' : 'afterCompletionScheduleEnded', {
      interval: habit.schedule.interval, unit: t(`scheduleUnit_${habit.schedule.unit}`, { count: habit.schedule.interval }),
      next: nextDue ? nextDue.setLocale(settings.system.language).toLocaleString(DateTime.DATE_MED) : t('scheduleEnded'),
    }) : convertMachineReadableFrequencyToHumanReadable({
      frequency: habit.frequency, isRecurRule, timezone: settings.system.timezone,
    })

  const submitCompletion = async (date?: DateTime) => {
    setBusy(true)
    try {
      const result = date ? await completePastHabit(habit, date, photo) : await completeHabit(habit, photo)
      if (result) setPhoto(undefined)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const highlightId = params.get('highlight')

    if (highlightId === habit.id) {
      setIsHighlighted(true)
      // Scroll the element into view after a short delay to ensure rendering
      setTimeout(() => {
        const element = document.getElementById(`habit-${habit.id}`)
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
      }, 100)
      // Remove highlight after animation
      const timer = setTimeout(() => setIsHighlighted(false), 2000)
      return () => clearTimeout(timer)
    }
  }, [habit.id])

  return (
    <Card
      id={`habit-${habit.id}`}
      className={`transition-all duration-500 ${compact ? 'grid grid-cols-1 items-center gap-x-4 text-sm md:grid-cols-2 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32rem]' : 'h-full flex flex-col'} ${isHighlighted ? 'bg-yellow-100 dark:bg-yellow-900' : ''} ${habit.archived ? 'opacity-75' : ''}`}
    >
      <CardHeader className={compact ? 'min-w-0 p-2' : 'flex-shrink-0'}>
        <div className="flex justify-between items-start">
          <CardTitle className={`line-clamp-1 ${habit.archived ? 'text-gray-400 dark:text-gray-500' : ''} flex items-center ${isTasksView ? 'w-full' : ''} justify-between`}>
            <div className="flex items-center gap-1">
              {habit.pinned && (
                <Pin className="h-4 w-4 text-yellow-500" />
              )}
              <span>{habit.name}</span>
            </div>
            {isTaskOverdue(habit, settings.system.timezone) && (
              <span className="ml-2 inline-flex items-center rounded-md bg-red-50 dark:bg-red-900/30 px-2 py-1 text-xs font-medium text-red-700 dark:text-red-400 ring-1 ring-inset ring-red-600/10 dark:ring-red-500/20">
                {t('overdue')}
              </span>
            )}
          </CardTitle>
          {renderUserAvatars(habit, currentUser as User, usersData)}
        </div>
        {!compact && (habit.description || habit.drawing) && (
          <div className={`flex gap-4 mt-2 ${!habit.description ? 'justify-end' : ''}`}>
            {habit.description && (
              <CardDescription className={`whitespace-pre-line flex-1 min-w-0 break-words ${habit.archived ? 'text-gray-400 dark:text-gray-500' : ''}`}>
                {habit.description}
              </CardDescription>
            )}
            {habit.drawing && (
              <div className="flex-shrink-0">
                <DrawingDisplay 
                  drawingData={habit.drawing} 
                  width={120} 
                  height={80}
                  className=""
                />
              </div>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className={compact ? 'min-w-0 p-2' : 'flex-grow flex flex-col justify-end'}>
        <div className={compact ? '' : 'mt-auto'}>
          <p className={`text-sm ${compact ? 'line-clamp-1' : ''} ${habit.archived ? 'text-gray-400 dark:text-gray-500' : 'text-gray-500'}`}>
            {t('whenLabel', {
              frequency: frequencyLabel
            })}
          </p>
          <div className={`flex items-center ${compact ? 'mt-0.5' : 'mt-2'}`}>
            <Coins className={`h-4 w-4 mr-1 ${habit.archived ? 'text-gray-400 dark:text-gray-500' : 'text-yellow-400'}`} />
            <span className={`text-sm font-medium ${habit.archived ? 'text-gray-400 dark:text-gray-500' : ''}`}>{t(habit.isNegative ? 'coinsPerAvoidance' : 'coinsPerCompletion', { count: habit.coinReward })}</span>
          </div>
          {habit.isNegative && <p className="text-xs text-muted-foreground">{t('coinsPerSlip', { count: habit.coinPenalty ?? 0 })}</p>}
          {habit.taskRepeat && <p className="text-xs text-muted-foreground">{t('taskProgress', { count: getTaskProgress(habit, settings.system.timezone), goal: habit.taskGoalOccurrences ?? '∞' })}</p>}
          {anytime && <p className="text-xs text-muted-foreground">{t('actionsToday', { count: completionsToday })}</p>}
          {anytime && !canRecord && <p className="text-xs text-muted-foreground">{t(habit.schedule?.type === 'anytime' && habit.schedule.recordingPolicy === 'manager' ? 'managerRecords' : 'memberRecords')}</p>}
          {!habit.isTask && !anytime && <p className="text-xs text-muted-foreground">{t('streakAndWeek', { streak: progress.streak, done: progress.weeklyDone, due: progress.weeklyDue })}</p>}
          {!habit.isTask && !anytime && progress.graceUsed && <p className="text-xs text-amber-700 dark:text-amber-300">{t('graceUsed')}</p>}
          {pendingToday && <p className="text-xs text-amber-700 dark:text-amber-300">{t('pendingApproval')}</p>}
          {habit.checklist && habit.checklist.length > 0 && <div className="mt-2 space-y-1">
            <p className="text-xs text-muted-foreground">{t('checklistProgress', { done: habit.checklist.filter(item => item.completed).length, total: habit.checklist.length })}</p>
            {habit.checklist.map(item => <label key={item.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={item.completed} disabled={!canInteract || habit.archived || busy}
                onChange={event => toggleChecklistItem(habit.id, item.id, event.target.checked)} />
              <span className={item.completed ? 'line-through text-muted-foreground' : ''}>{item.text}</span>
            </label>)}
          </div>}
          {habit.requiresApproval && !habit.archived && <label className="mt-2 block text-xs">
            {t('evidenceLabel')}
            <input type="file" accept="image/jpeg,image/png,image/webp" className="mt-1 block w-full text-xs"
              disabled={!canRecord || busy || isRecording(habit.id)}
              onChange={event => {
                const file = event.target.files?.[0]
                const invalid = file && (file.size > 2_000_000 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
                setPhotoError(invalid ? t('invalidPhoto') : '')
                setPhoto(invalid ? undefined : file)
              }} />
          </label>}
          {photoError && <p role="alert" className="text-xs text-destructive">{photoError}</p>}
        </div>
      </CardContent>
      <CardFooter className={compact ? 'min-w-0 flex-wrap justify-between gap-2 p-2 md:col-span-2 2xl:col-span-1' : 'flex-shrink-0 flex flex-wrap justify-between gap-2'}>
        <div className="flex gap-2">
          <div className="relative">
            <Button
              variant={isCompletedToday ? "secondary" : "default"}
              size="sm"
              onClick={() => submitCompletion()}
              aria-label={anytime ? t('recordActionFor', { name: habit.name }) : undefined}
              disabled={!canRecord || !negativeOwner || habit.archived || busy || isRecording(habit.id) || !!photoError || !!slipToday || isCompletedToday}
              className={`overflow-hidden w-24 ${compact ? 'sm:w-36' : 'sm:w-auto'} ${habit.archived ? 'cursor-not-allowed' : ''}`}
            >
              <Check className="h-4 w-4 sm:mr-2" />
              <span>
                {anytime ? <><span className="sm:hidden">{t('recordActionButtonMobile')}</span><span className="hidden sm:inline">{t('recordActionButton')}</span></> : isCompletedToday ? (
                  target > 1 ? (
                    <>
                      <span className="sm:hidden">{t('completedStatusCountMobile', { completed: completionsToday, target })}</span>
                      <span className="hidden sm:inline">{t('completedStatusCount', { completed: completionsToday, target })}</span>
                    </>
                  ) : (
                    t(habit.isNegative ? 'avoidedStatus' : 'completedStatus')
                  )
                ) : (
                  target > 1 ? (
                    <>
                      <span className="sm:hidden">{t('completeButtonCountMobile', { completed: completionsToday, target })}</span>
                      <span className="hidden sm:inline">{t('completeButtonCount', { completed: completionsToday, target })}</span>
                    </>
                    ) : t(habit.isNegative ? 'avoidButton' : 'completeButton')
                )}
              </span>
              {!anytime && habit.targetCompletions && habit.targetCompletions > 1 && (
                <div
                  className="absolute bottom-0 left-0 h-1 bg-white/50"
                  style={{
                    width: `${(completionsToday / target) * 100}%`
                  }}
                />
              )}
            </Button>
          </div>
          {habit.isNegative && <Button type="button" variant="outline" size="sm"
            disabled={!canInteract || !negativeOwner || habit.archived || busy || isCompletedToday || !!slipToday}
            aria-label={t('logSlipFor', { name: habit.name })}
            onClick={() => void logSlip(habit)}>{t(slipToday ? 'slipLogged' : 'logSlip')}</Button>}
          {habit.isNegative && slipToday && <Button type="button" variant="outline" size="sm"
            disabled={!canInteract || !negativeOwner || busy} onClick={() => void undoSlip(habit, slipToday.id)}
            aria-label={t('undoSlipFor', { name: habit.name })}>{t('undoSlip')}</Button>}
          {missedDates.length > 0 && !habit.archived && <Button type="button" variant="outline" size="sm"
            disabled={!canInteract || busy || !!photoError} onClick={() => submitCompletion(missedDates[0])}
            aria-label={t('catchUpDate', { date: missedDates[0].toISODate() ?? '' })}>
            {t('catchUp')}
          </Button>}
          {(canUndo || compact) && (
            <div className={compact ? `${canUndo ? 'w-10' : 'hidden'} sm:block sm:w-24` : ''}>
              {canUndo && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`${t('undoButton')}: ${habit.name}`}
                  onClick={async () => await undoComplete(habit)}
                  disabled={!canUndoAction || busy || isRecording(habit.id)}
                  className={compact ? 'w-full' : 'w-10 sm:w-auto'}
                >
                  <Undo2 className="h-4 w-4" />
                  <span className="hidden sm:inline ml-2">{t('undoButton')}</span>
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {!habit.archived && (
            <Button
              variant="edit"
              size="sm"
              onClick={onEdit}
              disabled={!canWrite}
              className="hidden sm:flex"
            >
              <Edit className="h-4 w-4" />
              <span className="ml-2">{t('editButton')}</span>
            </Button>
          )}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label={t('moreActions', { name: habit.name })}>
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <HabitContextMenuItems
                habit={habit}
                onEditRequest={onEdit}
                onDeleteRequest={onDelete}
                context="habit-item"
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardFooter>
    </Card>
  )
}
