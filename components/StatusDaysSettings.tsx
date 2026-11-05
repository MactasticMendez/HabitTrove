'use client'

import { useState } from 'react'
import { DateTime } from 'luxon'
import { useAtom } from 'jotai'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { currentUserAtom, settingsAtom, usersAtom, serverSettingsAtom } from '@/lib/atoms'
import { saveStatusDays } from '@/app/actions/data'
import type { StatusDay } from '@/lib/types'
import { useTranslations } from 'next-intl'

export default function StatusDaysSettings() {
  const t = useTranslations('StatusDays')
  const [currentUser] = useAtom(currentUserAtom)
  const [settings] = useAtom(settingsAtom)
  const [serverSettings] = useAtom(serverSettingsAtom)
  const canUsePreferences = !serverSettings.familiesEnabled || serverSettings.familyMember === true
  const [, setUsers] = useAtom(usersAtom)
  const [date, setDate] = useState(DateTime.now().setZone(settings.system.timezone).toISODate() ?? '')
  const [status, setStatus] = useState<StatusDay['status']>('sick')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const days = currentUser?.statusDays ?? []

  const save = async (next: StatusDay[]) => {
    if (!currentUser || !canUsePreferences) return
    setBusy(true)
    setError('')
    try {
      const saved = await saveStatusDays(next)
      setUsers(previous => ({ ...previous, users: previous.users.map(user =>
        user.id === currentUser.id ? { ...user, statusDays: saved } : user) }))
    } catch {
      setError(t('saveError'))
    } finally {
      setBusy(false)
    }
  }

  if (!canUsePreferences) return null
  return <Card className="mb-6">
    <CardHeader><CardTitle>{t('title')}</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-2"><Label htmlFor="status-date">{t('date')}</Label>
          <Input id="status-date" type="date" value={date} onChange={event => setDate(event.target.value)} required /></div>
        <div className="space-y-2"><Label htmlFor="status-type">{t('status')}</Label>
          <select id="status-type" className="flex h-9 rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={status} onChange={event => setStatus(event.target.value as StatusDay['status'])}>
            {(['sick', 'travel', 'rest', 'other'] as const).map(value =>
              <option key={value} value={value}>{t(value)}</option>)}
          </select></div>
        <Button type="button" disabled={busy || !date} onClick={() => void save([...days.filter(day => day.date !== date), { date, status }])}>{t('add')}</Button>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {days.length > 0 && <ul className="space-y-2">{days.map(day => <li key={day.date} className="flex items-center justify-between gap-3 rounded border p-2">
        <span>{day.date} · {t(day.status)}</span>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void save(days.filter(entry => entry.date !== day.date))}
          aria-label={t('removeDate', { date: day.date })}>{t('remove')}</Button>
      </li>)}</ul>}
    </CardContent>
  </Card>
}
