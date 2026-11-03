'use client'

import { useState } from 'react'
import { RRule } from 'rrule'
import { useAtom } from 'jotai'
import { useTranslations } from 'next-intl'
import { settingsAtom, usersAtom, currentUserAtom } from '@/lib/atoms'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { CalendarDays, Brush } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Habit, PersonalFolder } from '@/lib/types'
import EmojiPickerButton from './EmojiPickerButton'
import ModalOverlay from './ModalOverlay' // Import the new component
import DrawingModal from './DrawingModal'
import DrawingDisplay from './DrawingDisplay'
import { checkPermission, convertHumanReadableFrequencyToMachineReadable, convertMachineReadableFrequencyToHumanReadable, d2t, deserializeRRule, fromCalendarPickerDate, serializeRRule, toCalendarPickerDate, uuid } from '@/lib/utils'
import { INITIAL_DUE, INITIAL_RECURRENCE_RULE, QUICK_DATES, MAX_COIN_LIMIT } from '@/lib/constants'
import { DateTime } from 'luxon'


interface AddEditHabitModalProps {
  onClose: () => void
  onSave: (habit: Omit<Habit, 'id'>, folderId?: string) => Promise<void>
  habit?: Habit | null
  isTask: boolean
  folders?: PersonalFolder[]
  folderId?: string
}

const weekdays = [
  { key: 'MO', english: 'Monday' }, { key: 'TU', english: 'Tuesday' },
  { key: 'WE', english: 'Wednesday' }, { key: 'TH', english: 'Thursday' },
  { key: 'FR', english: 'Friday' }, { key: 'SA', english: 'Saturday' },
  { key: 'SU', english: 'Sunday' },
] as const

type SchedulePreset = 'daily' | 'alternate' | 'weekdays' | 'chosenDays' | 'custom'

function initialSchedule(frequency?: string): { preset: SchedulePreset; selectedDays: string[] } {
  if (!frequency) return { preset: 'daily', selectedDays: ['MO'] }
  const rule = deserializeRRule(frequency)
  if (!rule) return { preset: 'custom', selectedDays: ['MO'] }
  if (rule.origOptions.freq === RRule.DAILY && (rule.origOptions.interval ?? 1) === 1) {
    return { preset: 'daily', selectedDays: ['MO'] }
  }
  if (rule.origOptions.freq === RRule.DAILY && (rule.origOptions.interval ?? 1) === 2) {
    return { preset: 'alternate', selectedDays: ['MO'] }
  }
  const selectedDays = Array.isArray(rule.origOptions.byweekday)
    ? rule.origOptions.byweekday.map(String) : []
  if (rule.origOptions.freq === RRule.WEEKLY && selectedDays.length) {
    const isWeekdays = ['MO', 'TU', 'WE', 'TH', 'FR'].every(day => selectedDays.includes(day)) && selectedDays.length === 5
    return { preset: isWeekdays ? 'weekdays' : 'chosenDays', selectedDays }
  }
  return { preset: 'custom', selectedDays: ['MO'] }
}

export default function AddEditHabitModal({ onClose, onSave, habit, isTask, folders, folderId }: AddEditHabitModalProps) {
  const t = useTranslations('AddEditHabitModal');
  const [settings] = useAtom(settingsAtom)
  const [name, setName] = useState(habit?.name || '')
  const [description, setDescription] = useState(habit?.description || '')
  const [coinReward, setCoinReward] = useState(habit?.coinReward ?? 1)
  const [isNegative, setIsNegative] = useState(habit?.isNegative ?? false)
  const [coinPenalty, setCoinPenalty] = useState(habit?.coinPenalty ?? 0)
  const [targetCompletions, setTargetCompletions] = useState(habit?.targetCompletions || 1)
  const [taskRepeat, setTaskRepeat] = useState(habit?.taskRepeat ?? 'none')
  const [taskGoalOccurrences, setTaskGoalOccurrences] = useState(habit?.taskGoalOccurrences ?? 0)
  const [checklist, setChecklist] = useState(habit?.checklist ?? [])
  const [reminderTime, setReminderTime] = useState(habit?.reminderTime ?? '')
  const [requiresApproval, setRequiresApproval] = useState(habit?.requiresApproval ?? false)
  const [approverIds, setApproverIds] = useState<string[]>(habit?.approverIds ?? [])
  const [approverQuery, setApproverQuery] = useState('')
  const [boostMultiplier, setBoostMultiplier] = useState(habit?.coinBoost?.multiplier ?? 1)
  const [boostEndsOn, setBoostEndsOn] = useState(habit?.coinBoost?.until
    ? DateTime.fromISO(habit.coinBoost.until).setZone(settings.system.timezone).toISODate() ?? '' : '')
  const unchangedBoost = habit?.coinBoost?.multiplier === boostMultiplier &&
    boostEndsOn === DateTime.fromISO(habit.coinBoost.until).setZone(settings.system.timezone).toISODate()
  const isRecurRule = !isTask
  // Initialize ruleText with the actual frequency string or default, not the display text
  const initialRuleText = habit?.frequency ? convertMachineReadableFrequencyToHumanReadable({
    frequency: habit.frequency,
    isRecurRule,
    timezone: settings.system.timezone
  }) : (isRecurRule ? INITIAL_RECURRENCE_RULE : INITIAL_DUE);
  const [ruleText, setRuleText] = useState<string>(initialRuleText)
  const initialScheduleChoice = initialSchedule(isRecurRule ? habit?.frequency : undefined)
  const [schedulePreset, setSchedulePreset] = useState<SchedulePreset>(initialScheduleChoice.preset)
  const [selectedWeekdays, setSelectedWeekdays] = useState(initialScheduleChoice.selectedDays)
  const [pickedTaskDate, setPickedTaskDate] = useState<DateTime | null>(null)
  const [currentUser] = useAtom(currentUserAtom)
  const canAssignUser = (userId: string) => !!currentUser && (currentUser.isAdmin ||
    checkPermission(currentUser.permissions, 'habit', 'write') ||
    !!currentUser.managedUserIds?.includes(userId))
  const [includeSelf, setIncludeSelf] = useState(!habit || !!habit.userIds?.includes(currentUser?.id ?? ''))
  const [negativeOwnerId, setNegativeOwnerId] = useState(habit?.userIds?.[0] ?? currentUser?.id ?? '')
  const [isQuickDatesOpen, setIsQuickDatesOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null); // State for validation message
  const [approvalError, setApprovalError] = useState('')
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>((habit?.userIds || []).filter(id => id !== currentUser?.id))
  const [usersData] = useAtom(usersAtom)
  const users = usersData.users
  const canConfigureApproval = !habit || !!currentUser?.isAdmin || habit.createdBy === currentUser?.id
  const suggestedApprovers = approverQuery.trim()
    ? users.filter(user => !approverIds.includes(user.id) &&
      user.username.toLocaleLowerCase().includes(approverQuery.trim().toLocaleLowerCase())).slice(0, 5)
    : []
  const [drawing, setDrawing] = useState<string>(habit?.drawing || '')
  const [isDrawingModalOpen, setIsDrawingModalOpen] = useState(false)
  const [selectedFolderId, setSelectedFolderId] = useState(folderId ?? '')
  const [saveError, setSaveError] = useState(false)

  function getFrequencyUpdate() {
    if (ruleText === initialRuleText && habit?.frequency) {
      // If text hasn't changed and original frequency exists, return it
      return habit.frequency;
    }

    if (isTask && pickedTaskDate) return d2t({ dateTime: pickedTaskDate, timezone: settings.system.timezone })

    const parsedResult = convertHumanReadableFrequencyToMachineReadable({
      text: ruleText,
      timezone: settings.system.timezone,
      isRecurring: isRecurRule
    });

    if (parsedResult.result) {
      return isRecurRule
        ? serializeRRule(parsedResult.result as RRule)
        : d2t({
          dateTime: parsedResult.result as DateTime,
          timezone: settings.system.timezone
        });
    } else {
      return 'invalid';
    }
  }

  const setPreset = (preset: SchedulePreset) => {
    setSchedulePreset(preset)
    if (preset === 'daily') setRuleText('every day')
    if (preset === 'alternate') setRuleText('every 2 days')
    if (preset === 'weekdays') setRuleText('weekdays')
    if (preset === 'chosenDays') {
      const selected = selectedWeekdays.length ? selectedWeekdays : ['MO']
      setSelectedWeekdays(selected)
      setRuleText(`every week on ${weekdays.filter(day => selected.includes(day.key)).map(day => day.english).join(', ')}`)
    }
  }

  const toggleWeekday = (key: string) => {
    const selected = selectedWeekdays.includes(key)
      ? selectedWeekdays.filter(day => day !== key) : [...selectedWeekdays, key]
    if (!selected.length) return
    setSelectedWeekdays(selected)
    setRuleText(`every week on ${weekdays.filter(day => selected.includes(day.key)).map(day => day.english).join(', ')}`)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isNegative && !includeSelf && !selectedUserIds.length) {
      setSaveError(true)
      return
    }
    if (!isNegative && requiresApproval && approverIds.length === 0) {
      setApprovalError(t('approverRequired'))
      return
    }
    const boostUntil = boostEndsOn
      ? DateTime.fromISO(boostEndsOn, { zone: settings.system.timezone }).endOf('day').toUTC().toISO() : null
    try { await onSave({
      name,
      description,
      coinReward,
      isNegative: !isTask && isNegative || undefined,
      coinPenalty: !isTask && isNegative ? coinPenalty : undefined,
      targetCompletions: !isNegative && targetCompletions > 1 ? targetCompletions : undefined,
      completions: habit?.completions || [],
      frequency: getFrequencyUpdate(),
      userIds: isNegative ? [negativeOwnerId] : [...selectedUserIds, ...(includeSelf && currentUser ? [currentUser.id] : [])],
      drawing: drawing && drawing !== '[]' ? drawing : undefined,
      taskRepeat: isTask && taskRepeat !== 'none' ? taskRepeat as Habit['taskRepeat'] : undefined,
      taskGoalOccurrences: isTask && taskRepeat !== 'none' && taskGoalOccurrences > 0 ? taskGoalOccurrences : undefined,
      checklist: isTask && checklist.length ? checklist : undefined,
      reminderTime: reminderTime || undefined,
      requiresApproval: isNegative ? false : canConfigureApproval ? requiresApproval : habit?.requiresApproval,
      approverIds: isNegative ? [] : canConfigureApproval ? (requiresApproval ? approverIds : []) : habit?.approverIds,
      coinBoost: !isNegative && boostMultiplier > 1 && boostUntil ? unchangedBoost ? habit?.coinBoost : {
        multiplier: boostMultiplier as 2 | 3,
        startsAt: DateTime.now().toUTC().toISO()!,
        until: boostUntil,
      } : undefined,
    }, selectedFolderId)
    } catch { setSaveError(true) }
  }

  return (
    <>
      <ModalOverlay />
      <Dialog open={true} onOpenChange={(open) => {
        if (!open && !isDrawingModalOpen) {
          onClose()
        }
      }} modal={false}>
        <DialogContent aria-describedby={undefined} className="max-h-[90vh] overflow-y-auto"> {/* DialogContent from shadcn/ui is typically z-50, ModalOverlay is z-40 */}
          <DialogHeader>
            <DialogTitle>
              {habit
                ? t(isTask ? 'editTaskTitle' : 'editHabitTitle')
                : t(isTask ? 'addNewTaskTitle' : 'addNewHabitTitle')}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit}>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="name" className="text-right">
                  {t('nameLabel')}
                </Label>
                <div className='flex col-span-3 gap-2'>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                  <EmojiPickerButton
                    inputIdToFocus="name"
                    onEmojiSelect={(emoji) => {
                      setName(prev => {
                        const space = prev.length > 0 && !prev.endsWith(' ') ? ' ' : '';
                        return `${prev}${space}${emoji}`;
                      })
                    }}
                  />
                </div>
              </div>
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="description" className="text-right">
                  {t('descriptionLabel')}
                </Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="col-span-3"
                />
              </div>
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="recurrence" className="text-right">
                  {t('whenLabel')}
                </Label>
                {/* date input (task) */}
                <div className="col-span-3 space-y-2">
                  {!isTask && (
                    <>
                      <Select value={schedulePreset} onValueChange={value => setPreset(value as SchedulePreset)}>
                        <SelectTrigger aria-label={t('schedulePresetLabel')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="daily">{t('scheduleDaily')}</SelectItem>
                          <SelectItem value="alternate">{t('scheduleAlternate')}</SelectItem>
                          <SelectItem value="weekdays">{t('scheduleWeekdays')}</SelectItem>
                          <SelectItem value="chosenDays">{t('scheduleChosenDays')}</SelectItem>
                          <SelectItem value="custom">{t('scheduleCustom')}</SelectItem>
                        </SelectContent>
                      </Select>
                      {schedulePreset === 'chosenDays' && (
                        <div role="group" aria-label={t('scheduleChosenDays')} className="flex flex-wrap gap-1">
                          {weekdays.map((day, index) => {
                            const date = new Date(Date.UTC(2026, 10, 2 + index))
                            const label = new Intl.DateTimeFormat(settings.system.language, { weekday: 'long', timeZone: 'UTC' }).format(date)
                            return (
                              <Button key={day.key} type="button" variant={selectedWeekdays.includes(day.key) ? 'default' : 'outline'}
                                size="sm" aria-label={label} aria-pressed={selectedWeekdays.includes(day.key)}
                                onClick={() => toggleWeekday(day.key)}>
                                {new Intl.DateTimeFormat(settings.system.language, { weekday: 'short', timeZone: 'UTC' }).format(date)}
                              </Button>
                            )
                          })}
                        </div>
                      )}
                    </>
                  )}
                  <div className="flex gap-2">
                    <Input
                      id="recurrence"
                      value={ruleText}
                      onChange={(e) => {
                        setRuleText(e.target.value)
                        if (isTask) setPickedTaskDate(null)
                        else setSchedulePreset('custom')
                      }}
                      required
                    />
                    {isTask && (
                      <Popover modal open={isQuickDatesOpen} onOpenChange={setIsQuickDatesOpen}>
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            aria-label={t('chooseTaskDate')}
                          >
                            <CalendarDays className="h-4 w-4" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="p-3 w-[min(360px,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto" align="start">
                          <div className="space-y-1">
                            <div className="grid grid-cols-2 gap-2">
                              {QUICK_DATES.map((date) => (
                                <Button
                                  key={date.value}
                                  type="button"
                                  variant="outline"
                                  className="justify-start h-9 px-3 hover:bg-primary hover:text-primary-foreground transition-colors"
                                  onClick={() => {
                                    setRuleText(date.value);
                                    setPickedTaskDate(null)
                                    setIsQuickDatesOpen(false);
                                  }}
                                >
                                  {date.label}
                                </Button>
                              ))}
                            </div>
                            <Calendar
                              mode="single"
                              selected={(() => {
                                const parsed = pickedTaskDate ?? convertHumanReadableFrequencyToMachineReadable({
                                  text: ruleText, timezone: settings.system.timezone, isRecurring: false,
                                }).result
                                return parsed instanceof DateTime ? toCalendarPickerDate(parsed) : undefined
                              })()}
                              onSelect={date => {
                                if (!date) return
                                const selected = fromCalendarPickerDate(date, settings.system.timezone)
                                setPickedTaskDate(selected)
                                setRuleText(selected.toISODate() ?? '')
                                setIsQuickDatesOpen(false)
                              }}
                              weekStartsOn={settings.system.weekStartDay}
                              className="mx-auto"
                            />
                          </div>
                        </PopoverContent>
                      </Popover>
                    )}
                  </div>
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">{t('scheduleHelpTitle')}</summary>
                    <p className="mt-1">{t(isTask ? 'taskScheduleHelp' : 'habitScheduleHelp')}</p>
                  </details>
                </div>
                {/* rrule input (habit) */}
                <div className="col-start-2 col-span-3 text-sm">
                  {(() => {
                    let displayText = '';
                    const { result, message } = convertHumanReadableFrequencyToMachineReadable({ text: ruleText, timezone: settings.system.timezone, isRecurring: isRecurRule });
                    if (message !== errorMessage) { // Only update if it changed to avoid re-renders
                      setErrorMessage(message);
                    }
                    displayText = convertMachineReadableFrequencyToHumanReadable({ frequency: result, isRecurRule, timezone: settings.system.timezone })

                    return (
                      <>
                        <span className={errorMessage ? 'text-destructive' : 'text-muted-foreground'}>
                          {displayText}
                        </span>
                        {errorMessage && (
                          <p className="text-destructive text-xs mt-1">{errorMessage}</p>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>
              {!isTask && <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="negative-habit" className="text-right">{t('negativeHabitLabel')}</Label>
                <div className="col-span-3 space-y-1"><Switch id="negative-habit" checked={isNegative}
                  disabled={!!habit?.completions.length || !!habit?.slips?.length}
                  onCheckedChange={setIsNegative} />
                  <p className="text-xs text-muted-foreground">{t('negativeHabitHelp')}</p></div>
              </div>}
              {!isNegative && <div className="grid grid-cols-4 items-center gap-4">
                <div className="flex items-center gap-2 justify-end">
                  <Label htmlFor="targetCompletions">
                    {t('completeLabel')}
                  </Label>
                </div>
                <div className="col-span-3">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center border rounded-lg overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setTargetCompletions(prev => Math.max(1, prev - 1))}
                        className="px-3 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 transition-colors"
                      >
                        -
                      </button>
                      <Input
                        id="targetCompletions"
                        type="number"
                        value={targetCompletions}
                        onChange={(e) => {
                          const value = parseInt(e.target.value)
                          setTargetCompletions(isNaN(value) ? 1 : Math.max(1, value))
                        }}
                        min={1}
                        max={10}
                        className="w-20 text-center border-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                      <button
                        type="button"
                        onClick={() => setTargetCompletions(prev => Math.min(10, prev + 1))}
                        className="px-3 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 transition-colors"
                      >
                        +
                      </button>
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {t('timesSuffix')}
                    </span>
                  </div>
                </div>
              </div>}
              <div className="grid grid-cols-4 items-center gap-4">
                <div className="flex items-center gap-2 justify-end">
                  <Label htmlFor="coinReward">
                    {t('rewardLabel')}
                  </Label>
                </div>
                <div className="col-span-3">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center border rounded-lg overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setCoinReward(prev => Math.max(0, prev - 1))}
                        className="px-3 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 transition-colors"
                      >
                        -
                      </button>
                      <Input
                        id="coinReward"
                        type="number"
                        value={coinReward}
                        onChange={(e) => {
                          const value = parseInt(e.target.value === "" ? "0" : e.target.value)
                          setCoinReward(Math.min(value, MAX_COIN_LIMIT))
                        }}
                        min={0}
                        max={MAX_COIN_LIMIT}
                        required
                        className="w-20 text-center border-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                      <button
                        type="button"
                        onClick={() => setCoinReward(prev => Math.min(prev + 1, MAX_COIN_LIMIT))}
                        className="px-3 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 transition-colors"
                      >
                        +
                      </button>
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {t('coinsSuffix')}
                    </span>
                  </div>
                </div>
              </div>
              {isNegative && <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="coin-penalty" className="text-right">{t('coinPenaltyLabel')}</Label>
                <Input id="coin-penalty" type="number" className="col-span-3" min={0} max={MAX_COIN_LIMIT}
                  value={coinPenalty} onChange={event => setCoinPenalty(Number(event.target.value))} required />
              </div>}
              {isTask && <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="task-repeat" className="text-right">{t('taskRepeatLabel')}</Label>
                <div className="col-span-3 flex flex-wrap gap-2">
                  <Select value={taskRepeat} onValueChange={setTaskRepeat}>
                    <SelectTrigger id="task-repeat" className="w-40"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t('taskRepeatNone')}</SelectItem>
                      <SelectItem value="daily">{t('taskRepeatDaily')}</SelectItem>
                      <SelectItem value="weekly">{t('taskRepeatWeekly')}</SelectItem>
                      <SelectItem value="monthly">{t('taskRepeatMonthly')}</SelectItem>
                      <SelectItem value="yearly">{t('taskRepeatYearly')}</SelectItem>
                    </SelectContent>
                  </Select>
                  {taskRepeat !== 'none' && <div className="flex items-center gap-2">
                    <Label htmlFor="task-goal">{t('taskGoalLabel')}</Label>
                    <Input id="task-goal" type="number" min={0} max={1000} className="w-24"
                      value={taskGoalOccurrences} onChange={event => setTaskGoalOccurrences(Number(event.target.value))} />
                  </div>}
                  {taskRepeat !== 'none' && <p className="w-full text-xs text-muted-foreground">{t('taskGoalHelp')}</p>}
                </div>
              </div>}
              {isTask && <div className="grid grid-cols-4 items-start gap-4">
                <Label className="text-right pt-2">{t('checklistLabel')}</Label>
                <div className="col-span-3 space-y-2">
                  {checklist.map((item, index) => <div key={item.id} className="flex gap-2">
                    <Input value={item.text} maxLength={200} required aria-label={t('checklistItemLabel', { number: index + 1 })}
                      onChange={event => setChecklist(previous => previous.map(step =>
                        step.id === item.id ? { ...step, text: event.target.value } : step))} />
                    <Button type="button" variant="outline" size="sm"
                      aria-label={t('removeChecklistItem', { number: index + 1 })}
                      onClick={() => setChecklist(previous => previous.filter(step => step.id !== item.id))}>−</Button>
                  </div>)}
                  <Button type="button" variant="outline" size="sm" disabled={checklist.length >= 30}
                    onClick={() => setChecklist(previous => [...previous, { id: uuid(), text: '', completed: false }])}>
                    {t('addChecklistItem')}
                  </Button>
                </div>
              </div>}
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="reminder-time" className="text-right">{t('reminderTimeLabel')}</Label>
                <Input id="reminder-time" type="time" className="col-span-3" value={reminderTime}
                  onChange={event => setReminderTime(event.target.value)} />
              </div>
              {!isNegative && <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="boost-multiplier" className="text-right">{t('boostLabel')}</Label>
                <div className="col-span-3 flex flex-wrap items-center gap-2">
                  <Select value={String(boostMultiplier)} onValueChange={value => setBoostMultiplier(Number(value))}>
                    <SelectTrigger id="boost-multiplier" className="w-28"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">{t('boostNone')}</SelectItem>
                      <SelectItem value="2">2×</SelectItem>
                      <SelectItem value="3">3×</SelectItem>
                    </SelectContent>
                  </Select>
                  {boostMultiplier > 1 && <>
                    <Label htmlFor="boost-until">{t('boostUntilLabel')}</Label>
                    <Input id="boost-until" type="date" className="w-40" required value={boostEndsOn}
                      min={unchangedBoost ? undefined :
                        DateTime.now().setZone(settings.system.timezone).toISODate() ?? undefined}
                      onChange={event => setBoostEndsOn(event.target.value)} />
                  </>}
                </div>
              </div>}
              {!isNegative && <div className="grid grid-cols-4 items-start gap-4">
                <Label htmlFor="approval-toggle" className="text-right pt-1">{t('approvalLabel')}</Label>
                <div className="col-span-3 space-y-2">
                  <Switch id="approval-toggle" checked={requiresApproval} disabled={!canConfigureApproval}
                    onCheckedChange={value => { setRequiresApproval(value); setApprovalError('') }} />
                  {requiresApproval && <>
                    <Label htmlFor="approver-search">{t('approversLabel')}</Label>
                    <Input id="approver-search" value={approverQuery} disabled={!canConfigureApproval}
                      placeholder={t('approverSearchPlaceholder')} autoComplete="off"
                      aria-controls={suggestedApprovers.length > 0 ? 'approver-suggestions' : undefined}
                      onChange={event => setApproverQuery(event.target.value)} />
                    {suggestedApprovers.length > 0 && <ul id="approver-suggestions"
                      className="rounded border bg-popover p-1">
                      {suggestedApprovers.map(user => <li key={user.id}>
                        <button type="button" className="w-full rounded px-2 py-1 text-left hover:bg-accent focus-visible:outline"
                          onClick={() => { setApproverIds(previous => [...previous, user.id]); setApproverQuery(''); setApprovalError('') }}>
                          {user.username}
                        </button>
                      </li>)}
                    </ul>}
                    <div className="flex flex-wrap gap-2">
                      {approverIds.map(id => {
                        const approver = users.find(user => user.id === id)
                        return <span key={id} className="rounded border px-2 py-1 text-sm">
                          {approver?.username ?? id}
                          {canConfigureApproval && <button type="button" className="ml-2" aria-label={t('removeApprover', { name: approver?.username ?? id })}
                            onClick={() => setApproverIds(previous => previous.filter(value => value !== id))}>×</button>}
                        </span>
                      })}
                    </div>
                    {approvalError && <p role="alert" className="text-sm text-destructive">{approvalError}</p>}
                  </>}
                </div>
              </div>}
              <div className="grid grid-cols-4 items-center gap-4">
                <Label className="text-right">
                  {t('drawingLabel')}
                </Label>
                <div className="col-span-3">
                  <div className="flex gap-4 items-center">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setIsDrawingModalOpen(true)
                      }}
                      className="flex-1 justify-start"
                    >
                      <Brush className="h-4 w-4 mr-2" />
                      {drawing ? t('editDrawing') : t('addDrawing')}
                    </Button>
                    {drawing && (
                      <div className="flex-shrink-0">
                        <DrawingDisplay
                          drawingData={drawing}
                          width={80}
                          height={53}
                          className=""
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {isNegative && (currentUser?.isAdmin || currentUser?.managedUserIds?.length) && <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="negative-assignee" className="text-right">{t('negativeAssignee')}</Label>
                <select id="negative-assignee" className="col-span-3 flex h-9 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={negativeOwnerId} onChange={event => setNegativeOwnerId(event.target.value)}>
                  {users.filter(user => user.id === currentUser.id || canAssignUser(user.id))
                    .map(user => <option key={user.id} value={user.id}>{user.username}</option>)}
                </select>
              </div>}
              {!isNegative && (currentUser?.isAdmin || currentUser?.managedUserIds?.length) && <label className="col-span-3 col-start-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={includeSelf} onChange={event => setIncludeSelf(event.target.checked)} />
                {t('includeSelf')}
              </label>}
              {!isNegative && users && users.length > 1 && (
                <div className="grid grid-cols-4 items-center gap-4">
                  <div className="flex items-center justify-end gap-2">
                    <Label htmlFor="sharing-toggle">{t('shareLabel')}</Label>
                  </div>
                  <div className="col-span-3">
                    <div className="flex flex-wrap gap-2">
                      {users.filter(user => user.id !== currentUser?.id && canAssignUser(user.id)).map(user => (
                        <button type="button" key={user.id} aria-label={t('assignUser', { username: user.username })}
                          aria-pressed={selectedUserIds.includes(user.id)}
                          className={`h-8 w-8 border-2 cursor-pointer
                          ${selectedUserIds.includes(user.id)
                              ? 'border-primary'
                              : 'border-muted'
                            }`}
                          title={user.username}
                          onClick={() => {
                            setSelectedUserIds(prev =>
                              prev.includes(user.id)
                                ? prev.filter(id => id !== user.id)
                                : [...prev, user.id]
                            )
                          }}
                        >
                          <Avatar className="h-7 w-7">
                          <AvatarImage src={user?.avatarPath && `/api/avatars/${user.avatarPath.split('/').pop()}` || ""} />
                          <AvatarFallback>{user.username[0]}</AvatarFallback>
                          </Avatar>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {folders && <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="item-folder" className="text-right">{t('folderLabel')}</Label>
                <select id="item-folder" className="col-span-3 flex h-9 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={selectedFolderId} onChange={event => setSelectedFolderId(event.target.value)}>
                  <option value="">{t('noFolder')}</option>
                  {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                </select>
              </div>}
            </div>
            {saveError && <p role="alert" className="text-sm text-destructive">{t('saveFailed')}</p>}
            <DialogFooter>
              <Button type="submit" disabled={!!errorMessage}>
                {habit
                  ? t('saveChangesButton')
                  : t(isTask ? 'addTaskButton' : 'addHabitButton')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <DrawingModal
        isOpen={isDrawingModalOpen}
        onClose={() => setIsDrawingModalOpen(false)}
        onSave={(drawingData) => setDrawing(drawingData)}
        initialDrawing={drawing}
        title={name}
      />
    </>
  )
}

