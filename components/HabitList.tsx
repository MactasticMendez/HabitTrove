'use client'

import { useState, useMemo } from 'react'
import { Plus, ArrowUpNarrowWide, ArrowDownWideNarrow, Search, GripVertical, ArrowUp, ArrowDown, Rows3 } from 'lucide-react'
import { useAtom } from 'jotai'
import { useTranslations } from 'next-intl'
import { habitsAtom, browserSettingsAtom, settingsAtom, currentUserAtom } from '@/lib/atoms'
import { useTodayInTimezone } from '@/hooks/useTodayInTimezone'
import EmptyState from './EmptyState'
import { Button } from '@/components/ui/button'
import HabitItem from './HabitItem'
import AddEditHabitModal from './AddEditHabitModal'
import ConfirmDialog from './ConfirmDialog'
import { Habit } from '@/lib/types'
import { useHabits } from '@/hooks/useHabits'
import { HabitIcon, TaskIcon } from '@/lib/constants'
import { ViewToggle } from './ViewToggle'
import { Input } from '@/components/ui/input' // Added
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select' // Added
import { Label } from '@/components/ui/label' // Added
import { DateTime } from 'luxon' // Added
import { getHabitFreq, hasPermission } from '@/lib/utils'

export default function HabitList() {
  const t = useTranslations('HabitList');
  const { saveHabit, deleteHabit, reorderHabits } = useHabits()
  const [habitsData] = useAtom(habitsAtom) // setHabitsData removed as it's not used
  const [browserSettings, setBrowserSettings] = useAtom(browserSettingsAtom)
  const [currentUser] = useAtom(currentUserAtom)
  const [settings] = useAtom(settingsAtom)
  useTodayInTimezone(settings.system.timezone)
  const isTasksView = browserSettings.viewType === 'tasks'

  type SortableField = 'custom' | 'name' | 'coinReward' | 'dueDate' | 'frequency';
  type SortOrder = 'asc' | 'desc';

  const [searchTerm, setSearchTerm] = useState('');
  const sortBy: SortableField = isTasksView ? browserSettings.taskSortBy ?? 'name' : browserSettings.habitSortBy ?? 'name';
  const setSortBy = (value: SortableField) => setBrowserSettings(previous => ({
    ...previous, [isTasksView ? 'taskSortBy' : 'habitSortBy']: value,
  }))
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [reordering, setReordering] = useState(false)
  const [orderError, setOrderError] = useState('')
  const canReorder = sortBy === 'custom' && !searchTerm.trim() && !browserSettings.hideNonDaily && hasPermission(currentUser, 'habit', 'write')
  const originalOrder = useMemo(() => new Map(habitsData.habits.map((habit, index) => [habit.id, index])), [habitsData.habits])

  const compareHabits = useMemo(() => {
    return (a: Habit, b: Habit, currentSortBy: SortableField, currentSortOrder: SortOrder, tasksView: boolean): number => {
      let comparison = 0;
      switch (currentSortBy) {
        case 'custom':
          comparison = (a.position ?? originalOrder.get(a.id) ?? 0) - (b.position ?? originalOrder.get(b.id) ?? 0);
          break;
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'coinReward':
          comparison = a.coinReward - b.coinReward;
          break;
        case 'dueDate':
          if (tasksView && a.isTask && b.isTask) {
            const dateA = DateTime.fromISO(a.frequency);
            const dateB = DateTime.fromISO(b.frequency);
            if (dateA.isValid && dateB.isValid) comparison = dateA.toMillis() - dateB.toMillis();
            else if (dateA.isValid) comparison = -1; // Valid dates first
            else if (dateB.isValid) comparison = 1;
            // If both invalid, comparison remains 0
          }
          break;
        case 'frequency':
          if (!tasksView && !a.isTask && !b.isTask) {
            const freqOrder = ['daily', 'weekly', 'monthly', 'yearly'];
            const freqAVal = getHabitFreq(a);
            const freqBVal = getHabitFreq(b);
            comparison = freqOrder.indexOf(freqAVal) - freqOrder.indexOf(freqBVal);
          }
          break;
      }
      return currentSortBy === 'custom' || currentSortOrder === 'asc' ? comparison : -comparison;
    };
  }, [originalOrder]);

  const allHabitsInView = useMemo(() => {
    return habitsData.habits.filter(habit =>
      (isTasksView ? habit.isTask : !habit.isTask) &&
      (!browserSettings.hideNonDaily || (habit.isTask ? !habit.taskRepeat || habit.taskRepeat === 'daily' : getHabitFreq(habit) === 'daily'))
    );
  }, [habitsData.habits, isTasksView, browserSettings.hideNonDaily]);

  const searchedHabits = useMemo(() => {
    if (!searchTerm.trim()) {
      return allHabitsInView;
    }
    const lowercasedSearchTerm = searchTerm.toLowerCase();
    return allHabitsInView.filter(habit =>
      habit.name.toLowerCase().includes(lowercasedSearchTerm) ||
      (habit.description && habit.description.toLowerCase().includes(lowercasedSearchTerm))
    );
  }, [allHabitsInView, searchTerm]);

  const activeHabits = useMemo(() => {
    return searchedHabits
      .filter(h => !h.archived)
      .sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        // For items in the same pinned group (both pinned or both not pinned), apply general sort
        return compareHabits(a, b, sortBy, sortOrder, isTasksView);
      });
  }, [searchedHabits, sortBy, sortOrder, isTasksView, compareHabits]);

  const archivedHabits = useMemo(() => {
    return searchedHabits
      .filter(h => h.archived)
      .sort((a, b) => compareHabits(a, b, sortBy, sortOrder, isTasksView));
  }, [searchedHabits, sortBy, sortOrder, isTasksView, compareHabits]);
  const [modalConfig, setModalConfig] = useState<{
    isOpen: boolean,
    isTask: boolean
  }>({
    isOpen: false,
    isTask: false
  })
  const [editingHabit, setEditingHabit] = useState<Habit | null>(null)
  const [deleteConfirmation, setDeleteConfirmation] = useState<{ isOpen: boolean, habitId: string | null }>({
    isOpen: false,
    habitId: null
  })

  const moveHabit = async (fromIndex: number, toIndex: number) => {
    if (!canReorder || reordering || fromIndex < 0 || toIndex < 0 ||
        fromIndex >= activeHabits.length || toIndex >= activeHabits.length ||
        Boolean(activeHabits[fromIndex].pinned) !== Boolean(activeHabits[toIndex].pinned)) return
    const reordered = [...activeHabits]
    const [moved] = reordered.splice(fromIndex, 1)
    reordered.splice(toIndex, 0, moved)
    setReordering(true)
    try {
      await reorderHabits(reordered.map(habit => habit.id), isTasksView)
      setOrderError('')
    } catch {
      setOrderError(t('reorderFailed'))
    } finally {
      setReordering(false)
    }
  }


  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-xl xs:text-3xl font-bold">
          {t(isTasksView ? 'myTasks' : 'myHabits')}
        </h1>
        <span>
          <Button className="mr-2" onClick={() => setModalConfig({ isOpen: true, isTask: true })}>
            <Plus className="mr-2 h-4 w-4" /> {t('addTaskButton')}
          </Button>
          <Button onClick={() => setModalConfig({ isOpen: true, isTask: false })}>
            <Plus className="mr-2 h-4 w-4" /> {t('addHabitButton')}
          </Button>
        </span>
      </div>
      <div className='py-4'>
        <ViewToggle />
      </div>

      {/* Search and Sort Controls */}
      <div className="flex flex-col sm:flex-row items-center gap-4 my-4">
        <div className="relative flex-grow w-full sm:w-auto">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Search className="h-5 w-5 text-muted-foreground" />
          </div>
          <Input
            type="search"
            placeholder={t(isTasksView ? 'searchTasksPlaceholder' : 'searchHabitsPlaceholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 w-full"
          />
        </div>
        <div className="flex items-center gap-2 self-start sm:self-center w-full sm:w-auto">
          <Label htmlFor="sort-by" className="text-sm font-medium whitespace-nowrap sr-only sm:not-sr-only">{t('sortByLabel')}</Label>
          <Select value={sortBy} onValueChange={(value) => setSortBy(value as SortableField)}>
            <SelectTrigger id="sort-by" className="w-full sm:w-[180px]">
              <SelectValue placeholder={t('sortByLabel')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="custom">{t('sortByCustom')}</SelectItem>
              <SelectItem value="name">{t('sortByName')}</SelectItem>
              <SelectItem value="coinReward">{t('sortByCoinReward')}</SelectItem>
              {isTasksView && <SelectItem value="dueDate">{t('sortByDueDate')}</SelectItem>}
              {!isTasksView && <SelectItem value="frequency">{t('sortByFrequency')}</SelectItem>}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" disabled={sortBy === 'custom'}
            onClick={() => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}>
            {sortOrder === 'asc' ? <ArrowUpNarrowWide className="h-4 w-4" /> : <ArrowDownWideNarrow className="h-4 w-4" />}
            <span className="sr-only">{t('toggleSortOrderAriaLabel')}</span>
          </Button>
          <Button variant={browserSettings.compactItems ? 'secondary' : 'outline'}
            aria-pressed={Boolean(browserSettings.compactItems)}
            onClick={() => setBrowserSettings(previous => ({ ...previous, compactItems: !previous.compactItems }))}>
            <Rows3 className="mr-2 h-4 w-4" />{t('compactView')}
          </Button>
          <Button type="button" variant={browserSettings.hideNonDaily ? 'secondary' : 'outline'}
            aria-pressed={Boolean(browserSettings.hideNonDaily)}
            onClick={() => setBrowserSettings(previous => ({ ...previous, hideNonDaily: !previous.hideNonDaily }))}>
            {t('hideNonDaily')}
          </Button>
        </div>
      </div>
      {sortBy === 'custom' && <p className="mb-3 text-sm text-gray-700 dark:text-gray-300">{t('manualOrderHelp')}</p>}
      {orderError && <p role="alert" className="text-sm text-destructive mb-3">{orderError}</p>}

      <div className={`grid grid-cols-1 gap-4 items-stretch ${browserSettings.compactItems ? '' : 'md:grid-cols-2'}`}>
        {activeHabits.length === 0 && searchTerm.trim() ? (
          <div className="col-span-2 text-center text-muted-foreground py-8">
            {t(isTasksView ? 'noTasksFoundMessage' : 'noHabitsFoundMessage')}
          </div>
        ) : activeHabits.length === 0 ? (
          <div className="col-span-2">
            <EmptyState
              icon={isTasksView ? TaskIcon : HabitIcon}
              title={t(isTasksView ? 'emptyStateTasksTitle' : 'emptyStateHabitsTitle')}
              description={t(isTasksView ? 'emptyStateTasksDescription' : 'emptyStateHabitsDescription')}
            />
          </div>
        ) : (
          activeHabits.map((habit: Habit, index) => (
            <div key={habit.id} className="min-w-0" onDragOver={event => {
              const from = activeHabits.find(item => item.id === draggedId)
              if (from && Boolean(from.pinned) === Boolean(habit.pinned)) event.preventDefault()
            }} onDrop={event => {
              event.preventDefault()
              const fromIndex = activeHabits.findIndex(item => item.id === draggedId)
              setDraggedId(null)
              void moveHabit(fromIndex, index)
            }}>
              {canReorder && (
                <div className="flex items-center gap-1 mb-1">
                  <button type="button" draggable={!reordering}
                    aria-label={t('dragToReorder', { name: habit.name })}
                    onDragStart={event => {
                      setDraggedId(habit.id)
                      event.dataTransfer.effectAllowed = 'move'
                    }} onDragEnd={() => setDraggedId(null)}
                    className="cursor-grab rounded p-2 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                    <GripVertical className="h-4 w-4" />
                  </button>
                  <Button type="button" variant="ghost" size="icon" disabled={reordering || index === 0 ||
                    Boolean(activeHabits[index - 1]?.pinned) !== Boolean(habit.pinned)}
                    aria-label={t('moveUp', { name: habit.name })} onClick={() => void moveHabit(index, index - 1)}>
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" disabled={reordering || index === activeHabits.length - 1 ||
                    Boolean(activeHabits[index + 1]?.pinned) !== Boolean(habit.pinned)}
                    aria-label={t('moveDown', { name: habit.name })} onClick={() => void moveHabit(index, index + 1)}>
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </div>
              )}
              <HabitItem
                habit={habit}
                compact={Boolean(browserSettings.compactItems)}
                onEdit={() => {
                  setEditingHabit(habit)
                  setModalConfig({ isOpen: true, isTask: isTasksView })
                }}
                onDelete={() => setDeleteConfirmation({ isOpen: true, habitId: habit.id })}
              />
            </div>
          ))
        )}

        {archivedHabits.length > 0 && (
          <>
            <div className="col-span-1 sm:col-span-2 relative flex items-center my-6">
              <div className="flex-grow border-t border-gray-300 dark:border-gray-600" />
              <span className="mx-4 text-sm text-gray-500 dark:text-gray-400">{t('archivedSectionTitle')}</span>
              <div className="flex-grow border-t border-gray-300 dark:border-gray-600" />
            </div>
            {archivedHabits.map((habit: Habit) => (
              <HabitItem
                key={habit.id}
                habit={habit}
                compact={Boolean(browserSettings.compactItems)}
                onEdit={() => {
                  setEditingHabit(habit)
                  setModalConfig({ isOpen: true, isTask: isTasksView })
                }}
                onDelete={() => setDeleteConfirmation({ isOpen: true, habitId: habit.id })}
              />
            ))}
          </>
        )}
      </div>
      {modalConfig.isOpen &&
        <AddEditHabitModal
          onClose={() => {
            setModalConfig({ isOpen: false, isTask: false })
            setEditingHabit(null)
          }}
          onSave={async (habit) => {
            await saveHabit({ ...habit, id: editingHabit?.id, isTask: modalConfig.isTask })
            setModalConfig({ isOpen: false, isTask: false })
            setEditingHabit(null)
          }}
          habit={editingHabit}
          isTask={modalConfig.isTask}
        />
      }
      <ConfirmDialog
        isOpen={deleteConfirmation.isOpen}
        onClose={() => setDeleteConfirmation({ isOpen: false, habitId: null })}
        onConfirm={async () => {
          if (deleteConfirmation.habitId) {
            await deleteHabit(deleteConfirmation.habitId)
          }
          setDeleteConfirmation({ isOpen: false, habitId: null })
        }}
        title={t(isTasksView ? 'deleteTaskDialogTitle' : 'deleteHabitDialogTitle')}
        message={t(isTasksView ? 'deleteTaskDialogMessage' : 'deleteHabitDialogMessage')}
        confirmText={t('deleteButton')}
      />
    </div>
  )
}

