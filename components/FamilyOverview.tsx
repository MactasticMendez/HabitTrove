'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAtom } from 'jotai'
import { useTranslations } from 'next-intl'
import { DateTime } from 'luxon'
import { currentUserAtom, habitsAtom, coinsAtom, wishlistAtom } from '@/lib/atoms'
import type { FamilyOverviewData, Habit, WishlistItemType } from '@/lib/types'
import { loadFamilyOverview, loadHabitsData, loadWishlistData, loadCoinsData, recordHabitCompletion, redeemFamilyReward } from '@/app/actions/data'
import { useHabits } from '@/hooks/useHabits'
import { useWishlist } from '@/hooks/useWishlist'
import { checkPermission, convertMachineReadableFrequencyToHumanReadable, d2t, uuid } from '@/lib/utils'
import { isApprovedCompletion } from '@/lib/task-schedule'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import AddEditHabitModal from './AddEditHabitModal'
import AddEditWishlistItemModal from './AddEditWishlistItemModal'

type HabitEditor = { memberId: string; isTask: boolean; habit?: Habit }
type RewardEditor = { memberId: string; item: WishlistItemType | null }
type Attempt = { requestId: string; timestamp: string }

export default function FamilyOverview() {
  const t = useTranslations('FamilyOverview')
  const [currentUser] = useAtom(currentUserAtom)
  const actorId = useRef(currentUser?.id)
  actorId.current = currentUser?.id
  const [, setHabits] = useAtom(habitsAtom)
  const [, setCoins] = useAtom(coinsAtom)
  const [, setWishlist] = useAtom(wishlistAtom)
  const { saveHabit } = useHabits()
  const { addWishlistItem, editWishlistItem } = useWishlist()
  const [overview, setOverview] = useState<FamilyOverviewData | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [habitEditor, setHabitEditor] = useState<HabitEditor | null>(null)
  const [rewardEditor, setRewardEditor] = useState<RewardEditor | null>(null)
  const [redemption, setRedemption] = useState<{ memberId: string; username: string; item: WishlistItemType } | null>(null)
  const [photos, setPhotos] = useState<Record<string, File | undefined>>({})
  const evidenceInputs = useRef<Record<string, HTMLInputElement | null>>({})
  const completionAttempts = useRef<Record<string, Attempt>>({})
  const redemptionAttempts = useRef<Record<string, string>>({})
  const canManage = !!(currentUser?.isAdmin || currentUser?.managedUserIds?.length)
  const member = overview?.members.find(candidate => candidate.id === selectedId)
  const managesSelectedMember = !!(currentUser?.isAdmin || member && member.id !== currentUser?.id &&
    currentUser?.managedUserIds?.includes(member.id))
  const canEditHabits = managesSelectedMember || checkPermission(currentUser?.permissions, 'habit', 'write')
  const canEditRewards = managesSelectedMember || checkPermission(currentUser?.permissions, 'wishlist', 'write')
  const canRedeemRewards = managesSelectedMember || checkPermission(currentUser?.permissions, 'coins', 'interact') &&
    checkPermission(currentUser?.permissions, 'wishlist', 'interact')
  const initialHabitUsers = useMemo(() => habitEditor ? [habitEditor.memberId] : undefined, [habitEditor])
  const initialRewardUsers = useMemo(() => rewardEditor ? [rewardEditor.memberId] : undefined, [rewardEditor])

  const refresh = useCallback(async () => {
    const requestingActor = actorId.current
    const [next, habits, wishlist, coins] = await Promise.all([
      loadFamilyOverview(), loadHabitsData(), loadWishlistData(), loadCoinsData(),
    ])
    if (actorId.current !== requestingActor) return
    setHabits(habits)
    setWishlist(wishlist)
    setCoins(coins)
    setOverview(next)
    setSelectedId(previous => next.members.some(candidate => candidate.id === previous) ? previous : next.members[0]?.id ?? '')
  }, [setHabits, setWishlist, setCoins])

  useEffect(() => {
    let active = true
    setOverview(null)
    setSelectedId('')
    setError('')
    setNotice('')
    setHabitEditor(null)
    setRewardEditor(null)
    setRedemption(null)
    setPhotos({})
    completionAttempts.current = {}
    redemptionAttempts.current = {}
    setLoading(canManage)
    if (!canManage) return
    loadFamilyOverview().then(next => {
      if (!active) return
      setOverview(next)
      setSelectedId(next.members[0]?.id ?? '')
    }).catch(() => {
      if (active) setError(t('loadError'))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [canManage, currentUser?.id, t])

  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try { await operation() } catch { setError(t('actionError')) }
    finally { busyRef.current = false; setBusy(false) }
  }

  const record = (habit: Habit) => {
    if (!member || !overview) return
    const selectedMember = member
    const key = `${selectedMember.id}:${habit.id}`
    const recordingActor = actorId.current
    void run(async () => {
      const attempt = completionAttempts.current[key] ?? {
        requestId: uuid(), timestamp: d2t({ dateTime: DateTime.now().setZone(overview.timezone) }),
      }
      completionAttempts.current[key] = attempt
      const evidence = photos[key] ? new FormData() : undefined
      if (photos[key]) evidence!.set('evidence', photos[key]!)
      const result = await recordHabitCompletion(habit.id, attempt.timestamp, evidence, {
        beneficiaryId: selectedMember.id, requestId: attempt.requestId,
      })
      if (actorId.current !== recordingActor) return
      delete completionAttempts.current[key]
      setHabits(previous => ({ habits: previous.habits.map(item => item.id === habit.id ? result.habit : item) }))
      setCoins(result.coins)
      setPhotos(previous => ({ ...previous, [key]: undefined }))
      if (evidenceInputs.current[key]) evidenceInputs.current[key]!.value = ''
      setNotice(t(result.pending ? 'submittedFor' : 'recordedFor', { name: selectedMember.username }))
      await refresh().catch(() => setError(t('refreshError')))
    })
  }

  const redeem = () => {
    if (!redemption) return
    const target = redemption
    const redeemingActor = actorId.current
    const key = `${target.memberId}:${target.item.id}`
    void run(async () => {
      const requestId = redemptionAttempts.current[key] ?? uuid()
      redemptionAttempts.current[key] = requestId
      await redeemFamilyReward(target.memberId, target.item.id, requestId)
      if (actorId.current !== redeemingActor) return
      delete redemptionAttempts.current[key]
      setRedemption(null)
      setNotice(t('redeemedFor', { reward: target.item.name, name: target.username }))
      await refresh().catch(() => setError(t('refreshError')))
    })
  }

  const scheduleText = (habit: Habit) => {
    if (habit.schedule?.type === 'anytime') return t('anytime')
    if (habit.schedule?.type === 'afterCompletion') return t('afterCompletion', {
      count: habit.schedule.interval, unit: t(`units.${habit.schedule.unit}`),
    })
    const initial = convertMachineReadableFrequencyToHumanReadable({
      frequency: habit.frequency, isRecurRule: !habit.isTask, timezone: overview!.timezone,
    })
    return habit.taskRepeat ? t('repeatingTask', { date: initial, interval: habit.taskRepeatInterval ?? 1,
      unit: t(`taskUnits.${habit.taskRepeat}`) }) : initial
  }

  if (!canManage) return <section className="space-y-3">
    <h1 className="text-2xl font-bold">{t('title')}</h1>
    <p>{t('noAccess')}</p>
  </section>

  return <section aria-labelledby="family-title" aria-busy={busy || loading} className="min-w-0 space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-2">
        <h1 id="family-title" className="text-2xl font-bold">{t('title')}</h1>
        <p className="max-w-3xl text-sm">{t('description')}</p>
      </div>
      <Button type="button" variant="outline" disabled={busy || loading} onClick={() => void run(refresh)}>{t('refresh')}</Button>
    </div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {loading ? <p role="status">{t('loading')}</p> : !overview?.members.length ? <p>{t('empty')}</p> : <>
      <ul aria-label={t('memberSummaries')} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {overview.members.map(summary => <li key={summary.id} className="min-w-0">
          <Card className={summary.id === selectedId ? 'border-primary' : ''}>
            <CardHeader><CardTitle className="break-words text-lg">{summary.username}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <dl className="space-y-2 text-sm">
                <div className="flex flex-wrap justify-between gap-2"><dt>{t('balance')}</dt><dd>{t('coins', { count: summary.balance })}</dd></div>
                <div className="flex flex-wrap justify-between gap-2"><dt>{t('today')}</dt><dd>{t('todayCount', { done: summary.completedToday, due: summary.dueToday })}</dd></div>
                <div className="flex flex-wrap justify-between gap-2"><dt>{t('pendingApprovals')}</dt><dd>{summary.pendingApprovals}</dd></div>
                {summary.status && <div className="flex flex-wrap justify-between gap-2"><dt>{t('status')}</dt><dd>{t(`statuses.${summary.status}`)}</dd></div>}
              </dl>
              <Button type="button" variant={summary.id === selectedId ? 'default' : 'outline'}
                className="h-auto min-h-9 whitespace-normal text-left" aria-pressed={summary.id === selectedId}
                aria-controls="family-member-details" onClick={() => { setSelectedId(summary.id); setNotice(''); setError('') }}>
                {t('viewMember', { name: summary.username })}
              </Button>
            </CardContent>
          </Card>
        </li>)}
      </ul>
      <div className="max-w-sm space-y-2">
        <Label htmlFor="family-member">{t('selectMember')}</Label>
        <select id="family-member" value={selectedId} disabled={busy} aria-controls="family-member-details"
          className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm"
          onChange={event => { setSelectedId(event.target.value); setNotice(''); setError('') }}>
          {overview.members.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.username}</option>)}
        </select>
      </div>
      {member && <div id="family-member-details" className="min-w-0 space-y-6">
        <h2 className="break-words text-xl font-semibold">{t('memberHeading', { name: member.username })}</h2>
        <section aria-labelledby="family-habits-title" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 id="family-habits-title" className="text-lg font-semibold">{t('habitsAndTasks')}</h3>
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={busy || !canEditHabits} onClick={() => setHabitEditor({ memberId: member.id, isTask: false })}>{t('addHabit')}</Button>
              <Button type="button" disabled={busy || !canEditHabits} onClick={() => setHabitEditor({ memberId: member.id, isTask: true })}>{t('addTask')}</Button>
            </div>
          </div>
          {!member.habits.length ? <p>{t('noHabits')}</p> : <ul className="space-y-3">
            {member.habits.map(habit => {
              const key = `${member.id}:${habit.id}`
              const managerMayRecord = habit.schedule?.type === 'anytime' && habit.schedule.recordingPolicy !== 'member' &&
                (currentUser?.isAdmin || currentUser?.managedUserIds?.includes(member.id))
              const today = DateTime.now().setZone(overview.timezone).toISODate()
              const recordedToday = habit.completions.filter((timestamp, index) =>
                isApprovedCompletion(habit, index) && DateTime.fromISO(timestamp).setZone(overview.timezone).toISODate() === today).length
              return <li key={habit.id} className="min-w-0 rounded-lg border bg-card p-4 text-card-foreground">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <h4 className="break-words font-semibold">{habit.name}</h4>
                    <p className="text-sm">{t(habit.isTask ? 'task' : 'habit')} · {scheduleText(habit)}</p>
                    <p className="text-sm">{t('rewardPerAction', { count: habit.coinReward })}</p>
                    <p className="text-sm">{t('approvedToday', { count: recordedToday })}</p>
                    {habit.archived && <p className="text-sm font-medium">{t('archived')}</p>}
                    {habit.requiresApproval && <p className="text-sm">{t('requiresApproval')}</p>}
                  </div>
                  <Button type="button" variant="outline" disabled={busy || !canEditHabits}
                    aria-label={t('editItem', { name: habit.name })}
                    onClick={() => setHabitEditor({ memberId: member.id, habit, isTask: !!habit.isTask })}>{t('edit')}</Button>
                </div>
                {managerMayRecord && !habit.archived && <div className="mt-3 space-y-3">
                  {habit.requiresApproval && <div className="max-w-md space-y-2">
                    <Label htmlFor={`family-evidence-${habit.id}`}>{t('optionalEvidence')}</Label>
                    <Input id={`family-evidence-${habit.id}`} type="file" accept="image/jpeg,image/png,image/webp"
                      disabled={busy} ref={element => { evidenceInputs.current[key] = element }}
                      onChange={event => setPhotos(previous => ({ ...previous, [key]: event.target.files?.[0] }))} />
                  </div>}
                  <Button type="button" disabled={busy} className="h-auto min-h-9 whitespace-normal"
                    onClick={() => record(habit)}>{t('recordFor', { name: member.username })}</Button>
                </div>}
              </li>
            })}
          </ul>}
        </section>
        <section aria-labelledby="family-rewards-title" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 id="family-rewards-title" className="text-lg font-semibold">{t('rewards')}</h3>
            <Button type="button" disabled={busy || !canEditRewards} onClick={() => setRewardEditor({ memberId: member.id, item: null })}>{t('addReward')}</Button>
          </div>
          {!member.rewards.length ? <p>{t('noRewards')}</p> : <ul className="grid gap-3 lg:grid-cols-2">
            {member.rewards.map(item => <li key={item.id} className="min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground">
              <h4 className="break-words font-semibold">{item.name}</h4>
              {item.description && <p className="whitespace-pre-wrap break-words text-sm">{item.description}</p>}
              <p className="text-sm">{t('coins', { count: item.coinCost })}</p>
              {item.archived && <p className="text-sm font-medium">{t('archived')}</p>}
              {item.targetCompletions !== undefined && <p className="text-sm">{t('redemptionsLeft', { count: item.targetCompletions })}</p>}
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={busy || !canEditRewards} aria-label={t('editItem', { name: item.name })}
                  onClick={() => setRewardEditor({ memberId: member.id, item })}>{t('edit')}</Button>
                <Button type="button" className="h-auto min-h-9 whitespace-normal"
                  disabled={busy || !canRedeemRewards || item.archived || member.balance < item.coinCost}
                  onClick={() => { setError(''); setRedemption({ memberId: member.id, username: member.username, item }) }}>
                  {t('redeemFor', { name: member.username })}
                </Button>
              </div>
            </li>)}
          </ul>}
        </section>
      </div>}
    </>}
    {habitEditor && <AddEditHabitModal key={habitEditor.habit?.id ?? `${habitEditor.memberId}:${habitEditor.isTask}`}
      habit={habitEditor.habit} isTask={habitEditor.isTask} initialUserIds={initialHabitUsers}
      onClose={() => setHabitEditor(null)} onSave={async value => {
        if (!value.userIds?.includes(habitEditor.memberId)) throw new Error('Selected member must remain assigned')
        const saved = await saveHabit({ ...value, id: habitEditor.habit?.id, isTask: habitEditor.isTask })
        if (!saved) throw new Error('Could not save item')
        setHabitEditor(null)
        await refresh().catch(() => setError(t('refreshError')))
      }} />}
    {rewardEditor && <AddEditWishlistItemModal key={rewardEditor.item?.id ?? rewardEditor.memberId}
      isOpen setIsOpen={open => { if (!open) setRewardEditor(null) }} editingItem={rewardEditor.item}
      setEditingItem={item => { if (!item) setRewardEditor(null) }} initialUserIds={initialRewardUsers}
      addWishlistItem={async item => {
        if (!item.userIds?.includes(rewardEditor.memberId)) throw new Error('Selected member must remain assigned')
        await addWishlistItem(item)
        await refresh().catch(() => setError(t('refreshError')))
      }} editWishlistItem={async item => {
        if (!item.userIds?.includes(rewardEditor.memberId)) throw new Error('Selected member must remain assigned')
        await editWishlistItem(item)
        await refresh().catch(() => setError(t('refreshError')))
      }} />}
    <Dialog open={!!redemption} onOpenChange={open => { if (!open && !busyRef.current) setRedemption(null) }}>
      <DialogContent aria-describedby="family-redeem-description" className="w-[calc(100vw_-_2rem)] max-w-md">
        <DialogHeader><DialogTitle>{t('confirmRedemption')}</DialogTitle></DialogHeader>
        <p id="family-redeem-description">{redemption && t('redemptionMessage', {
          reward: redemption.item.name, name: redemption.username, count: redemption.item.coinCost,
        })}</p>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => setRedemption(null)}>{t('cancel')}</Button>
          <Button type="button" disabled={busy || !canRedeemRewards} onClick={redeem}>{t('confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
}
