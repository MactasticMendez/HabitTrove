import { Circle, Coins, ArrowRight, CircleCheck, ChevronDown, ChevronUp, Plus, Pin, AlertTriangle, Flame } from 'lucide-react'
import CompletionCountBadge from './CompletionCountBadge'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { cn } from '@/lib/utils'
import Link from 'next/link'
import { useState } from 'react'
import { useAtom } from 'jotai'
import { useTranslations } from 'next-intl'
import { pomodoroAtom, settingsAtom, completedHabitsMapAtom, browserSettingsAtom, hasTasksAtom, currentUserAtom } from '@/lib/atoms'
import { getTodayInTimezone, getUndoableCompletionIndex, isSameDate, t2d, d2t, getNow, isHabitDue, isTaskOverdue, getHabitFreq } from '@/lib/utils'
import { isCountedCompletion } from '@/lib/task-schedule'
import { useTodayInTimezone } from '@/hooks/useTodayInTimezone'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Progress } from '@/components/ui/progress'
import { WishlistItemType } from '@/lib/types'
import { Habit } from '@/lib/types'
import Linkify from './linkify'
import { useHabits } from '@/hooks/useHabits'
import AddEditHabitModal from './AddEditHabitModal'
import ConfirmDialog from './ConfirmDialog'
import { Button } from './ui/button'
import { HabitContextMenuItems } from './HabitContextMenuItems'
import DrawingDisplay from './DrawingDisplay'
import { getPerHabitProgress } from '@/lib/habit-progress'
import { DateTime } from 'luxon'

interface UpcomingItemsProps {
  habits: Habit[]
  wishlistItems: WishlistItemType[]
  coinBalance: number
}

interface ItemSectionProps {
  title: string;
  items: Habit[];
  emptyMessage: string;
  isTask: boolean | null;
  viewLink?: string;
  addNewItem: (isTask: boolean) => void;
}

const ItemSection = ({
  title,
  items,
  emptyMessage,
  isTask,
  viewLink,
  addNewItem,
}: ItemSectionProps) => {
  const t = useTranslations('DailyOverview');
  const tHabitItem = useTranslations('HabitItem');
  const { completeHabit, undoComplete, logSlip, undoSlip, saveHabit, deleteHabit, archiveHabit, habitFreqMap, canRecordHabit, isRecording } = useHabits();
  const [_, setPomo] = useAtom(pomodoroAtom);
  const [browserSettings, setBrowserSettings] = useAtom(browserSettingsAtom);
  const [settings] = useAtom(settingsAtom);
  const [currentUser] = useAtom(currentUserAtom);
  const [completedHabitsMap] = useAtom(completedHabitsMapAtom);
  const pausedDates = new Set(currentUser?.statusDays?.map(day => day.date) ?? []);

  const today = getTodayInTimezone(settings.system.timezone);
  const currentTodayCompletions = completedHabitsMap.get(today) || [];
  const currentBadgeType = isTask === null ? null : isTask ? 'tasks' : 'habits';

  const currentExpanded = isTask === null ? browserSettings.expandedToday : isTask ? browserSettings.expandedTasks : browserSettings.expandedHabits;
  const setCurrentExpanded = (value: boolean) => {
    setBrowserSettings(prev => ({
      ...prev,
      [isTask === null ? 'expandedToday' : isTask ? 'expandedTasks' : 'expandedHabits']: value
    }));
  };

  const [isConfirmDeleteDialogOpen, setIsConfirmDeleteDialogOpen] = useState(false);
  const [habitToDelete, setHabitToDelete] = useState<Habit | null>(null);
  const [habitToEdit, setHabitToEdit] = useState<Habit | null>(null);

  const handleDeleteClick = (habit: Habit) => {
    setHabitToDelete(habit);
    setIsConfirmDeleteDialogOpen(true);
  };

  const confirmDelete = async () => {
    if (habitToDelete) {
      await deleteHabit(habitToDelete.id);
      setHabitToDelete(null);
      setIsConfirmDeleteDialogOpen(false);
    }
  };

  const handleEditClick = (habit: Habit) => {
    setHabitToEdit(habit);
  };

  if (items.length === 0) {
    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold">{title}</h3>
          {(isTask === null ? [true, false] : [isTask]).map(task => (
            <Button key={String(task)} variant="ghost" size="sm"
              className="h-7 w-7 rounded-full hover:bg-primary/10 hover:text-primary"
              onClick={() => addNewItem(task)} aria-label={t(task ? 'addTaskButtonLabel' : 'addHabitButtonLabel')}>
              <Plus className="h-4 w-4" />
            </Button>
          ))}
        </div>
        <div className="text-center text-muted-foreground text-sm py-4">
          {emptyMessage}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">{title}</h3>
        </div>
        <div className="flex items-center gap-2">
          {currentBadgeType ? <CompletionCountBadge type={currentBadgeType} /> : (
            <><CompletionCountBadge type="tasks" /><CompletionCountBadge type="habits" /></>
          )}
          {(isTask === null ? [true, false] : [isTask]).map(task => (
            <Button key={String(task)} variant="ghost" size="sm"
              className="h-7 w-7 rounded-full hover:bg-primary/10 hover:text-primary"
              onClick={() => addNewItem(task)} aria-label={t(task ? 'addTaskButtonLabel' : 'addHabitButtonLabel')}>
              <Plus className="h-4 w-4" />
            </Button>
          ))}
        </div>
      </div>
      <ul className={`grid gap-2 transition-all duration-300 ease-in-out ${currentExpanded ? 'max-h-none' : 'max-h-[200px]'} overflow-hidden`}>
        {items
          .sort((a, b) => {
            // First by pinned status
            if (a.pinned !== b.pinned) {
              return a.pinned ? -1 : 1;
            }

            const aStreak = a.isTask ? 0 : getPerHabitProgress(a, getNow({ timezone: settings.system.timezone }), settings.system.timezone, settings.system.weekStartDay, pausedDates).streak
            const bStreak = b.isTask ? 0 : getPerHabitProgress(b, getNow({ timezone: settings.system.timezone }), settings.system.timezone, settings.system.weekStartDay, pausedDates).streak
            if ((aStreak >= 3) !== (bStreak >= 3)) return aStreak >= 3 ? -1 : 1

            // Then by completion status
            const aCompleted = currentTodayCompletions.includes(a);
            const bCompleted = currentTodayCompletions.includes(b);
            if (aCompleted !== bCompleted) {
              return aCompleted ? 1 : -1;
            }

            // Then by frequency (daily first)
            const aFreq = habitFreqMap.get(a.id) || 'daily';
            const bFreq = habitFreqMap.get(b.id) || 'daily';
            const freqOrder = ['daily', 'weekly', 'monthly', 'yearly'];
            if (freqOrder.indexOf(aFreq) !== freqOrder.indexOf(bFreq)) {
              return freqOrder.indexOf(aFreq) - freqOrder.indexOf(bFreq);
            }

            // Then by coin reward (higher first)
            if (a.coinReward !== b.coinReward) {
              return b.coinReward - a.coinReward;
            }

            // Finally by target completions (higher first)
            const aTarget = a.targetCompletions || 1;
            const bTarget = b.targetCompletions || 1;
            return bTarget - aTarget;
          })
          .slice(0, currentExpanded ? undefined : 5)
          .map((habit) => {
            const itemIsTask = Boolean(habit.isTask)
            const anytime = habit.schedule?.type === 'anytime'
            const completionsToday = habit.completions.filter((completion, index) =>
              isCountedCompletion(habit, index) &&
              isSameDate(t2d({ timestamp: completion, timezone: settings.system.timezone }), t2d({ timestamp: d2t({ dateTime: getNow({ timezone: settings.system.timezone }) }), timezone: settings.system.timezone }))
            ).length
            const target = habit.targetCompletions || 1
            const progress = !itemIsTask && !anytime ? getPerHabitProgress(habit, getNow({ timezone: settings.system.timezone }), settings.system.timezone, settings.system.weekStartDay, pausedDates) : null
            const isCompleted = !anytime && (completionsToday >= target || (itemIsTask && habit.archived))
            const undoIndex = getUndoableCompletionIndex(habit, currentUser?.id, getNow({ timezone: settings.system.timezone }), settings.system.timezone)
            const slipToday = habit.slips?.find(slip => DateTime.fromISO(slip.timestamp).setZone(settings.system.timezone).toISODate() === today)
            const canRecordNegative = !habit.isNegative || habit.userIds?.[0] === currentUser?.id
            return (
              <li
                className={`flex items-center justify-between text-sm p-2 rounded-md
                ${isCompleted ? 'bg-secondary/50' : 'bg-secondary/20'}`}
                key={habit.id}
              >
                <span className="flex items-center gap-2 flex-1 min-w-0">
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <div className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                        <div className="flex-shrink-0">
                          <button
                            type="button"
                            aria-label={`${tHabitItem(anytime ? 'recordActionButton' : isCompleted ? 'undoButton' : habit.isNegative ? 'avoidButton' : 'completeButton')}: ${habit.name}`}
                            disabled={!canRecordNegative || !!slipToday || isRecording(habit.id) || (!isCompleted && !canRecordHabit(habit)) || isCompleted && undoIndex < 0}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              if (isCompleted) {
                                undoComplete(habit);
                              } else {
                                completeHabit(habit);
                              }
                            }}
                            className="relative flex h-6 w-6 items-center justify-center rounded hover:opacity-70 transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                          >
                            {anytime ? <Plus className="h-4 w-4" aria-hidden="true" /> : isCompleted ? (
                              <CircleCheck className="h-4 w-4 text-green-500" />
                            ) : (
                              <div className="relative h-4 w-4">
                                <Circle className="absolute h-4 w-4 text-muted-foreground" />
                                <div
                                  className="absolute h-4 w-4 rounded-full overflow-hidden"
                                  style={{
                                    background: `conic-gradient(
                                  currentColor ${(completionsToday / target) * 360}deg,
                                  transparent ${(completionsToday / target) * 360}deg 360deg
                                )`,
                                    mask: 'radial-gradient(transparent 50%, black 51%)',
                                    WebkitMask: 'radial-gradient(transparent 50%, black 51%)'
                                  }}
                                />
                              </div>
                            )}
                          </button>
                        </div>
                        <span className="flex items-center gap-1">
                          {habit.pinned && (
                            <Pin className="h-4 w-4 text-yellow-500" />
                          )}
                          <Link
                            href={`/habits?highlight=${habit.id}`}
                            className="flex items-center gap-1 hover:text-primary transition-colors"
                            onClick={() => {
                              const newViewType = itemIsTask ? 'tasks' : 'habits';
                              if (browserSettings.viewType !== newViewType) {
                                setBrowserSettings(prev => ({ ...prev, viewType: newViewType }));
                              }
                            }}
                          >
                            {itemIsTask && isTaskOverdue(habit, settings.system.timezone) && !isCompleted && (
                              <TooltipProvider>
                                <Tooltip delayDuration={0}>
                                  <TooltipTrigger asChild>
                                    {/* The AlertTriangle itself doesn't need hover styles if the parent Link handles it */}
                                    <AlertTriangle className="h-4 w-4 flex-shrink-0 text-red-600 dark:text-red-500" />
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>{t('overdueTooltip')}</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                            <span
                              className={cn(
                                isCompleted ? 'line-through' : '',
                                'break-all' // Text specific styles
                              )}
                            >
                              {habit.name}
                            </span>
                          </Link>
                          {isTask === null && <Badge variant="outline" className="text-xs">
                            {t(itemIsTask ? 'taskType' : 'habitType')}
                          </Badge>}
                          {habit.drawing && (
                            <div className="ml-2 pr-2">
                              <DrawingDisplay
                                drawingData={habit.drawing}
                                width={40}
                                height={26}
                                className="border-0"
                              />
                            </div>
                          )}
                        </span>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-64">
                      <HabitContextMenuItems
                        habit={habit}
                        onEditRequest={() => handleEditClick(habit)}
                        onDeleteRequest={() => handleDeleteClick(habit)}
                        context="daily-overview"
                      />
                    </ContextMenuContent>
                  </ContextMenu>
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground flex-shrink-0">
                  {habit.isNegative && <button type="button" className="rounded border px-2 py-1 text-foreground"
                    disabled={!canRecordNegative || isCompleted}
                    aria-label={tHabitItem(slipToday ? 'undoSlipFor' : 'logSlipFor', { name: habit.name })}
                    onClick={() => void (slipToday ? undoSlip(habit, slipToday.id) : logSlip(habit))}>
                    {tHabitItem(slipToday ? 'undoSlip' : 'logSlip')}
                  </button>}
                  {anytime && <span>{tHabitItem('actionsToday', { count: completionsToday })}</span>}
                  {anytime && undoIndex >= 0 && <button type="button" className="rounded border px-2 py-1 text-foreground"
                    disabled={isRecording(habit.id)} aria-label={`${tHabitItem('undoButton')}: ${habit.name}`}
                    onClick={() => void undoComplete(habit)}>{tHabitItem('undoButton')}</button>}
                  {progress && <span className="flex items-center gap-1" aria-label={`${t('individualProgress', { streak: progress.streak, done: progress.weeklyDone, due: progress.weeklyDue })}${progress.graceUsed ? `; ${t('graceUsed')}` : ''}`}>
                    {progress.streak >= 3 && <><Flame aria-hidden="true" className="h-3 w-3 text-orange-600" />{progress.streak}</>}
                    {progress.graceUsed && <span className="text-amber-700 dark:text-amber-300">{t('graceUsed')}</span>}
                    <span>{progress.weeklyDone}/{progress.weeklyDue}</span>
                  </span>}
                  {!anytime && habit.targetCompletions && (
                    <span className="bg-secondary px-1.5 py-0.5 rounded-full">
                      {completionsToday}/{target}
                    </span>
                  )}
                  {anytime ? <Badge variant="outline" className="text-xs">{tHabitItem('anytimeSchedule')}</Badge> : habitFreqMap.get(habit.id) !== 'daily' && (
                    <Badge variant="outline" className="text-xs">
                      {habitFreqMap.get(habit.id)}
                    </Badge>
                  )}
                  <span className="flex items-center">
                    <Coins className={cn(
                      "h-3 w-3 mr-1 transition-all",
                      isCompleted
                        ? "text-yellow-500 drop-shadow-[0_0_2px_rgba(234,179,8,0.3)]"
                        : "text-gray-400"
                    )} />
                    <span className={cn(
                      "transition-all",
                      isCompleted
                        ? "text-yellow-500 font-medium"
                        : "text-gray-400"
                    )}>
                      {habit.coinReward}
                    </span>
                  </span>
                </span>
              </li>
            )
          })}
      </ul>
      <div className="flex items-center justify-between">
        <button
          onClick={() => setCurrentExpanded(!currentExpanded)}
          className="text-sm text-muted-foreground hover:text-primary flex items-center gap-1"
        >
          {currentExpanded ? (
            <>
              {t('showLessButton')}
              <ChevronUp className="h-3 w-3" />
            </>
          ) : (
            <>
              {t('showAllButton')}
              <ChevronDown className="h-3 w-3" />
            </>
          )}
        </button>
        {viewLink && <Link
          href={viewLink}
          className="text-sm text-muted-foreground hover:text-primary flex items-center gap-1"
          onClick={() => {
            const newViewType = isTask ? 'tasks' : 'habits';
            if (browserSettings.viewType !== newViewType) {
              setBrowserSettings(prev => ({ ...prev, viewType: newViewType }));
            }
          }}
        >
          {t('viewButton')}
          <ArrowRight className="h-3 w-3" />
        </Link>}
      </div>
      {habitToDelete && (
        <ConfirmDialog
          isOpen={isConfirmDeleteDialogOpen}
          onClose={() => setIsConfirmDeleteDialogOpen(false)}
          onConfirm={confirmDelete}
          title={t(habitToDelete.isTask ? 'deleteTaskDialogTitle' : 'deleteHabitDialogTitle')}
          message={t('confirmDeleteDialogMessage', { name: habitToDelete.name })}
          confirmText={t('deleteButton')}
        />
      )}
      {habitToEdit && (
        <AddEditHabitModal
          onClose={() => setHabitToEdit(null)}
          onSave={async (updatedHabit) => {
            await saveHabit({ ...habitToEdit, ...updatedHabit });
            setHabitToEdit(null);
          }}
          habit={habitToEdit}
          isTask={habitToEdit.isTask || false}
        />
      )}
    </div>
  );
};

export default function DailyOverview({
  habits,
  wishlistItems,
  coinBalance,
}: UpcomingItemsProps) {
  const t = useTranslations('DailyOverview');
  const { completeHabit, undoComplete } = useHabits()
  const [settings] = useAtom(settingsAtom)
  const [completedHabitsMap] = useAtom(completedHabitsMapAtom)
  const [browserSettings, setBrowserSettings] = useAtom(browserSettingsAtom)
  const today = useTodayInTimezone(settings.system.timezone)
  const todayCompletions = completedHabitsMap.get(today) || []
  const { saveHabit } = useHabits()

  const timezone = settings.system.timezone
  const todayDateObj = getNow({ timezone })

  const dailyTasks = habits.filter(habit =>
    habit.isTask &&
    !habit.archived &&
    (!browserSettings.hideNonDaily || !habit.taskRepeat || habit.taskRepeat === 'daily') &&
    (isHabitDue({ habit, timezone, date: todayDateObj }) || isTaskOverdue(habit, timezone))
  )
  const dailyHabits = habits.filter(habit =>
    !habit.isTask &&
    !habit.archived &&
    (!browserSettings.hideNonDaily || habit.schedule?.type !== 'anytime' && getHabitFreq(habit) === 'daily') &&
    isHabitDue({ habit, timezone, date: todayDateObj })
  )

  // Get all wishlist items sorted by redeemable status (non-redeemable first) then by coin cost
  // Filter out archived wishlist items
  const sortedWishlistItems = wishlistItems
    .filter(item => !item.archived)
    .sort((a, b) => {
      const aRedeemable = a.coinCost <= coinBalance
      const bRedeemable = b.coinCost <= coinBalance

      // Non-redeemable items first
      if (aRedeemable !== bRedeemable) {
        return aRedeemable ? 1 : -1
      }

      // Then sort by coin cost (lower cost first)
      return a.coinCost - b.coinCost
    })

  const [hasTasks] = useAtom(hasTasksAtom)
  const [, setPomo] = useAtom(pomodoroAtom)
  const [modalConfig, setModalConfig] = useState<{
    isOpen: boolean,
    isTask: boolean
  }>({
    isOpen: false,
    isTask: false
  });

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>{t('todaysOverviewTitle')}</CardTitle>
          <div role="group" aria-label={t('todayLayoutLabel')} className="flex gap-1">
            <Button type="button" size="sm" variant={browserSettings.hideNonDaily ? 'secondary' : 'outline'}
              aria-pressed={Boolean(browserSettings.hideNonDaily)}
              onClick={() => setBrowserSettings(previous => ({ ...previous, hideNonDaily: !previous.hideNonDaily }))}>
              {t('hideNonDaily')}
            </Button>
            <Button type="button" size="sm" variant={browserSettings.combinedToday ? 'outline' : 'secondary'}
              aria-pressed={!browserSettings.combinedToday}
              onClick={() => setBrowserSettings(previous => ({ ...previous, combinedToday: false }))}>
              {t('separateView')}
            </Button>
            <Button type="button" size="sm" variant={browserSettings.combinedToday ? 'secondary' : 'outline'}
              aria-pressed={Boolean(browserSettings.combinedToday)}
              onClick={() => setBrowserSettings(previous => ({ ...previous, combinedToday: true }))}>
              {t('combinedView')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            {browserSettings.combinedToday ? (
              <ItemSection
                title={t('allDueTodayTitle')}
                items={[...dailyTasks, ...dailyHabits]}
                emptyMessage={t('noItemsDueTodayMessage')}
                isTask={null}
                addNewItem={task => setModalConfig({ isOpen: true, isTask: task })}
              />
            ) : (
              <>
                {hasTasks && (
                  <ItemSection
                    title={t('dailyTasksTitle')}
                    items={dailyTasks}
                    emptyMessage={t('noTasksDueTodayMessage')}
                    isTask={true}
                    viewLink="/habits?view=tasks"
                    addNewItem={task => setModalConfig({ isOpen: true, isTask: task })}
                  />
                )}
                <ItemSection
                  title={t('dailyHabitsTitle')}
                  items={dailyHabits}
                  emptyMessage={t('noHabitsDueTodayMessage')}
                  isTask={false}
                  viewLink="/habits"
                  addNewItem={task => setModalConfig({ isOpen: true, isTask: task })}
                />
              </>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold">{t('wishlistGoalsTitle')}</h3>
                <Badge variant="secondary">
                  {t('redeemableBadgeLabel', {
                    count: wishlistItems.filter(item => item.coinCost <= coinBalance).length,
                    total: wishlistItems.length
                  })}
                </Badge>
              </div>
              <div>
                <div className={`space-y-3 transition-all duration-300 ease-in-out ${browserSettings.expandedWishlist ? 'max-h-none' : 'max-h-[200px]'} overflow-hidden`}>
                  {sortedWishlistItems.length === 0 ? (
                    <div className="text-center text-muted-foreground text-sm py-4">
                      {t('noWishlistItemsMessage')}
                    </div>
                  ) : (
                    <>
                      {sortedWishlistItems
                        .slice(0, browserSettings.expandedWishlist ? undefined : 5)
                        .map((item) => {
                          const isRedeemable = item.coinCost <= coinBalance
                          return (
                            <Link
                              key={item.id}
                              href={`/wishlist?highlight=${item.id}`}
                              className={cn(
                                "block p-3 rounded-md hover:bg-secondary/30 transition-colors",
                                isRedeemable ? 'bg-green-500/10' : 'bg-secondary/20'
                              )}
                            >
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm">
                                    <Linkify>{item.name}</Linkify>
                                  </span>
                                  {item.drawing && (
                                    <DrawingDisplay
                                      drawingData={item.drawing}
                                      width={40}
                                      height={26}
                                      className="border-0"
                                    />
                                  )}
                                </div>
                                <span className="text-xs flex items-center">
                                  <Coins className={cn(
                                    "h-3 w-3 mr-1 transition-all",
                                    isRedeemable
                                      ? "text-yellow-500 drop-shadow-[0_0_2px_rgba(234,179,8,0.3)]"
                                      : "text-gray-400"
                                  )} />
                                  <span className={cn(
                                    "transition-all",
                                    isRedeemable
                                      ? "text-yellow-500 font-medium"
                                      : "text-gray-400"
                                  )}>
                                    {item.coinCost}
                                  </span>
                                </span>
                              </div>
                              <Progress
                                value={(coinBalance / item.coinCost) * 100}
                                className={cn(
                                  "h-2",
                                  isRedeemable ? "bg-green-500/20" : ""
                                )}
                              />
                              <p className="text-xs text-muted-foreground mt-2">
                                {isRedeemable
                                  ? t('readyToRedeemMessage')
                                  : t('coinsToGoMessage', { amount: item.coinCost - coinBalance })
                                }
                              </p>
                            </Link>
                          )
                        })}
                    </>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => setBrowserSettings(prev => ({ ...prev, expandedWishlist: !prev.expandedWishlist }))}
                    className="text-sm text-muted-foreground hover:text-primary flex items-center gap-1"
                  >
                    {browserSettings.expandedWishlist ? (
                      <>
                        {t('showLessButton')}
                        <ChevronUp className="h-3 w-3" />
                      </>
                    ) : (
                      <>
                        {t('showAllButton')}
                        <ChevronDown className="h-3 w-3" />
                      </>
                    )}
                  </button>
                  <Link
                    href="/wishlist"
                    className="text-sm text-muted-foreground hover:text-primary flex items-center gap-1"
                  >
                    {t('viewButton')}
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
      {modalConfig.isOpen && (
        <AddEditHabitModal
          onClose={() => setModalConfig({ isOpen: false, isTask: false })}
          onSave={async (habit) => {
            await saveHabit({ ...habit, isTask: modalConfig.isTask })
            setModalConfig({ isOpen: false, isTask: false });
          }}
          habit={null}
          isTask={modalConfig.isTask}
        />
      )}
    </>
  )
}
