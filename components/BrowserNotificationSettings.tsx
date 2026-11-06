'use client'

import { useEffect, useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { getBrowserNotificationPermission, requestBrowserNotificationPermission, showBrowserNotification,
  type BrowserNotificationPermission } from '@/lib/browser-notifications'

export default function BrowserNotificationSettings({ enabled }: { enabled: boolean }) {
  const t = useTranslations('BrowserNotifications')
  const helpId = useId()
  const [permission, setPermission] = useState<BrowserNotificationPermission>('unavailable')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<'testSent' | 'testFailed' | 'requestFailed' | null>(null)

  useEffect(() => {
    const refresh = () => {
      setPermission(getBrowserNotificationPermission())
      setFeedback(null)
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  if (!enabled) return null

  async function requestPermission() {
    setBusy(true)
    setFeedback(null)
    try { setPermission(await requestBrowserNotificationPermission()) }
    catch { setFeedback('requestFailed') }
    finally { setBusy(false) }
  }

  function testNotification() {
    setPermission(getBrowserNotificationPermission())
    setFeedback(showBrowserNotification(t('testTitle'), { body: t('testBody'), tag: 'habittrove-notification-test' })
      ? 'testSent' : 'testFailed')
  }

  return <div className="space-y-2 rounded-md border p-3">
    <h3 className="font-medium">{t('title')}</h3>
    <p id={helpId} className="text-sm text-muted-foreground">{t('help')}</p>
    <p role="status" aria-live="polite" className="text-sm">{feedback ? t(feedback) : t(permission)}</p>
    {permission === 'default' && <Button type="button" variant="outline" disabled={busy} aria-describedby={helpId}
      onClick={requestPermission}>{t(busy ? 'requesting' : 'enable')}</Button>}
    {permission === 'granted' && <Button type="button" variant="outline" aria-describedby={helpId}
      onClick={testNotification}>{t('test')}</Button>}
  </div>
}
