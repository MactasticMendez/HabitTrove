'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { acceptFamilyInvite } from '@/app/actions/data'
import { getHouseholdInvite, acceptExistingHouseholdInvite } from '@/app/actions/family'
import type { PublicHouseholdInvite } from '@/lib/family-types'
import { signIn, signInWithAuthentik } from '@/app/actions/user'

export default function InviteAcceptance({ token, familiesEnabled = false, signedIn = false, authentikEnabled = false, oidcDisplayName = 'OIDC' }: {
  token: string; familiesEnabled?: boolean; signedIn?: boolean; authentikEnabled?: boolean; oidcDisplayName?: string
}) {
  const t = useTranslations('FamilyInvites')
  const tf = useTranslations('FamilyMembership')
  const accountText = useTranslations('AccountSecurity')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [offer, setOffer] = useState<PublicHouseholdInvite | null>(null)
  const [loading, setLoading] = useState(familiesEnabled)
  const [existing, setExisting] = useState(signedIn)
  useEffect(() => { if (signedIn) setExisting(true) }, [signedIn])

  useEffect(() => {
    if (!familiesEnabled) return
    let active = true
    setOffer(null); setLoading(true); setError('')
    getHouseholdInvite(token).then(value => {
      if (!active) return
      if (value) setOffer(value)
      else setError(tf('invalidInvite'))
    }).catch(() => { if (active) setError(tf('invalidInvite')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [familiesEnabled, token, tf])

  const accept = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!existing && password !== confirmation) { setError(t('passwordMismatch')); return }
    setBusy(true); setError('')
    try {
      if (familiesEnabled && existing) {
        if (!signedIn) await signIn(username, password)
        await acceptExistingHouseholdInvite(token)
      } else {
        await acceptFamilyInvite(token, username, password)
        await signIn(username, password)
      }
      window.location.replace('/')
    } catch { setError(existing ? tf('existingAcceptError') : t('acceptError')) }
    finally { setBusy(false) }
  }

  return <main className="flex min-h-screen items-center justify-center bg-background p-4">
    <form onSubmit={accept} aria-busy={busy || loading} className="w-full min-w-0 max-w-md space-y-4 rounded-lg border bg-card p-6">
      <h1 className="text-2xl font-semibold">{t('acceptTitle')}</h1>
      {loading && <p role="status">{tf('loadingInvite')}</p>}
      {offer && <div className="space-y-2">
        <p className="break-words">{tf('offer', { family: offer.familyName, email: offer.maskedEmail, role: tf(`roles.${offer.role}`) })}</p>
        <p className="text-sm">{t('expires', { date: offer.expiresAt.slice(0, 10) })}</p>
      </div>}
      {(!familiesEnabled || offer) && <>
        {familiesEnabled ? <>
          <p className="text-sm text-muted-foreground">{tf('acceptExplanation')}</p>
          {!signedIn && <fieldset disabled={busy} className="space-y-2"><legend className="mb-2 font-medium">{tf('accountChoice')}</legend>
            <label className="flex min-h-10 items-center gap-3"><input type="radio" name="account" checked={!existing} onChange={() => { setExisting(false); setPassword(''); setError('') }} />{tf('newAccount')}</label>
            <label className="flex min-h-10 items-center gap-3"><input type="radio" name="account" checked={existing} onChange={() => { setExisting(true); setPassword(''); setConfirmation(''); setError('') }} />{tf('existingAccount')}</label>
          </fieldset>}
          {existing && <p className="text-sm">{signedIn ? tf('signedInAccept') : tf('signInInvited')}</p>}
        </> : <p className="text-sm text-muted-foreground">{t('acceptDescription')}</p>}
        {!(existing && signedIn) && <>
          <div className="space-y-2"><Label htmlFor="invite-username">{t('username')}</Label>
            <Input id="invite-username" value={username} onChange={event => setUsername(event.target.value)} minLength={existing ? undefined : 3} maxLength={20}
              pattern={existing ? undefined : '[A-Za-z0-9]+'} autoComplete="username" disabled={busy} required /></div>
          <div className="space-y-2"><Label htmlFor="invite-password">{t('password')}</Label>
            <Input id="invite-password" type="password" value={password} onChange={event => setPassword(event.target.value)} minLength={existing ? undefined : 12}
              maxLength={128} autoComplete={existing ? 'current-password' : 'new-password'} disabled={busy} required /></div>
          {!existing && <div className="space-y-2"><Label htmlFor="invite-confirm">{t('confirmPassword')}</Label>
            <Input id="invite-confirm" type="password" value={confirmation} onChange={event => setConfirmation(event.target.value)} minLength={12} maxLength={128} autoComplete="new-password" disabled={busy} required /></div>}
        </>}
        <Button type="submit" className="h-auto min-h-10 w-full whitespace-normal" disabled={busy || loading}>{busy ? t('saving') : existing ? tf('acceptExisting') : t('accept')}</Button>
        {familiesEnabled && existing && !signedIn && authentikEnabled && <Button type="button" variant="outline"
          className="h-auto min-h-10 w-full whitespace-normal" disabled={busy || loading}
          onClick={() => { void signInWithAuthentik(`/invite/${token}`).catch(() => setError(tf('existingAcceptError'))) }}>
          {accountText('continueAuthentik', { name: oidcDisplayName })}
        </Button>}
      </>}
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
    </form>
  </main>
}
