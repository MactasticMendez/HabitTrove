'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import { useSetAtom } from 'jotai'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { loadAdminPanelSettings, updateApplicationLogLevel, updateOidcDisplayName, updateOidcProvider, updateSmtpSettings } from '@/app/actions/admin'
import type { LogLevel } from '@/lib/admin-config'
import { serverSettingsAtom } from '@/lib/atoms'

type Summary = Awaited<ReturnType<typeof loadAdminPanelSettings>>

export default function AdminConfiguration() {
  const t = useTranslations('SettingsPage')
  const setServerSettings = useSetAtom(serverSettingsAtom)
  const [summary, setSummary] = useState<Summary>()
  const [logLevel, setLogLevel] = useState<LogLevel>('info')
  const [enabled, setEnabled] = useState(false)
  const [issuer, setIssuer] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [displayName, setDisplayName] = useState('OIDC')
  const [currentPassword, setCurrentPassword] = useState('')
  const [savingLog, setSavingLog] = useState(false)
  const [savingOidc, setSavingOidc] = useState(false)
  const [savingDisplayName, setSavingDisplayName] = useState(false)
  const [smtpEnabled, setSmtpEnabled] = useState(false)
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState(587)
  const [smtpSecure, setSmtpSecure] = useState(false)
  const [smtpFrom, setSmtpFrom] = useState('')
  const [smtpUsername, setSmtpUsername] = useState('')
  const [smtpPassword, setSmtpPassword] = useState('')
  const [smtpCurrentPassword, setSmtpCurrentPassword] = useState('')
  const [savingSmtp, setSavingSmtp] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const providerIdentityChanged = issuer.trim() !== summary?.oidc.issuer || clientId.trim() !== summary?.oidc.clientId
  const issuerChangedWithLinkedAccounts = !!summary?.linkedAccountCount && issuer.trim() !== summary.oidc.issuer
  const disableWouldLockAccounts = !enabled && !!summary?.oidcOnlyAccountCount

  useEffect(() => {
    let mounted = true
    loadAdminPanelSettings().then(value => {
      if (!mounted) return
      setSummary(value)
      setLogLevel(value.logLevel)
      setEnabled(value.oidc.enabled)
      setIssuer(value.oidc.issuer)
      setClientId(value.oidc.clientId)
      setDisplayName(value.oidc.displayName)
      setSmtpEnabled(value.smtp.enabled)
      setSmtpHost(value.smtp.host)
      setSmtpPort(value.smtp.port)
      setSmtpSecure(value.smtp.secure)
      setSmtpFrom(value.smtp.from)
      setSmtpUsername(value.smtp.username)
    }).catch(() => { if (mounted) setError(t('adminLoadError')) })
    return () => { mounted = false }
  }, [t])

  const saveLog = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setNotice('')
    setSavingLog(true)
    try {
      setSummary(await updateApplicationLogLevel(logLevel))
      setNotice(t('logSaved'))
    } catch {
      setError(t('adminSaveError'))
    } finally {
      setSavingLog(false)
    }
  }

  const saveOidc = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setNotice('')
    setSavingOidc(true)
    try {
      const next = await updateOidcProvider({ enabled, issuer, clientId, clientSecret, currentPassword })
      setSummary(next)
      setNotice(t('oidcSaved'))
    } catch {
      setError(t('adminSaveError'))
    } finally {
      setClientSecret('')
      setCurrentPassword('')
      setSavingOidc(false)
    }
  }

  const saveDisplayName = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setNotice('')
    setSavingDisplayName(true)
    try {
      const next = await updateOidcDisplayName(displayName)
      setSummary(next)
      setDisplayName(next.oidc.displayName)
      setServerSettings(current => ({ ...current, oidcDisplayName: next.oidc.displayName }))
      setNotice(t('oidcDisplayNameSaved'))
    } catch {
      setError(t('adminSaveError'))
    } finally {
      setSavingDisplayName(false)
    }
  }

  const saveSmtp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setNotice('')
    setSavingSmtp(true)
    try {
      const next = await updateSmtpSettings({ enabled: smtpEnabled, host: smtpHost, port: smtpPort,
        secure: smtpSecure, from: smtpFrom, username: smtpUsername, password: smtpPassword,
        currentPassword: smtpCurrentPassword })
      setSummary(next)
      setNotice(t('smtpSaved'))
    } catch {
      setError(t('adminSaveError'))
    } finally {
      setSmtpPassword('')
      setSmtpCurrentPassword('')
      setSavingSmtp(false)
    }
  }

  return <div className="space-y-6">
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
    <Card>
      <CardHeader><CardTitle role="heading" aria-level={2}>{t('oidcTitle')}</CardTitle></CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-muted-foreground">{t('oidcDescription')}</p>
        <p className="mb-4 text-sm text-muted-foreground">{t('oidcSourceLabel')}: {summary ? t(`oidcSource.${summary.oidc.source}`) : t('loading')}</p>
        <form onSubmit={saveDisplayName} className="mb-6 flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1 space-y-2">
            <Label htmlFor="oidc-display-name">{t('oidcDisplayNameLabel')}</Label>
            <Input id="oidc-display-name" value={displayName} onChange={event => setDisplayName(event.target.value)} disabled={!summary || savingDisplayName} maxLength={64} autoComplete="off" aria-describedby="oidc-display-name-help" />
            <p id="oidc-display-name-help" className="text-sm text-muted-foreground">{t('oidcDisplayNameHelp')}</p>
          </div>
          <Button type="submit" disabled={!summary || savingDisplayName}>{savingDisplayName ? t('saving') : t('oidcDisplayNameSaveButton')}</Button>
        </form>
        <form onSubmit={saveOidc} className="space-y-4">
          <div className="flex items-center gap-3">
            <Switch id="oidc-enabled" className="min-h-6" checked={enabled} onCheckedChange={setEnabled} disabled={!summary || savingOidc} />
            <Label htmlFor="oidc-enabled">{t('oidcEnabledLabel')}</Label>
          </div>
          {disableWouldLockAccounts && <p role="alert" className="text-sm text-destructive">{t('oidcDisableAccountWarning')}</p>}
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('oidcCallbackLabel')}</p>
            <code className="block break-all rounded bg-muted p-2 text-sm">{summary?.oidc.callbackUrl || t('oidcCallbackMissing')}</code>
          </div>
          {summary?.oidc.activeCallbackUrl && <p className="text-sm text-muted-foreground">{t('oidcLegacyCallbackLabel')}: <code className="break-all">{summary.oidc.activeCallbackUrl}</code></p>}
          <div className="space-y-2">
            <Label htmlFor="oidc-issuer">{t('oidcIssuerLabel')}</Label>
            <Input id="oidc-issuer" type="url" value={issuer} onChange={event => setIssuer(event.target.value)} disabled={!enabled || savingOidc} required={enabled} maxLength={2048} autoComplete="url" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="oidc-client-id">{t('oidcClientIdLabel')}</Label>
            <Input id="oidc-client-id" value={clientId} onChange={event => setClientId(event.target.value)} disabled={!enabled || savingOidc} required={enabled} maxLength={255} autoComplete="off" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="oidc-client-secret">{t('oidcClientSecretLabel')}</Label>
            <Input id="oidc-client-secret" type="password" value={clientSecret} onChange={event => setClientSecret(event.target.value)} disabled={!enabled || savingOidc} required={enabled && (!summary?.oidc.secretConfigured || providerIdentityChanged)} maxLength={4096} autoComplete="off" />
            <p className="text-sm text-muted-foreground">{providerIdentityChanged ? t('oidcSecretNewIdentity') : summary?.oidc.secretConfigured ? t('oidcSecretStored') : t('oidcSecretRequired')}</p>
          </div>
          {enabled && issuerChangedWithLinkedAccounts && <p role="alert" className="text-sm text-destructive">{t('oidcIssuerLinkedWarning')}</p>}
          <div className="space-y-2">
            <Label htmlFor="oidc-current-password">{t('currentPasswordLabel')}</Label>
            <Input id="oidc-current-password" type="password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} required maxLength={128} autoComplete="current-password" />
          </div>
          <Button type="submit" disabled={!summary || savingOidc || disableWouldLockAccounts || (enabled && (!summary.oidc.callbackUrl || issuerChangedWithLinkedAccounts))}>{savingOidc ? t('saving') : t('oidcSaveButton')}</Button>
        </form>
        {summary?.oidc.restartRequired && <p role="status" className="mt-4 text-sm font-medium">{t('oidcRestartRequired')}</p>}
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle role="heading" aria-level={2}>{t('logLevelTitle')}</CardTitle></CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-muted-foreground">{t('logLevelDescription')}</p>
        <form onSubmit={saveLog} className="flex flex-wrap items-end gap-3">
          <div className="min-w-40 space-y-2">
            <Label htmlFor="application-log-level">{t('logLevelLabel')}</Label>
            <select id="application-log-level" value={logLevel} onChange={event => setLogLevel(event.target.value as LogLevel)} disabled={!summary || savingLog} className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
              <option value="debug">Debug</option>
              <option value="info">Info</option>
              <option value="warn">Warn</option>
              <option value="error">Error</option>
            </select>
          </div>
          <Button type="submit" disabled={!summary || savingLog}>{savingLog ? t('saving') : t('logSaveButton')}</Button>
        </form>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle role="heading" aria-level={2}>{t('smtpTitle')}</CardTitle></CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-muted-foreground">{t('smtpDescription')}</p>
        <form onSubmit={saveSmtp} className="space-y-4">
          <div className="flex items-center gap-3"><Switch id="smtp-enabled" checked={smtpEnabled} onCheckedChange={setSmtpEnabled} disabled={!summary || savingSmtp} />
            <Label htmlFor="smtp-enabled">{t('smtpEnabled')}</Label></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="smtp-host">{t('smtpHost')}</Label><Input id="smtp-host" value={smtpHost} onChange={event => setSmtpHost(event.target.value)} required={smtpEnabled} disabled={!smtpEnabled || savingSmtp} maxLength={253} autoComplete="off" /></div>
            <div className="space-y-2"><Label htmlFor="smtp-port">{t('smtpPort')}</Label><Input id="smtp-port" type="number" min={1} max={65535} value={smtpPort} onChange={event => setSmtpPort(Number(event.target.value))} required={smtpEnabled} disabled={!smtpEnabled || savingSmtp} /></div>
            <div className="space-y-2"><Label htmlFor="smtp-from">{t('smtpFrom')}</Label><Input id="smtp-from" type="email" value={smtpFrom} onChange={event => setSmtpFrom(event.target.value)} required={smtpEnabled} disabled={!smtpEnabled || savingSmtp} maxLength={254} /></div>
            <div className="space-y-2"><Label htmlFor="smtp-username">{t('smtpUsername')}</Label><Input id="smtp-username" value={smtpUsername} onChange={event => setSmtpUsername(event.target.value)} disabled={!smtpEnabled || savingSmtp} maxLength={255} autoComplete="off" /></div>
            <div className="space-y-2"><Label htmlFor="smtp-password">{t('smtpPassword')}</Label><Input id="smtp-password" type="password" value={smtpPassword} onChange={event => setSmtpPassword(event.target.value)} disabled={!smtpEnabled || savingSmtp} required={smtpEnabled && !!smtpUsername && (!summary?.smtp.passwordConfigured || smtpUsername !== summary.smtp.username)} maxLength={4096} autoComplete="new-password" />
              <p className="text-sm text-muted-foreground">{t('smtpPasswordHelp')}</p></div>
            <div className="flex items-center gap-3"><Switch id="smtp-secure" checked={smtpSecure} onCheckedChange={setSmtpSecure} disabled={!smtpEnabled || savingSmtp} /><Label htmlFor="smtp-secure">{t('smtpSecure')}</Label></div>
          </div>
          <div className="space-y-2"><Label htmlFor="smtp-current-password">{t('currentPasswordLabel')}</Label><Input id="smtp-current-password" type="password" value={smtpCurrentPassword} onChange={event => setSmtpCurrentPassword(event.target.value)} required maxLength={128} autoComplete="current-password" /></div>
          <Button type="submit" disabled={!summary || savingSmtp}>{savingSmtp ? t('saving') : t('smtpSave')}</Button>
        </form>
      </CardContent>
    </Card>
  </div>
}
