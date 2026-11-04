'use client'

import { useEffect, useState } from 'react'
import { useAtom } from 'jotai'
import { habitsAtom, coinsAtom, usersAtom } from '@/lib/atoms'
import type { PendingApproval } from '@/lib/types'
import { loadPendingApprovals, reviewHabitCompletion } from '@/app/actions/data'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useTranslations } from 'next-intl'

export default function ApprovalQueue() {
  const t = useTranslations('ApprovalQueue')
  const [pending, setPending] = useState<PendingApproval[]>([])
  const [users] = useAtom(usersAtom)
  const [, setHabits] = useAtom(habitsAtom)
  const [, setCoins] = useAtom(coinsAtom)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadPendingApprovals().then(setPending).catch(() => setError(t('loadError'))).finally(() => setLoading(false))
  }, [t])

  const review = async (item: PendingApproval, decision: 'approve' | 'reject') => {
    setBusy(item.completionId)
    setError('')
    try {
      const result = await reviewHabitCompletion(item.habitId, item.completionId, decision)
      setPending(previous => previous.filter(entry => entry.completionId !== item.completionId))
      const updatedHabit = result.habit
      if (updatedHabit) {
        setHabits(previous => ({ habits: previous.habits.map(habit => habit.id === item.habitId ? updatedHabit : habit) }))
      }
      setCoins(result.coins)
    } catch {
      setError(t('reviewError'))
    } finally {
      setBusy(null)
    }
  }

  return <section aria-labelledby="approval-title" className="space-y-4">
    <h1 id="approval-title" className="text-2xl font-bold">{t('title')}</h1>
    <p className="text-sm text-foreground">{t('description')}</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {loading ? <p role="status">{t('loading')}</p> : pending.length === 0 ?
      <p>{t('empty')}</p> : <ul className="space-y-4">
        {pending.map(item => {
          const actor = users.users.find(user => user.id === item.actorId)
          const beneficiary = users.users.find(user => user.id === item.beneficiaryId)
          return <li key={item.completionId}>
            <Card>
              <CardHeader><CardTitle>{item.habitName}</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm">{t('submittedBy', { username: actor?.username ?? t('unknownUser') })}</p>
                {item.beneficiaryId && item.beneficiaryId !== item.actorId && <p className="text-sm">
                  {t('recordedFor', { username: beneficiary?.username ?? t('unknownUser') })}
                </p>}
                <p className="text-sm text-foreground">{new Date(item.submittedAt).toLocaleString()}</p>
                {item.evidenceId && <div>
                  <p className="mb-1 text-sm font-medium">{t('evidence')}</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/evidence/${item.evidenceId}`} alt={t('evidenceAlt', { name: item.habitName })}
                    className="max-h-72 max-w-full rounded border object-contain" />
                </div>}
                <div className="flex gap-2">
                  <Button type="button" disabled={busy !== null} onClick={() => review(item, 'approve')}>{t('approve')}</Button>
                  <Button type="button" variant="outline" disabled={busy !== null} onClick={() => review(item, 'reject')}>{t('reject')}</Button>
                </div>
              </CardContent>
            </Card>
          </li>
        })}
      </ul>}
  </section>
}
