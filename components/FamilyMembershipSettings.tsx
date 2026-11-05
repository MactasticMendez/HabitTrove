'use client'

import { useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import { createFamily, renameFamily, updateFamilyMembership, previewRemoveFamilyMember, removeFamilyMember } from '@/app/actions/family'
import type { FamilyState, FamilyMemberInfo, FamilyRole, FamilyRemovalImpact } from '@/lib/family-types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import FamilyInvites from './FamilyInvites'

export default function FamilyMembershipSettings({ state, isSiteAdmin, onChanged }: {
  state: FamilyState; isSiteAdmin: boolean; onChanged: () => Promise<void>
}) {
  const t = useTranslations('FamilyMembership')
  const family = state.families.find(value => value.id === state.selectedFamilyId)
  const canManage = !!family && (family.role === 'owner' || isSiteAdmin)
  const [name, setName] = useState('')
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [removal, setRemoval] = useState<{ member: FamilyMemberInfo; impact: FamilyRemovalImpact } | null>(null)
  const [change, setChange] = useState<{ member: FamilyMemberInfo; role: FamilyRole; managedUserIds: string[] } | null>(null)

  const run = async (operation: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await operation() } catch { setError(t('actionError')) }
    finally { setBusy(false) }
  }

  const saveName = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void run(async () => {
      if (family) await renameFamily(family.id, name.trim())
      else await createFamily(name.trim())
      setName(''); await onChanged(); setNotice(t('saved'))
    })
  }

  return <div className="min-w-0 space-y-6">
    <Card><CardHeader><CardTitle>{family ? family.name : t('noFamilyTitle')}</CardTitle></CardHeader>
      <CardContent className="min-w-0 space-y-4">
        {!family && <p>{t('noFamily')}</p>}
        {family && <>
          <p className="text-sm">{t('membershipExplanation')}</p>
          <p className="text-sm">{t('globalWalletExplanation')}</p>
          {canManage && <p className="text-sm">{t('ownerAuthority')}</p>}
          <ul aria-label={t('members')} className="space-y-3">
            {state.members.filter(member => member.active).map(member => <MembershipRow key={`${family.id}:${member.id}:${member.role}:${member.managedUserIds.join(',')}`}
              member={member} members={state.members} canManage={canManage} busy={busy}
              onSave={(role, managedUserIds) => setChange({ member, role, managedUserIds })}
              onRemove={() => void run(async () => {
                const impact = await previewRemoveFamilyMember(family.id, member.id)
                setRemoval({ member, impact })
              })} />)}
          </ul>
          {canManage && <form onSubmit={saveName} className="flex min-w-0 flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1 basis-48 space-y-2"><Label htmlFor="family-name">{t('rename')}</Label>
              <Input id="family-name" value={name} onChange={event => setName(event.target.value)} required maxLength={100} disabled={busy} /></div>
            <Button type="submit" disabled={busy || !name.trim()}>{t('saveName')}</Button>
          </form>}
        </>}
        {!family && isSiteAdmin && <form onSubmit={saveName} className="space-y-3">
          <div className="space-y-2"><Label htmlFor="new-family-name">{t('familyName')}</Label>
            <Input id="new-family-name" value={name} onChange={event => setName(event.target.value)} required maxLength={100} disabled={busy} /></div>
          <Button type="submit" disabled={busy || !name.trim()}>{t('create')}</Button>
        </form>}
        {error && <p role="alert" className="text-red-700 dark:text-red-400">{error}</p>}
        {notice && <p role="status">{notice}</p>}
      </CardContent>
    </Card>
    {isSiteAdmin && family && <Card><CardHeader><CardTitle>{t('createAnother')}</CardTitle></CardHeader><CardContent>
      <form className="flex flex-wrap items-end gap-3" onSubmit={event => {
        event.preventDefault(); void run(async () => { await createFamily(newName.trim()); setNewName(''); await onChanged(); setNotice(t('saved')) })
      }}>
        <div className="min-w-0 flex-1 basis-48 space-y-2"><Label htmlFor="another-family-name">{t('familyName')}</Label>
          <Input id="another-family-name" value={newName} onChange={event => setNewName(event.target.value)} required maxLength={100} disabled={busy} /></div>
        <Button type="submit" disabled={busy || !newName.trim()}>{t('create')}</Button>
      </form>
    </CardContent></Card>}
    {canManage && family && <FamilyInvites familyId={family.id} members={state.members} />}
    <Dialog open={!!change} onOpenChange={open => { if (!open && !busy) setChange(null) }}>
      <DialogContent className="max-h-[90dvh] w-[calc(100vw_-_2rem)] max-w-md overflow-y-auto">
        <DialogTitle>{t('confirmRoleTitle')}</DialogTitle>
        <DialogDescription>{change && t('confirmRole', { name: change.member.username, role: t(`roles.${change.role}`) })}</DialogDescription>
        <p className="text-sm">{t('ownerAuthority')}</p>
        {error && <p role="alert" className="text-red-700 dark:text-red-400">{error}</p>}
        <DialogFooter className="gap-2"><Button variant="outline" disabled={busy} onClick={() => setChange(null)}>{t('cancel')}</Button>
          <Button disabled={busy} onClick={() => void run(async () => {
            if (!change || !family) return
            await updateFamilyMembership(family.id, change.member.id, { role: change.role, managedUserIds: change.managedUserIds })
            setChange(null); await onChanged(); setNotice(t('saved'))
          })}>{t('confirmChanges')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={!!removal} onOpenChange={open => { if (!open && !busy) setRemoval(null) }}>
      <DialogContent className="max-h-[90dvh] w-[calc(100vw_-_2rem)] max-w-md overflow-y-auto">
        <DialogTitle>{t('removeTitle')}</DialogTitle>
        <DialogDescription>{removal && t('removeDescription', { name: removal.member.username })}</DialogDescription>
        {removal && <ul className="list-disc space-y-2 pl-5 text-sm">
          <li>{t('archivedImpact', { count: removal.impact.archivedItemIds.length })}</li>
          <li>{t('withdrawnImpact', { count: removal.impact.withdrawnSubmissionIds.length })}</li>
          <li>{t('approverImpact', { count: removal.impact.reassignedApproverItemIds.length })}</li>
          <li>{t('delegationImpact', { count: removal.impact.removedDelegations })}</li>
          <li>{t('retainedImpact')}</li><li>{t('rejoinImpact')}</li>
        </ul>}
        {error && <p role="alert" className="text-red-700 dark:text-red-400">{error}</p>}
        <DialogFooter className="gap-2"><Button variant="outline" disabled={busy} onClick={() => setRemoval(null)}>{t('cancel')}</Button>
          <Button variant="destructive" className="bg-red-700 text-white hover:bg-red-800" disabled={busy} onClick={() => void run(async () => {
            if (!removal || !family) return
            await removeFamilyMember(family.id, removal.member.id, removal.impact.revision)
            setRemoval(null); await onChanged(); setNotice(t('removed'))
          })}>{t('confirmRemoval')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}

function MembershipRow({ member, members, canManage, busy, onSave, onRemove }: {
  member: FamilyMemberInfo; members: FamilyMemberInfo[]; canManage: boolean; busy: boolean;
  onSave: (role: FamilyRole, managedUserIds: string[]) => void; onRemove: () => void
}) {
  const t = useTranslations('FamilyMembership')
  const [role, setRole] = useState<FamilyRole>(member.role)
  const [managedIds, setManagedIds] = useState(member.managedUserIds)
  const assignedNames = members.filter(candidate => member.managedUserIds.includes(candidate.id)).map(candidate => candidate.username).join(', ')
  return <li className="min-w-0 space-y-3 rounded-lg border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="break-words font-semibold">{member.username}</h3>
      <span className="text-sm">{t(`roles.${member.role}`)}</span></div>
    <p className="break-words text-sm">{assignedNames ? t('managesMembers', { names: assignedNames }) : t('managesNobody')}</p>
    {canManage && <form className="space-y-3" onSubmit={event => { event.preventDefault(); onSave(role, role === 'member' ? [] : managedIds) }}>
      <div className="space-y-2"><Label htmlFor={`membership-role-${member.id}`}>{t('role')}</Label>
        <select id={`membership-role-${member.id}`} value={role} disabled={busy}
          className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm"
          onChange={event => setRole(event.target.value as FamilyRole)}>
          {(['member', 'manager', 'owner'] as const).map(value => <option key={value} value={value}>{t(`roles.${value}`)}</option>)}
        </select></div>
      {role !== 'member' && <fieldset disabled={busy} className="space-y-2"><legend className="mb-2 text-sm font-medium">{t('assignedMembers')}</legend>
        {members.filter(candidate => candidate.active && candidate.id !== member.id).map(candidate => <label key={candidate.id} className="flex min-h-10 items-center gap-3 rounded border p-2 text-sm">
          <input type="checkbox" className="h-4 w-4 shrink-0" checked={managedIds.includes(candidate.id)} onChange={event => setManagedIds(previous => event.target.checked ? [...previous, candidate.id] : previous.filter(id => id !== candidate.id))} />
          <span className="break-words">{candidate.username}</span>
        </label>)}
      </fieldset>}
      <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy}>{t('reviewChanges')}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onRemove}>{t('reviewRemoval')}</Button></div>
    </form>}
  </li>
}
