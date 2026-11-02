'use client'

import { useState } from 'react'
import { updateUser } from '@/app/actions/data'
import { signOut } from '@/app/actions/user'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { useTranslations } from 'next-intl'

export default function CompleteEmailAccount({ userId, username }: { userId: string; username: string }) {
  const t = useTranslations('AccountSecurity')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await updateUser(userId, { email })
      window.location.reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('saveEmailError'))
      setBusy(false)
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-5 rounded-lg border bg-card p-6">
        <h1 className="text-2xl font-semibold">{t('addEmailTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('addEmailDescription', { username })}</p>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="required-account-email">{t('emailLabel')}</Label>
            <Input id="required-account-email" type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy}>{t('saveEmail')}</Button>
        </form>
        <Button variant="outline" onClick={async () => { await signOut(); window.location.reload() }}>{t('signOut')}</Button>
      </div>
    </main>
  )
}
