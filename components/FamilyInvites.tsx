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
import { createHouseholdInvite, listHouseholdInvites, revokeHouseholdInvite } from '@/app/actions/family'
import type { FamilyMemberInfo } from '@/lib/family-types'

type Invite = Awaited<ReturnType<typeof listFamilyInvites>>[number]

export default function FamilyInvites({ familyId, members = [] }: { familyId?: string; members?: FamilyMemberInfo[] }) {
  const t = useTranslations('FamilyInvites')
  const tf = useTranslations('FamilyMembership')
  const [users] = useAtom(usersAtom)
  const [email, setEmail] = useState('')
  const [managerId, setManagerId] = useState('')
  const [role, setRole] = useState<'member' | 'manager'>('member')
  const [invites, setInvites] = useState<Invite[]>([])
  const [link, setLink] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setInvites([]); setLink(''); setError(''); setManagerId('')
    const request = familyId ? listHouseholdInvites(familyId) : listFamilyInvites()
    void request.then(value => { if (active) setInvites(value.filter(invite => !('consumed' in invite && invite.consumed) && !('revoked' in invite && invite.revoked))) })
      .catch(() => { if (active) setError(t('loadError')) })
    return () => { active = false }
  }, [familyId, t])

  const refresh = async () => {
    const result = familyId ? await listHouseholdInvites(familyId) : await listFamilyInvites()
    setInvites(result.filter(invite => !('consumed' in invite && invite.consumed) && !('revoked' in invite && invite.revoked)))
  }

  const invite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const result = familyId ? await createHouseholdInvite(familyId, email, role, managerId || undefined)
        : await createFamilyInvite(email, managerId || undefined)
      setLink(new URL(`/invite/${encodeURIComponent(result.token)}`, window.location.origin).href)
      setSent(result.sent)
      setEmail('')
      await refresh()
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
      if (familyId) await revokeHouseholdInvite(familyId, hash)
      else await revokeFamilyInvite(hash)
      await refresh()
      setLink('')
    } catch { setError(t('revokeError')) }
    finally { setBusy(false) }
  }

  return <Card className="mb-6">
    <CardHeader><CardTitle>{t('title')}</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">{familyId ? tf('inviteDescription') : t('description')}</p>
      <form onSubmit={invite} className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-48 space-y-2"><Label htmlFor="invite-email">{t('email')}</Label>
          <Input id="invite-email" type="email" value={email} onChange={event => setEmail(event.target.value)} required maxLength={254} /></div>
        {familyId && <div className="min-w-0 flex-1 basis-40 space-y-2"><Label htmlFor="invite-role">{tf('role')}</Label>
          <select id="invite-role" className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm" value={role} disabled={busy}
            onChange={event => setRole(event.target.value as 'member' | 'manager')}>
            <option value="member">{tf('roles.member')}</option><option value="manager">{tf('roles.manager')}</option>
          </select></div>}
        <div className="min-w-0 flex-1 basis-48 space-y-2"><Label htmlFor="invite-manager">{t('manager')}</Label>
          <select id="invite-manager" className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            disabled={busy} value={managerId} onChange={event => setManagerId(event.target.value)}>
            <option value="">{t('noManager')}</option>
            {(familyId ? members.filter(member => member.active && member.role !== 'member') : users.users).map(user => <option key={user.id} value={user.id}>{user.username}</option>)}
          </select></div>
        <Button type="submit" disabled={busy}>{t('send')}</Button>
      </form>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
      {link && <div role="status" className="space-y-2 rounded border p-3">
        <p>{sent ? t('sent') : t('notSent')}</p>
        <Label htmlFor="invite-link">{t('link')}</Label>
        <Input id="invite-link" value={link} readOnly onFocus={event => event.currentTarget.select()} />
        <Button type="button" variant="outline" onClick={() => void navigator.clipboard.writeText(link).catch(() => setError(tf('copyError')))}>{t('copy')}</Button>
      </div>}
      {invites.length > 0 && <div><h3 className="mb-2 font-medium">{t('pending')}</h3>
        <ul className="space-y-2">{invites.map(invite => <li key={invite.tokenHash} className="flex flex-wrap items-center justify-between gap-3 rounded border p-2">
          <span className="min-w-0 break-all">{invite.email} · {t('expires', { date: invite.expiresAt.slice(0, 10) })}</span>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void revoke(invite.tokenHash)}
            aria-label={t('revokeFor', { email: invite.email })}>{t('revoke')}</Button>
        </li>)}</ul></div>}
    </CardContent>
  </Card>
}
