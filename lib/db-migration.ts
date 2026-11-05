import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import stringify from 'json-stable-stringify'
import type { AttachmentMetadata, DatabaseSnapshot } from './db/repository'
import { usesPostgres } from './storage-mode'

const documents = { auth: 'auth.json', habits: 'habits.json', coins: 'coins.json', wishlist: 'wishlist.json', settings: 'settings.json', adminConfig: 'admin-config.json' } as const
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
export const snapshotFingerprint = (snapshot: DatabaseSnapshot) => sha256(stringify(snapshot)!)
export interface MigrationManifest {
  format: 'habittrove-snapshot'; version: 1; snapshotDigest: string
  files: Record<string, { sha256: string; bytes: number }>
  counts: { users: number; habits: number; rewards: number; transactions: number; completions: number; legacyCompletions: number; voided: number; pending: number; approved: number; rejected: number; historicalReferences: number }
  ids: { users: string[]; habits: string[]; rewards: string[]; transactions: string[] }
  ledgerTotals: Record<string, string>
  assets: Record<string, { sha256: string; bytes: number }>
  attachmentMetadata?: AttachmentMetadata[]
  externalSecretsRequired: ['AUTH_SECRET']
}
export interface CapturedSource { snapshot: DatabaseSnapshot; manifest: MigrationManifest; digest: string; assets: Map<string, Buffer> }

export class MigrationValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'MigrationValidationError' }
}
function requireCondition(value: unknown, message: string): asserts value { if (!value) throw new MigrationValidationError(message) }
function validId(value: unknown) { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value) }
function uniqueIds(rows: { id: string }[], category: string) {
  requireCondition(Array.isArray(rows), `Invalid ${category} collection`)
  const ids = rows.map(row => { requireCondition(row && validId(row.id), `Invalid ${category} identifier`); return row.id })
  requireCondition(new Set(ids).size === ids.length, `Duplicate ${category} identifiers`)
  return ids
}
function decimalParts(value: number): [bigint, number] {
  const [coefficient, exponent = '0'] = String(value).toLowerCase().split('e')
  const [integer, fraction = ''] = coefficient.split('.')
  const scale = fraction.length - Number(exponent)
  return scale < 0 ? [BigInt(integer + fraction) * BigInt(10) ** BigInt(-scale), 0] : [BigInt(integer + fraction), scale]
}
function exactTotal(values: number[]) {
  const parts = values.map(decimalParts)
  const scale = parts.reduce((maximum, [, digits]) => Math.max(maximum, digits), 0)
  const sum = parts.reduce((total, [amount, digits]) => total + amount * BigInt(10) ** BigInt(scale - digits), BigInt(0))
  const sign = sum < BigInt(0) ? '-' : ''
  const text = (sum < BigInt(0) ? -sum : sum).toString().padStart(scale + 1, '0')
  return scale ? sign + `${text.slice(0, -scale)}.${text.slice(-scale)}`.replace(/\.?0+$/, '') : sign + text
}
function auditNumbers(value: unknown) {
  if (typeof value === 'number') requireCondition(Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER, 'Non-finite or unsafe numeric value')
  else if (Array.isArray(value)) value.forEach(auditNumbers)
  else if (value && typeof value === 'object') Object.values(value).forEach(auditNumbers)
}
export function validateSnapshot(snapshot: DatabaseSnapshot): Pick<MigrationManifest, 'counts' | 'ids' | 'ledgerTotals'> {
  requireCondition(snapshot && snapshot.auth && snapshot.habits && snapshot.wishlist && snapshot.coins && snapshot.settings, 'Missing required document')
  const ids = { users: uniqueIds(snapshot.auth.users, 'user'), habits: uniqueIds(snapshot.habits.habits, 'habit'), rewards: uniqueIds(snapshot.wishlist.items, 'reward'), transactions: uniqueIds(snapshot.coins.transactions, 'transaction') }
  auditNumbers(snapshot)
  requireCondition(typeof snapshot.coins.balance === 'number', 'Invalid stored balance')
  requireCondition(snapshot.settings.system && snapshot.settings.ui && snapshot.settings.profile, 'Invalid settings')
  const usernames = new Set<string>(), emails = new Set<string>(), identities = new Set<string>()
  const users = new Set(ids.users)
  const counts = { users: ids.users.length, habits: ids.habits.length, rewards: ids.rewards.length, transactions: ids.transactions.length, completions: 0, legacyCompletions: 0, voided: 0, pending: 0, approved: 0, rejected: 0, historicalReferences: 0 }
  const historical = (id: string | undefined) => { if (id && !users.has(id)) counts.historicalReferences++ }
  for (const user of snapshot.auth.users) {
    requireCondition(typeof user.username === 'string' && !!user.username, 'Invalid login identity')
    const username = user.username.toLowerCase()
    requireCondition(!usernames.has(username), 'Colliding login identities'); usernames.add(username)
    if (user.password !== undefined) requireCondition(typeof user.password === 'string', 'Invalid password hash')
    if (user.email) { const email = user.email.trim().toLowerCase(); requireCondition(!emails.has(email), 'Colliding email identities'); emails.add(email) }
    if (user.authentikSubject) { requireCondition(typeof user.authentikSubject === 'string', 'Invalid external identity'); const identity = JSON.stringify([user.oidcIssuer ?? '', user.authentikSubject]); requireCondition(!identities.has(identity), 'Colliding external identities'); identities.add(identity) }
    for (const id of user.managedUserIds ?? []) requireCondition(users.has(id), 'Manager references missing active account')
    if (user.personalFolders) uniqueIds(user.personalFolders, 'folder')
  }
  const eventIds = new Set<string>()
  for (const habit of snapshot.habits.habits) {
    requireCondition(typeof habit.coinReward === 'number' && Array.isArray(habit.completions), 'Invalid habit data')
    for (const id of [...habit.userIds ?? [], ...habit.approverIds ?? []]) requireCondition(users.has(id), 'Item references missing active account')
    requireCondition(habit.completionRecords === undefined || Array.isArray(habit.completionRecords) && habit.completionRecords.length === habit.completions.length, 'Completion alignment mismatch')
    habit.completions.forEach((timestamp, ordinal) => {
      requireCondition(typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)), 'Invalid completion timestamp')
      counts.completions++
      const record = habit.completionRecords?.[ordinal]
      if (record == null) { counts.legacyCompletions++; return }
      requireCondition(validId(record.id) && !eventIds.has(record.id), 'Invalid or duplicate completion identifier'); eventIds.add(record.id)
      requireCondition(validId(record.actorId), 'Invalid completion actor')
      historical(record.actorId); historical(record.beneficiaryId); historical(record.reviewedBy)
      record.rewardedUserIds?.forEach(historical)
      if (record.voided) counts.voided++
      if (record.approval) { requireCondition(['pending', 'approved', 'rejected'].includes(record.approval), 'Invalid approval state'); counts[record.approval]++ }
    })
    if (habit.slips) uniqueIds(habit.slips, 'slip')
    habit.slips?.forEach(slip => historical(slip.actorId))
    if (habit.checklist) uniqueIds(habit.checklist, 'checklist')
  }
  for (const item of snapshot.wishlist.items) {
    requireCondition(typeof item.coinCost === 'number', 'Invalid reward amount')
    item.userIds?.forEach(id => requireCondition(users.has(id), 'Reward references missing active account'))
  }
  const totals = new Map<string, number[]>()
  for (const transaction of snapshot.coins.transactions) {
    requireCondition(typeof transaction.amount === 'number', 'Invalid ledger amount')
    requireCondition(typeof transaction.timestamp === 'string' && Number.isFinite(Date.parse(transaction.timestamp)), 'Invalid ledger timestamp')
    const owner = transaction.userId ?? '__legacy_unassigned__'
    if (!totals.has(owner)) totals.set(owner, [])
    totals.get(owner)!.push(transaction.amount)
    historical(transaction.userId); historical(transaction.actorId)
  }
  // Legacy aggregate balance is independent data; never recalculate it from an incomplete historical ledger.
  const ledgerTotals = Object.fromEntries([...totals].map(([id, values]) => [id, exactTotal(values)]))
  return { counts, ids, ledgerTotals }
}

async function canonicalRoot(directory: string) {
  const absolute = path.resolve(directory)
  requireCondition(await fs.realpath(absolute) === absolute && (await fs.lstat(absolute)).isDirectory(), 'Source directory must be canonical and cannot contain symlinks')
  return absolute
}
async function safeRead(root: string, relative: string) {
  requireCondition(relative !== '' && !path.isAbsolute(relative) && !relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..'), 'Unsafe asset path')
  const target = path.join(root, relative)
  requireCondition(await fs.realpath(target) === target, 'Symlinked source is forbidden')
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    requireCondition(before.isFile() && before.size <= 64 * 1024 * 1024, 'Invalid or excessive source file')
    const bytes = await handle.readFile()
    const after = await handle.stat()
    requireCondition(before.size === bytes.length && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'Source changed during capture')
    const current = await fs.lstat(target)
    requireCondition(!current.isSymbolicLink() && current.dev === after.dev && current.ino === after.ino && await fs.realpath(target) === target, 'Source path changed during capture')
    return bytes
  } finally { await handle.close() }
}
async function captureAssets(root: string) {
  const assets = new Map<string, Buffer>(); let total = 0
  async function walk(relative: string) {
    let entries
    try { entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    requireCondition(await fs.realpath(path.join(root, relative)) === path.join(root, relative), 'Symlinked asset directory is forbidden')
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      requireCondition(!entry.isSymbolicLink(), 'Symlinked assets are forbidden')
      const name = `${relative}/${entry.name}`
      if (entry.isDirectory()) await walk(name)
      else { const bytes = await safeRead(root, name); total += bytes.length; requireCondition(total <= 512 * 1024 * 1024, 'Asset capture exceeds memory budget'); assets.set(name, bytes) }
    }
  }
  await walk('avatars'); await walk('evidence')
  return assets
}
function validateAssetReferences(snapshot: DatabaseSnapshot, assets: Map<string, Buffer>) {
  for (const user of snapshot.auth.users) if (user.avatarPath) {
    requireCondition(/^\/data\/avatars\/[a-zA-Z0-9-]+\.(png|jpe?g|gif|webp|avif)$/.test(user.avatarPath), 'Unsafe avatar reference')
    requireCondition(assets.has(user.avatarPath.slice('/data/'.length)), 'Referenced avatar is missing')
  }
  const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
  for (const habit of snapshot.habits.habits) for (const record of habit.completionRecords ?? []) if (record?.evidenceId) {
    requireCondition(/^[0-9a-f-]{36}$/i.test(record.evidenceId) && record.evidenceMime && record.evidenceMime in extensions, 'Unsafe evidence reference')
    requireCondition(assets.has(`evidence/${record.evidenceId}.${extensions[record.evidenceMime]}`), 'Referenced evidence is missing')
  }
}
function referencedAttachments(snapshot: DatabaseSnapshot, assets: Map<string, Buffer>): AttachmentMetadata[] {
  const metadata = new Map<string, AttachmentMetadata>()
  const avatarMime: Record<string, AttachmentMetadata['mime_type']> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' }
  for (const user of snapshot.auth.users) if (user.avatarPath) {
    const relative = user.avatarPath.slice('/data/'.length)
    const id = `avatar:${path.basename(relative)}`
    metadata.set(id, { id, owner_id: user.id, path: relative, mime_type: avatarMime[path.extname(relative).slice(1)], sha256: sha256(assets.get(relative)!) })
  }
  const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
  for (const habit of snapshot.habits.habits) for (const record of habit.completionRecords ?? []) if (record?.evidenceId && record.evidenceMime) {
    const relative = `evidence/${record.evidenceId}.${extensions[record.evidenceMime]}`
    requireCondition(!metadata.has(record.evidenceId), 'Evidence belongs to multiple completion records')
    metadata.set(record.evidenceId, { id: record.evidenceId, habit_id: habit.id, completion_id: record.id, owner_id: record.beneficiaryId ?? record.actorId, path: relative, mime_type: record.evidenceMime, sha256: sha256(assets.get(relative)!) })
  }
  return [...metadata.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'))
}
function captured(snapshot: DatabaseSnapshot, files: MigrationManifest['files'], assets: Map<string, Buffer>): CapturedSource {
  validateProtectedAssetMap(assets)
  const summary = validateSnapshot(snapshot); validateAssetReferences(snapshot, assets)
  const referenced = referencedAttachments(snapshot, assets)
  const attachments = snapshot.attachments?.length ? [...snapshot.attachments].sort((a, b) => a.id.localeCompare(b.id, 'en')) : referenced
  uniqueIds(attachments, 'attachment')
  for (const attachment of attachments) {
    requireCondition(typeof attachment.path === 'string' && /^(avatars|evidence)\/[^/\\]+$/.test(attachment.path) && assets.has(attachment.path), 'Unsafe or missing attachment asset')
    requireCondition(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(attachment.mime_type), 'Invalid attachment MIME type')
    requireCondition(attachment.sha256 === sha256(assets.get(attachment.path)!), 'Stored attachment hash does not match protected asset')
    for (const id of [attachment.owner_id, attachment.habit_id, attachment.completion_id]) requireCondition(id === undefined || validId(id), 'Invalid attachment relationship')
  }
  for (const required of referenced) requireCondition(stringify(attachments.find(attachment => attachment.id === required.id)) === stringify(required), 'Stored attachment metadata does not match reference')
  if (attachments.length) snapshot.attachments = attachments
  const manifest: MigrationManifest = { format: 'habittrove-snapshot', version: 1, snapshotDigest: snapshotFingerprint(snapshot), files, ...summary, assets: Object.fromEntries([...assets].map(([name, bytes]) => [name, { sha256: sha256(bytes), bytes: bytes.length }])), ...(attachments.length ? { attachmentMetadata: attachments } : {}), externalSecretsRequired: ['AUTH_SECRET'] }
  return { snapshot, manifest, digest: sha256(stringify(manifest)!), assets }
}
export async function captureLegacySource(directory: string): Promise<CapturedSource> {
  const root = await canonicalRoot(directory)
  const snapshot = {} as DatabaseSnapshot; const files: MigrationManifest['files'] = {}
  for (const [key, filename] of Object.entries(documents)) {
    let bytes
    try { bytes = await safeRead(root, filename) } catch (error) { if (key === 'adminConfig' && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    try { Object.assign(snapshot, { [key]: JSON.parse(bytes.toString('utf8')) }) } catch { throw new MigrationValidationError(`Invalid JSON in ${filename}`) }
    files[filename] = { sha256: sha256(bytes), bytes: bytes.length }
  }
  let savedManifest: Buffer | undefined
  try { savedManifest = await safeRead(root, 'manifest.json') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (savedManifest) {
    let metadata: MigrationManifest
    try { metadata = JSON.parse(savedManifest.toString('utf8')) } catch { throw new MigrationValidationError('Invalid snapshot manifest') }
    requireCondition(metadata.format === 'habittrove-snapshot' && metadata.version === 1, 'Unsupported snapshot manifest')
    if (metadata.attachmentMetadata !== undefined) { requireCondition(Array.isArray(metadata.attachmentMetadata), 'Invalid attachment metadata'); snapshot.attachments = metadata.attachmentMetadata }
  }
  const result = captured(snapshot, files, await captureAssets(root))
  if (savedManifest) requireCondition(sha256(await safeRead(root, 'manifest.json')) === sha256(savedManifest), 'Manifest changed during capture')
  // Detect offline sources changing between their first and final read.
  for (const [filename, expected] of Object.entries(files)) requireCondition(sha256(await safeRead(root, filename)) === expected.sha256, 'Source changed during capture')
  return result
}
export async function captureDatabaseSource(assetDirectory: string): Promise<CapturedSource> {
  const { exportDatabaseSnapshot } = await import('./db/repository')
  const { withStorageTransaction } = await import('./db/client')
  return withStorageTransaction(async () => {
    await requireLegacySnapshotMode()
    const snapshot = await exportDatabaseSnapshot()
    const files = Object.fromEntries(Object.entries(documents).filter(([key]) => key in snapshot).map(([key, filename]) => { const bytes = Buffer.from(JSON.stringify(snapshot[key as keyof DatabaseSnapshot], null, 2)); return [filename, { sha256: sha256(bytes), bytes: bytes.length }] }))
    return captured(snapshot, files, await captureAssets(await canonicalRoot(assetDirectory)))
  })
}
export async function importDatabaseSource(source: CapturedSource) {
  const { withStorageTransaction } = await import('./db/client')
  return withStorageTransaction(async () => {
    await requireLegacySnapshotMode()
    requireCondition(snapshotFingerprint(source.snapshot) === source.manifest.snapshotDigest && sha256(stringify(source.manifest)!) === source.digest, 'Source capture changed after validation')
    validateSnapshot(source.snapshot); validateAssetReferences(source.snapshot, source.assets)
    for (const [name, bytes] of source.assets) requireCondition(sha256(bytes) === source.manifest.assets[name]?.sha256, 'Asset changed after validation')
    const { importDatabaseSnapshot } = await import('./db/repository')
    const outcome = await importDatabaseSnapshot(source.snapshot, source.digest)
    await verifyDatabaseSource(source)
    return outcome
  })
}
export async function verifyDatabaseSource(source: CapturedSource) {
  const { exportDatabaseSnapshot } = await import('./db/repository')
  const { withStorageTransaction } = await import('./db/client')
  return withStorageTransaction(async () => {
    await requireLegacySnapshotMode()
    const actual = await exportDatabaseSnapshot()
    requireCondition(snapshotFingerprint(actual) === source.manifest.snapshotDigest, 'Database snapshot does not match source')
    requireCondition(stringify(validateSnapshot(actual)) === stringify(validateSnapshot(source.snapshot)), 'Database reconciliation failed')
  }, { readOnly: true })
}
export async function writeSnapshotDirectory(destination: string, source: CapturedSource) {
  validateProtectedAssetMap(source.assets)
  const target = path.resolve(destination)
  const parent = await canonicalRoot(path.dirname(target))
  requireCondition(target !== parent, 'Invalid export destination')
  await fs.mkdir(target, { mode: 0o700 }) // Must be new: never overwrite a rollback source.
  try {
    for (const [key, filename] of Object.entries(documents)) if (key in source.snapshot) await fs.writeFile(path.join(target, filename), JSON.stringify(source.snapshot[key as keyof DatabaseSnapshot], null, 2), { flag: 'wx', mode: 0o600 })
    for (const [name, bytes] of source.assets) { await fs.mkdir(path.dirname(path.join(target, name)), { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(target, name), bytes, { flag: 'wx', mode: 0o600 }) }
    // Seed private attachment metadata, then recalculate normalized JSON file hashes for the final manifest.
    await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(source.manifest, null, 2), { flag: 'wx', mode: 0o600 })
    const output = await captureLegacySource(target)
    await fs.writeFile(path.join(target, '.manifest.pending'), JSON.stringify(output.manifest, null, 2), { flag: 'wx', mode: 0o600 })
    await fs.rename(path.join(target, '.manifest.pending'), path.join(target, 'manifest.json'))
    return output
  } catch (error) { await fs.rm(target, { recursive: true, force: true }); throw error }
}
export async function verifySavedManifest(directory: string, source: CapturedSource) {
  const bytes = await safeRead(await canonicalRoot(directory), 'manifest.json')
  let manifest: unknown
  try { manifest = JSON.parse(bytes.toString('utf8')) } catch { throw new MigrationValidationError('Invalid snapshot manifest') }
  requireCondition(stringify(manifest) === stringify(source.manifest), 'Snapshot checksum manifest mismatch')
}

let assetQueue: Promise<unknown> = Promise.resolve()
/** Cleanup and capture share the repository write lock across app workers. */
export async function withProtectedAssetCapture<T>(operation: () => Promise<T>): Promise<T> {
  if (usesPostgres()) {
    const { withStorageTransaction } = await import('./db/client')
    return withStorageTransaction(operation)
  }
  const pending = assetQueue.then(operation, operation)
  assetQueue = pending.then(() => undefined, () => undefined)
  return pending
}
export const withProtectedAssetCleanup = withProtectedAssetCapture

export async function verifyProtectedAssets(directory: string, source: Pick<CapturedSource, 'assets'>) {
  const root = await canonicalRoot(directory)
  for (const [name, bytes] of source.assets) requireCondition((await safeRead(root, name)).equals(bytes), 'Protected assets do not match snapshot')
}

export async function captureProtectedAssets(directory: string) { return captureAssets(await canonicalRoot(directory)) }
export async function readSnapshotFile(directory: string, filename: string) { return safeRead(await canonicalRoot(directory), filename) }
export { canonicalRoot as canonicalSourceDirectory }

async function requireLegacySnapshotMode() {
  const { currentDatabaseClient, withStorageTransaction } = await import('./db/client')
  await withStorageTransaction(async () => {
    const client = currentDatabaseClient()!
    if ((await client.query("SELECT to_regclass('habittrove.family_configuration') AS name")).rows[0].name &&
        (await client.query('SELECT enabled FROM habittrove.family_configuration WHERE singleton')).rows[0]?.enabled === true) {
      throw new MigrationValidationError('Enabled families require the complete version 2 backup format')
    }
  }, { readOnly: true })
}

export function validateProtectedAssetMap(assets: Map<string, Buffer>) {
  let size = 0
  for (const [name, bytes] of assets) {
    requireCondition(typeof name === 'string' && /^(avatars|evidence)\//.test(name) && !/[\\\x00-\x1f\x7f]/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe protected asset path')
    requireCondition(Buffer.isBuffer(bytes) && bytes.length <= 64 * 1024 * 1024, 'Invalid protected asset bytes')
    size += bytes.length
    requireCondition(size <= 512 * 1024 * 1024, 'Asset capture exceeds memory budget')
  }
}
