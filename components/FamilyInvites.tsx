'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useAtom } from 'jotai'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { usersAtom } from '@/lib/atoms'
import { createFamilyInvite, listFamilyInvites, revokeFamilyInvite } from '@/app/actions/data'

type Invite = Awaited<ReturnType<typeof listFamilyInvites>>[number]

export default function FamilyInvites() {
  const t = useTranslations('FamilyInvites')
  const [users] = useAtom(usersAtom)
  const [email, setEmail] = useState('')
  const [managerId, setManagerId] = useState('')
  const [invites, setInvites] = useState<Invite[]>([])
  const [link, setLink] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { void listFamilyInvites().then(setInvites).catch(() => setError(t('loadError'))) }, [t])

  const invite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const result = await createFamilyInvite(email, managerId || undefined)
      setLink(new URL(`/invite/${encodeURIComponent(result.token)}`, window.location.origin).href)
      setSent(result.sent)
      setEmail('')
      setInvites(await listFamilyInvites())
    } catch {
      setError(t('createError'))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (hash: string) => {
    setBusy(true)
    setError('')
    try {
      await revokeFamilyInvite(hash)
      setInvites(await listFamilyInvites())
      setLink('')
    } catch { setError(t('revokeError')) }
    finally { setBusy(false) }
  }

  return <Card className="mb-6">
    <CardHeader><CardTitle>{t('title')}</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <form onSubmit={invite} className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1 space-y-2"><Label htmlFor="invite-email">{t('email')}</Label>
          <Input id="invite-email" type="email" value={email} onChange={event => setEmail(event.target.value)} required maxLength={254} /></div>
        <div className="min-w-48 space-y-2"><Label htmlFor="invite-manager">{t('manager')}</Label>
          <select id="invite-manager" className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={managerId} onChange={event => setManagerId(event.target.value)}>
            <option value="">{t('noManager')}</option>
            {users.users.filter(user => !user.isAdmin).map(user => <option key={user.id} value={user.id}>{user.username}</option>)}
          </select></div>
        <Button type="submit" disabled={busy}>{t('send')}</Button>
      </form>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {link && <div role="status" className="space-y-2 rounded border p-3">
        <p>{sent ? t('sent') : t('notSent')}</p>
        <Label htmlFor="invite-link">{t('link')}</Label>
        <Input id="invite-link" value={link} readOnly onFocus={event => event.currentTarget.select()} />
        <Button type="button" variant="outline" onClick={() => void navigator.clipboard.writeText(link)}>{t('copy')}</Button>
      </div>}
      {invites.length > 0 && <div><h3 className="mb-2 font-medium">{t('pending')}</h3>
        <ul className="space-y-2">{invites.map(invite => <li key={invite.tokenHash} className="flex items-center justify-between gap-3 rounded border p-2">
          <span className="min-w-0 break-all">{invite.email} · {t('expires', { date: invite.expiresAt.slice(0, 10) })}</span>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void revoke(invite.tokenHash)}
            aria-label={t('revokeFor', { email: invite.email })}>{t('revoke')}</Button>
        </li>)}</ul></div>}
    </CardContent>
  </Card>
}
