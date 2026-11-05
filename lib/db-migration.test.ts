import { describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { captureLegacySource, snapshotFingerprint, validateSnapshot, verifySavedManifest, writeSnapshotDirectory } from './db-migration'
import type { DatabaseSnapshot } from './db/repository'

export const migrationFixture = (): DatabaseSnapshot => ({
  auth: { users: [{ id: 'old-user-id', username: 'Robin', password: 'exact:hash', authentikSubject: 'subject-unchanged', oidcIssuer: 'https://issuer.example', managedUserIds: [], permissions: [] }] },
  habits: { habits: [{ id: '12345', name: 'Legacy', description: '', frequency: 'daily', coinReward: 0.25, userIds: ['old-user-id'], completions: ['2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', '2024-01-03T00:00:00Z'], completionRecords: [null, { id: 'event-old', actorId: 'deleted-user', voided: true, rewardAmount: 0.25, rewardedUserIds: ['deleted-user'] }, { id: 'pending-old', actorId: 'old-user-id', approval: 'pending' }] }] },
  wishlist: { items: [{ id: 'reward-old', name: 'Reward', description: '', coinCost: 0.5 }] },
  coins: { balance: 12.75, transactions: [{ id: 'transaction-old', amount: 0.1, type: 'MANUAL_ADJUSTMENT', description: '', timestamp: '2024-01-01T00:00:00Z', userId: 'old-user-id', relatedItemId: 'deleted-item' }, { id: 'transaction-old2', amount: 0.2, type: 'MANUAL_ADJUSTMENT', description: '', timestamp: '2024-01-01T00:00:00Z', userId: 'old-user-id' }] },
  settings: { ui: { useNumberFormatting: true, useGrouping: true }, system: { timezone: 'UTC', weekStartDay: 1, language: 'en', autoBackupEnabled: true }, profile: {} },
  adminConfig: { version: 1, logLevel: 'info', oidcOverride: { encryptedClientSecret: 'ciphertext-unchanged' } },
})
async function fixtureDirectory() {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'habittrove-migration-'))
  const snapshot = migrationFixture()
  const names = { auth: 'auth', habits: 'habits', wishlist: 'wishlist', coins: 'coins', settings: 'settings', adminConfig: 'admin-config' }
  for (const [key, name] of Object.entries(names)) await fs.writeFile(path.join(directory, `${name}.json`), JSON.stringify(snapshot[key as keyof DatabaseSnapshot]))
  return { directory, snapshot }
}

test('read-only capture preserves identity/hash, ordering/null/voided events, exact fractional totals and source bytes', async () => {
  const { directory, snapshot } = await fixtureDirectory()
  try {
    await fs.mkdir(path.join(directory, 'avatars'))
    await fs.writeFile(path.join(directory, 'avatars', 'orphan.png'), 'original asset bytes')
    const before = await fs.readFile(path.join(directory, 'auth.json'))
    const source = await captureLegacySource(directory)
    expect(source.snapshot).toEqual(snapshot)
    expect(source.manifest.ledgerTotals).toEqual({ 'old-user-id': '0.3' })
    expect(source.manifest.counts).toMatchObject({ legacyCompletions: 1, voided: 1, pending: 1, historicalReferences: 2 })
    expect(source.manifest.ids.habits).toEqual(['12345'])
    expect(source.manifest.assets['avatars/orphan.png'].bytes).toBe(20)
    expect(await fs.readFile(path.join(directory, 'auth.json'))).toEqual(before)
    expect((await captureLegacySource(directory)).digest).toBe(source.digest)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('reverse export uses private files and a verifiable checksum manifest without embedding AUTH_SECRET', async () => {
  const { directory, snapshot } = await fixtureDirectory()
  const destination = `${directory}-export`
  try {
    const source = await captureLegacySource(directory)
    const result = await writeSnapshotDirectory(destination, source)
    expect(result.snapshot).toEqual(snapshot)
    expect(snapshotFingerprint(result.snapshot)).toBe(snapshotFingerprint(source.snapshot))
    await verifySavedManifest(destination, result)
    expect((await fs.stat(destination)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(path.join(destination, 'auth.json'))).mode & 0o777).toBe(0o600)
    expect(result.manifest.externalSecretsRequired).toEqual(['AUTH_SECRET'])
    await expect(writeSnapshotDirectory(destination, source)).rejects.toThrow()
    await fs.writeFile(path.join(destination, 'coins.json'), JSON.stringify({ balance: 999, transactions: [] }))
    await expect(verifySavedManifest(destination, await captureLegacySource(destination))).rejects.toThrow('checksum')
  } finally { await fs.rm(directory, { recursive: true, force: true }); await fs.rm(destination, { recursive: true, force: true }) }
})

describe('rejects ambiguous or unsafe source data', () => {
  test('duplicate case-insensitive identity, external binding and duplicate event IDs', () => {
    const snapshot = migrationFixture()
    snapshot.auth.users.push({ id: 'second', username: 'robin' })
    expect(() => validateSnapshot(snapshot)).toThrow('Colliding login')
    snapshot.auth.users[1].username = 'Other'
    snapshot.auth.users[1].authentikSubject = 'subject-unchanged'; snapshot.auth.users[1].oidcIssuer = 'https://issuer.example'
    expect(() => validateSnapshot(snapshot)).toThrow('Colliding external')
    snapshot.auth.users.pop()
    snapshot.habits.habits[0].completionRecords![2]!.id = 'event-old'
    expect(() => validateSnapshot(snapshot)).toThrow('completion identifier')
  })
  test('alignment, live account references and non-finite ledger values', () => {
    const snapshot = migrationFixture()
    snapshot.habits.habits[0].completionRecords!.pop()
    expect(() => validateSnapshot(snapshot)).toThrow('alignment')
    const other = migrationFixture(); other.habits.habits[0].userIds = ['missing']
    expect(() => validateSnapshot(other)).toThrow('missing active')
    const invalid = migrationFixture(); invalid.coins.transactions[0].amount = Infinity
    expect(() => validateSnapshot(invalid)).toThrow('numeric')
  })
  test('symlinked documents, asset directories and assets', async () => {
    const { directory } = await fixtureDirectory()
    try {
      await fs.rename(path.join(directory, 'auth.json'), path.join(directory, 'auth-original.json'))
      await fs.symlink(path.join(directory, 'auth-original.json'), path.join(directory, 'auth.json'))
      await expect(captureLegacySource(directory)).rejects.toThrow('Symlink')
      await fs.unlink(path.join(directory, 'auth.json')); await fs.rename(path.join(directory, 'auth-original.json'), path.join(directory, 'auth.json'))
      await fs.symlink(directory, path.join(directory, 'avatars'))
      await expect(captureLegacySource(directory)).rejects.toThrow('Symlink')
      await fs.unlink(path.join(directory, 'avatars')); await fs.mkdir(path.join(directory, 'avatars'))
      await fs.symlink(path.join(directory, 'auth.json'), path.join(directory, 'avatars', 'leak.png'))
      await expect(captureLegacySource(directory)).rejects.toThrow('Symlink')
    } finally { await fs.rm(directory, { recursive: true, force: true }) }
  })
  test('missing referenced and traversal assets', async () => {
    const { directory, snapshot } = await fixtureDirectory()
    try {
      snapshot.auth.users[0].avatarPath = '/data/avatars/missing.png'
      await fs.writeFile(path.join(directory, 'auth.json'), JSON.stringify(snapshot.auth))
      await expect(captureLegacySource(directory)).rejects.toThrow('missing')
      snapshot.auth.users[0].avatarPath = '/data/avatars/../../auth.json'
      await fs.writeFile(path.join(directory, 'auth.json'), JSON.stringify(snapshot.auth))
      await expect(captureLegacySource(directory)).rejects.toThrow('Unsafe avatar')
    } finally { await fs.rm(directory, { recursive: true, force: true }) }
  })
})

test('exact ledger reconciliation retains negative, exponential and unassigned legacy amounts', () => {
  const snapshot = migrationFixture()
  snapshot.coins.transactions = [1e-7, 0.1, 0.2, -0.3].map((amount, index) => ({ id: `old-${index}`, amount, type: 'MANUAL_ADJUSTMENT', description: '', timestamp: '2024-01-01T00:00:00Z' }))
  expect(validateSnapshot(snapshot).ledgerTotals).toEqual({ '__legacy_unassigned__': '0.0000001' })
})


test('offline dry-run emits aggregate counts and writes its private manifest outside unchanged source', async () => {
  const { directory } = await fixtureDirectory()
  const manifest = `${directory}-manifest.json`
  const output = spyOn(console, 'log').mockImplementation(() => undefined)
  try {
    const { databaseCommand } = await import('../scripts/database')
    await databaseCommand(['dry-run', directory, '--manifest', manifest])
    const text = JSON.stringify(output.mock.calls)
    expect(text).toContain('sourceDigest')
    expect(text).not.toContain('exact:hash')
    expect(text).not.toContain('Robin')
    expect((await fs.stat(manifest)).mode & 0o777).toBe(0o600)
    await expect(databaseCommand(['dry-run', directory, '--manifest', path.join(directory, 'manifest.json')])).rejects.toThrow('outside the source')
    await expect(fs.access(path.join(directory, 'manifest.json'))).rejects.toThrow()
  } finally { output.mockRestore(); await fs.rm(directory, { recursive: true, force: true }); await fs.rm(manifest, { force: true }) }
})

test('reverse export preserves private metadata for retained unreferenced assets', async () => {
  const { directory } = await fixtureDirectory()
  const destination = `${directory}-metadata-export`
  try {
    await fs.mkdir(path.join(directory, 'avatars'))
    await fs.writeFile(path.join(directory, 'avatars', 'retained.gif'), 'retained-bytes')
    const captured = await captureLegacySource(directory)
    const attachment = { id: 'avatar:retained.gif', owner_id: 'deleted-owner', path: 'avatars/retained.gif', mime_type: 'image/gif' as const, sha256: captured.manifest.assets['avatars/retained.gif'].sha256 }
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ ...captured.manifest, attachmentMetadata: [attachment] }))
    const source = await captureLegacySource(directory)
    expect(source.snapshot.attachments).toEqual([attachment])
    const output = await writeSnapshotDirectory(destination, source)
    await verifySavedManifest(destination, output)
    expect(output.snapshot.attachments).toEqual([attachment])
  } finally { await fs.rm(directory, { recursive: true, force: true }); await fs.rm(destination, { recursive: true, force: true }) }
})


test('legacy snapshot writer rejects forged orphan asset traversal before creating the destination', async () => {
  const { directory } = await fixtureDirectory()
  const destination = `${directory}-unsafe-output`
  try {
    const source = await captureLegacySource(directory)
    source.assets.set('avatars/../../outside', Buffer.from('must remain private'))
    await expect(writeSnapshotDirectory(destination, source)).rejects.toThrow('Unsafe protected asset path')
    await expect(fs.access(destination)).rejects.toThrow()
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
