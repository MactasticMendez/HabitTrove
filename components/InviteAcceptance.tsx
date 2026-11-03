'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { acceptFamilyInvite } from '@/app/actions/data'
import { signIn } from '@/app/actions/user'

export default function InviteAcceptance({ token }: { token: string }) {
  const t = useTranslations('FamilyInvites')
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const accept = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (password !== confirmation) { setError(t('passwordMismatch')); return }
    setBusy(true)
    setError('')
    try {
      await acceptFamilyInvite(token, username, password)
      await signIn(username, password)
      router.replace('/')
      router.refresh()
    } catch {
      setError(t('acceptError'))
    } finally { setBusy(false) }
  }

  return <main className="min-h-screen flex items-center justify-center bg-background p-4">
    <form onSubmit={accept} className="w-full max-w-md space-y-4 rounded-lg border bg-card p-6">
      <h1 className="text-2xl font-semibold">{t('acceptTitle')}</h1>
      <p className="text-sm text-muted-foreground">{t('acceptDescription')}</p>
      <div className="space-y-2"><Label htmlFor="invite-username">{t('username')}</Label>
        <Input id="invite-username" value={username} onChange={event => setUsername(event.target.value)} minLength={3} maxLength={20} pattern="[A-Za-z0-9]+" autoComplete="username" required /></div>
      <div className="space-y-2"><Label htmlFor="invite-password">{t('password')}</Label>
        <Input id="invite-password" type="password" value={password} onChange={event => setPassword(event.target.value)} minLength={12} maxLength={128} autoComplete="new-password" required /></div>
      <div className="space-y-2"><Label htmlFor="invite-confirm">{t('confirmPassword')}</Label>
        <Input id="invite-confirm" type="password" value={confirmation} onChange={event => setConfirmation(event.target.value)} minLength={12} maxLength={128} autoComplete="new-password" required /></div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={busy}>{busy ? t('saving') : t('accept')}</Button>
    </form>
  </main>
}
