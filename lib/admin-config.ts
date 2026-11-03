import 'server-only'
import fs from 'fs/promises'
import { readFileSync } from 'fs'
import path from 'path'
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'crypto'
import { z } from 'zod'

export const logLevels = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = typeof logLevels[number]
export const defaultOidcDisplayName = 'OIDC'

const oidcDisplayNameSchema = z.string().trim().max(64).refine(
  name => !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(name),
  'The OIDC sign-in name must be plain text',
)

export interface OidcConfig {
  providerId: 'oidc' | 'authentik'
  issuer: string
  clientId: string
  clientSecret: string
}

const oidcSchema = z.object({
  issuer: z.string().trim().min(1).max(2048).url(),
  clientId: z.string().trim().min(1).max(255),
  clientSecret: z.string().min(1).max(4096),
}).strict().superRefine((value, context) => {
  const url = new URL(value.issuer)
  if ((url.protocol !== 'https:' && !(process.env.NODE_ENV === 'development' && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash ||
      /[\x00-\x1f\x7f]/.test(value.clientId + value.clientSecret)) {
    context.addIssue({ code: 'custom', message: 'Invalid OIDC provider configuration' })
  }
})

const storedSchema = z.object({
  version: z.literal(1),
  logLevel: z.enum(logLevels),
  oidcDisplayName: oidcDisplayNameSchema.optional(),
  legacyIssuer: z.string().optional(),
  oidcOverride: z.union([z.object({
    issuer: z.string(),
    clientId: z.string(),
    encryptedClientSecret: z.string(),
  }).strict(), z.null()]).optional(),
}).strict()

type StoredAdminConfig = z.infer<typeof storedSchema>

const configPath = () => path.join(process.cwd(), 'data', 'admin-config.json')
let writeQueue: Promise<void> = Promise.resolve()

function secretKey(): Buffer {
  const authSecret = process.env.AUTH_SECRET
  if (!authSecret || authSecret.length < 32) throw new Error('AUTH_SECRET is required for OIDC configuration')
  return Buffer.from(hkdfSync('sha256', authSecret, 'HabitTrove admin config v1', 'OIDC client secret', 32))
}

function encryptSecret(secret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv)
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.')
}

function decryptSecret(value: string): string {
  const parts = value.split('.')
  if (parts.length !== 3) throw new Error('Invalid OIDC configuration')
  try {
    const [iv, tag, encrypted] = parts.map(part => Buffer.from(part, 'base64url'))
    if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid encrypted secret')
    const decipher = createDecipheriv('aes-256-gcm', secretKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Cannot decrypt OIDC configuration')
  }
}

async function readStoredConfig(): Promise<StoredAdminConfig | undefined> {
  try {
    return storedSchema.parse(JSON.parse(await fs.readFile(configPath(), 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function environmentOidcConfig(): OidcConfig | undefined {
  const { OIDC_ISSUER: genericIssuer, OIDC_CLIENT_ID: genericClientId, OIDC_CLIENT_SECRET: genericClientSecret } = process.env
  if (genericIssuer && genericClientId && genericClientSecret) {
    return { providerId: 'oidc', issuer: genericIssuer, clientId: genericClientId, clientSecret: genericClientSecret }
  }
  const { AUTHENTIK_ISSUER: issuer, AUTHENTIK_CLIENT_ID: clientId, AUTHENTIK_CLIENT_SECRET: clientSecret } = process.env
  return issuer && clientId && clientSecret ? { providerId: 'authentik', issuer, clientId, clientSecret } : undefined
}

function effectiveOidcConfig(stored?: StoredAdminConfig): OidcConfig | undefined {
  if (stored?.oidcOverride === null) return undefined
  if (stored?.oidcOverride) return {
    providerId: 'oidc',
    issuer: stored.oidcOverride.issuer,
    clientId: stored.oidcOverride.clientId,
    clientSecret: decryptSecret(stored.oidcOverride.encryptedClientSecret),
  }
  return environmentOidcConfig()
}

export async function readEffectiveOidcConfig(): Promise<OidcConfig | undefined> {
  return effectiveOidcConfig(await readStoredConfig())
}

export async function getLegacyOidcIssuer(): Promise<string | undefined> {
  return (await readStoredConfig())?.legacyIssuer ?? process.env.AUTHENTIK_ISSUER
}

export async function readStartupOidcConfig(): Promise<OidcConfig | undefined> {
  try {
    return await readEffectiveOidcConfig()
  } catch {
    console.error('Saved OIDC configuration could not be loaded; OIDC sign-in is disabled')
    return undefined
  }
}

const activeOidcConfig = readStartupOidcConfig()

export function getActiveOidcConfig(): Promise<OidcConfig | undefined> {
  return activeOidcConfig
}

export function getApplicationLogLevel(): LogLevel {
  try {
    return storedSchema.parse(JSON.parse(readFileSync(configPath(), 'utf8'))).logLevel
  } catch {
    return 'info'
  }
}

export async function getOidcDisplayName(): Promise<string> {
  try {
    return (await readStoredConfig())?.oidcDisplayName || defaultOidcDisplayName
  } catch {
    return defaultOidcDisplayName
  }
}

export async function getAdminConfigSummary() {
  const stored = await readStoredConfig()
  const oidc = effectiveOidcConfig(stored)
  const active = await getActiveOidcConfig()
  const callbackUrl = process.env.AUTH_URL
    ? new URL('/api/auth/callback/oidc', process.env.AUTH_URL).href
    : ''
  const activeCallbackUrl = active?.providerId === 'authentik' && process.env.AUTH_URL
    ? new URL('/api/auth/callback/authentik', process.env.AUTH_URL).href
    : undefined
  return {
    logLevel: stored?.logLevel ?? 'info',
    oidc: {
      enabled: !!oidc,
      displayName: stored?.oidcDisplayName || defaultOidcDisplayName,
      issuer: oidc?.issuer ?? '',
      clientId: oidc?.clientId ?? '',
      secretConfigured: !!oidc?.clientSecret,
      source: stored?.oidcOverride === undefined ? (oidc ? 'environment' : 'none') : 'admin',
      restartRequired: JSON.stringify(oidc) !== JSON.stringify(active),
      callbackUrl,
      activeCallbackUrl,
    },
  }
}

async function updateStoredConfig(update: (current: StoredAdminConfig) => StoredAdminConfig): Promise<void> {
  const prior = writeQueue
  let release: () => void = () => {}
  writeQueue = new Promise<void>(resolve => { release = resolve })
  await prior
  try {
    const next = storedSchema.parse(update((await readStoredConfig()) ?? { version: 1, logLevel: 'info' }))
    const file = configPath()
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 })
      await fs.rename(temporary, file)
    } finally {
      await fs.rm(temporary, { force: true })
    }
  } finally {
    release()
  }
}

export async function saveLogLevel(value: unknown): Promise<void> {
  const level = z.enum(logLevels).parse(value)
  await updateStoredConfig(current => ({ ...current, logLevel: level }))
}

export async function saveOidcDisplayName(value: unknown): Promise<void> {
  const name = oidcDisplayNameSchema.parse(value) || defaultOidcDisplayName
  await updateStoredConfig(current => ({ ...current, oidcDisplayName: name }))
}

export async function saveOidcConfig(input: {
  enabled: boolean
  issuer: string
  clientId: string
  clientSecret: string
}): Promise<void> {
  if (typeof input?.enabled !== 'boolean') throw new Error('Invalid OIDC settings')
  if (input.enabled && !process.env.AUTH_URL) throw new Error('AUTH_URL is required before enabling OIDC')
  await updateStoredConfig(current => {
    if (!input.enabled) return { ...current, oidcOverride: null }
    const previousIdentity = current.oidcOverride === null ? undefined : current.oidcOverride ?? environmentOidcConfig()
    const sameIdentity = previousIdentity?.issuer === input.issuer?.trim() &&
      previousIdentity?.clientId === input.clientId?.trim()
    if (!input.clientSecret && !sameIdentity) {
      throw new Error('A new client secret is required when changing the issuer or client ID')
    }
    const previous = input.clientSecret ? undefined : effectiveOidcConfig(current)
    const config = oidcSchema.parse({
      issuer: input.issuer,
      clientId: input.clientId,
      clientSecret: input.clientSecret || previous?.clientSecret,
    })
    return { ...current, oidcOverride: {
      issuer: config.issuer,
      clientId: config.clientId,
      encryptedClientSecret: encryptSecret(config.clientSecret),
    }, legacyIssuer: current.legacyIssuer ?? process.env.AUTHENTIK_ISSUER }
  })
}
