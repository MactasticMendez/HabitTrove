export type BrowserNotificationPermission = NotificationPermission | 'unavailable'

export function getBrowserNotificationPermission(): BrowserNotificationPermission {
  return typeof window !== 'undefined' && window.isSecureContext && 'Notification' in window
    ? window.Notification.permission : 'unavailable'
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
  const permission = getBrowserNotificationPermission()
  return permission === 'default' ? window.Notification.requestPermission() : permission
}

export function showBrowserNotification(title: string, options?: NotificationOptions): boolean {
  if (getBrowserNotificationPermission() !== 'granted') return false
  try {
    new window.Notification(title, options)
    return true
  } catch {
    // Some platforms expose permission but do not support the page-level constructor.
    return false
  }
}
