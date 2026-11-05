'use server'

import { getCurrentUser } from '@/lib/server-helpers'
import { readAuthData, verifyStepUpPassword } from '@/lib/auth-store'
import { getAdminConfigSummary, getLegacyOidcIssuer, saveLogLevel, saveOidcConfig, saveOidcDisplayName, saveSmtpConfig } from '@/lib/admin-config'
import { PermissionError } from '@/lib/exceptions'
import { withStorageTransaction } from '@/lib/db/client'
import { usesPostgres } from '@/lib/storage-mode'
import type { User } from '@/lib/types'

async function requireAdministrator() {
  const user = await getCurrentUser()
  if (!user?.isAdmin || !user.email || process.env.DEMO === 'true') {
    throw new PermissionError('Administrator access required')
  }
  return user
}

async function withFreshAdministrator<T>(checked: User, update: () => Promise<T>): Promise<T> {
  if (!usesPostgres()) return update()
  return withStorageTransaction(async () => {
    const fresh = (await readAuthData()).users.find(user => user.id === checked.id)
    if (!fresh?.isAdmin || !fresh.email || process.env.DEMO === 'true' ||
        fresh.email !== checked.email || (fresh.authVersion ?? 0) !== (checked.authVersion ?? 0) ||
        fresh.password !== checked.password) {
      throw new PermissionError('Administrator access required')
    }
    return update()
  })
}

async function adminSummary() {
  const [settings, authData] = await Promise.all([getAdminConfigSummary(), readAuthData()])
  return {
    ...settings,
    linkedAccountCount: authData.users.filter(account => account.oidcSubject).length,
    oidcOnlyAccountCount: authData.users.filter(account => account.oidcSubject && !account.password).length,
  }
}

export async function loadAdminPanelSettings() {
  await requireAdministrator()
  return adminSummary()
}

export async function updateApplicationLogLevel(level: string) {
  const user = await requireAdministrator()
  return withFreshAdministrator(user, async () => {
    await saveLogLevel(level)
    return adminSummary()
  })
}

export async function updateOidcDisplayName(name: string) {
  const user = await requireAdministrator()
  return withFreshAdministrator(user, async () => {
    await saveOidcDisplayName(name)
    return adminSummary()
  })
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
  if (!(await verifyStepUpPassword(user, input.currentPassword))) throw new PermissionError('Current local password is incorrect')
  return withFreshAdministrator(user, async () => {
    if (!input.enabled && (await readAuthData()).users.some(account => account.oidcSubject && !account.password)) {
      throw new PermissionError('Set local passwords for OIDC-only accounts before disabling OIDC sign-in')
    }
    if (input.enabled) {
      const linkedAccounts = (await readAuthData()).users.filter(account => account.oidcSubject)
      const legacyIssuer = linkedAccounts.some(account => !account.oidcIssuer) ? await getLegacyOidcIssuer() : undefined
      if (linkedAccounts.some(account => (account.oidcIssuer ?? legacyIssuer) !== input.issuer?.trim())) {
        throw new PermissionError('Unlink existing OIDC accounts before changing the issuer')
      }
    }
    await saveOidcConfig(input)
    return adminSummary()
  })
}

export async function updateSmtpSettings(input: {
  enabled: boolean; host: string; port: number; secure: boolean; from: string;
  username: string; password: string; currentPassword: string
}) {
  const user = await requireAdministrator()
  if (typeof input?.currentPassword !== 'string' || input.currentPassword.length > 128 || !user.password ||
      !(await verifyStepUpPassword(user, input.currentPassword))) {
    throw new PermissionError('Current local password is incorrect')
  }
  return withFreshAdministrator(user, async () => {
    await saveSmtpConfig(input)
    return adminSummary()
  })
}
