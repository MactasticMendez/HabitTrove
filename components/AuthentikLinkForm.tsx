'use client'

import { useActionState } from 'react'
import { startAuthentikLink } from '@/app/actions/user'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { useTranslations } from 'next-intl'

export default function AuthentikLinkForm() {
  const t = useTranslations('AccountSecurity')
  const [state, action, pending] = useActionState(startAuthentikLink, { error: '' })

  return (
    <form action={action} className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('linkDescription')}</p>
      <div className="space-y-2">
        <Label htmlFor="link-current-password">{t('currentPassword')}</Label>
        <Input id="link-current-password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
      <Button type="submit" disabled={pending}>{t('linkAuthentik')}</Button>
    </form>
  )
}
