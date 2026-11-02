'use server'

import { getCurrentUser } from '@/lib/server-helpers'
import { authenticateLocalUser, readAuthData } from '@/lib/auth-store'
import { getAdminConfigSummary, getLegacyOidcIssuer, saveLogLevel, saveOidcConfig } from '@/lib/admin-config'
import { PermissionError } from '@/lib/exceptions'

async function requireAdministrator() {
  const user = await getCurrentUser()
  if (!user?.isAdmin || !user.email || process.env.DEMO === 'true') {
    throw new PermissionError('Administrator access required')
  }
  return user
}

async function adminSummary() {
  const [settings, authData] = await Promise.all([getAdminConfigSummary(), readAuthData()])
  return { ...settings, linkedAccountCount: authData.users.filter(account => account.authentikSubject).length }
}

export async function loadAdminPanelSettings() {
  await requireAdministrator()
  return adminSummary()
}

export async function updateApplicationLogLevel(level: string) {
  await requireAdministrator()
  await saveLogLevel(level)
  return adminSummary()
}

export async function updateOidcProvider(input: {
  enabled: boolean
  issuer: string
  clientId: string
  clientSecret: string
  currentPassword: string
}) {
  const user = await requireAdministrator()
  if (typeof input?.currentPassword !== 'string' || input.currentPassword.length > 128 || !user.password) {
    throw new PermissionError('Current local password is required')
  }
  const verified = await authenticateLocalUser(user.username, input.currentPassword)
  if (!verified || verified.id !== user.id) throw new PermissionError('Current local password is incorrect')
  if (input.enabled) {
    const linkedAccounts = (await readAuthData()).users.filter(account => account.authentikSubject)
    const legacyIssuer = linkedAccounts.some(account => !account.oidcIssuer) ? await getLegacyOidcIssuer() : undefined
    if (linkedAccounts.some(account => (account.oidcIssuer ?? legacyIssuer) !== input.issuer?.trim())) {
      throw new PermissionError('Unlink existing OIDC accounts before changing the issuer')
    }
  }
  await saveOidcConfig(input)
  return adminSummary()
}
