import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { FAMILY_SNAPSHOT_TABLES, migrateFamilyDatabase, createFamilyBackupSource, readFamilySource, readFamilyBackupSettings, validateFamilySnapshot, writeFamilySnapshotDirectory, type FamilyDatabaseSnapshot, type FamilySnapshotTable } from './family-backup'

function fixture(): FamilyDatabaseSnapshot {
  const tables = {} as FamilyDatabaseSnapshot['tables']
  for (const name of Object.keys(FAMILY_SNAPSHOT_TABLES) as FamilySnapshotTable[]) tables[name] = []
  tables.users = [['admin-old', '0', 'Admin', 'preserved-hash', 'private@example.test', 'true', '0', '{"fields":{"unknown":"retained"},"present":[]}']]
  tables.family_configuration = [['true', 'true']]
  tables.families = [['family-a', 'Private A', '1', '2026-01-01 00:00:00+00'], ['family-b', 'Private B', '1', '2026-01-01 00:00:00+00']]
  const ledger = (id: string, family: string, amount: string) => [id, '0', 'dual', 'admin-old', null, null, null, amount, 'MANUAL_ADJUSTMENT', '2026-01-01 00:00:00+00', '{}', family]
  tables.coin_ledger = [ledger('one', 'family-a', '0.1'), ledger('two', 'family-b', '0.2')]
  tables.global_wallet_totals = [['dual', '0.3'], ['historical-zero', '0']]
  return { format: 'habittrove-family-database', version: 2, schemaVersion: 2, tables }
}

test('backs up legacy family settings without an explicit backup flag and preserves the stored snapshot', () => {
  const snapshot = fixture()
  snapshot.tables.setting_sections = [['system', '{"timezone":"Europe/London","weekStartDay":0,"language":"en"}']]
  const source = createFamilyBackupSource(snapshot, new Map())
  const before = JSON.stringify(source.snapshot)
  const settings = readFamilyBackupSettings(source)
  expect(settings.system.autoBackupEnabled).toBe(true)
  expect(settings.system.timezone).toBe('Europe/London')
  expect(settings.system.weekStartDay).toBe(0)
  expect(JSON.stringify(source.snapshot)).toBe(before)
})

test('preserves an explicit disabled or enabled instance backup setting', () => {
  for (const enabled of [false, true]) {
    const snapshot = fixture()
    snapshot.tables.setting_sections = [['system', JSON.stringify({ autoBackupEnabled: enabled })]]
    expect(readFamilyBackupSettings(createFamilyBackupSource(snapshot, new Map())).system.autoBackupEnabled).toBe(enabled)
  }
})

test('uses existing defaults when legacy settings omit the system section', () => {
  expect(readFamilyBackupSettings(createFamilyBackupSource(fixture(), new Map())).system.autoBackupEnabled).toBe(true)
})

test('rejects malformed backup settings instead of enabling an invalid saved value', () => {
  for (const system of [null, [], false, 'enabled', { autoBackupEnabled: null }, { autoBackupEnabled: 'false' }]) {
    const snapshot = fixture()
    snapshot.tables.setting_sections = [['system', JSON.stringify(system)]]
    expect(() => readFamilyBackupSettings(createFamilyBackupSource(snapshot, new Map()))).toThrow()
  }
})

test('complete family format preserves exact decimals, removed historical flags and allowlisted raw fields', () => {
  const snapshot = fixture()
  snapshot.tables.family_memberships = [['family-a', 'removed', 'member', 'false', '2025-01-01 00:00:00+00', '2026-01-01 00:00:00+00']]
  expect(validateFamilySnapshot(snapshot)).toEqual({ dual: '0.3', 'historical-zero': '0' })
  const source = createFamilyBackupSource(snapshot, new Map())
  expect(source.manifest.version).toBe(2)
  expect(source.snapshot.tables.family_memberships[0][3]).toBe('false')
  expect(source.manifest.externalSecretsRequired).toEqual(['AUTH_SECRET'])
  expect(JSON.stringify(source.manifest)).not.toContain('private@example.test')
  expect(JSON.stringify(source.manifest)).not.toContain('preserved-hash')
})

test('refuses partial, unknown-table, invalid-cell and unreconciled family snapshots', () => {
  const missing = fixture(); delete (missing.tables as Partial<FamilyDatabaseSnapshot['tables']>).family_preferences
  expect(() => validateFamilySnapshot(missing)).toThrow('allowlist')
  const extra = fixture(); Object.assign(extra.tables, { injected_table: [] })
  expect(() => validateFamilySnapshot(extra)).toThrow('allowlist')
  const invalid = fixture(); invalid.tables.users[0][5] = 'yes'
  expect(() => validateFamilySnapshot(invalid)).toThrow('boolean')
  const malformed = fixture(); malformed.tables.users[0][7] = '{malformed'
  expect(() => validateFamilySnapshot(malformed)).toThrow('JSONB')
  const amount = fixture(); amount.tables.coin_ledger[0][7] = 'NaN'
  expect(() => validateFamilySnapshot(amount)).toThrow('wallet')
  const mismatch = fixture(); mismatch.tables.global_wallet_totals[0][1] = '0.4'
  expect(() => validateFamilySnapshot(mismatch)).toThrow('reconcile')
  const missingWallet = fixture(); missingWallet.tables.global_wallet_totals = []
  expect(() => validateFamilySnapshot(missingWallet)).toThrow('reconcile')
})

test('version 2 directory checksums and inaccessible metadata round-trip privately; tampering is rejected', async () => {
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'habittrove-family-backup-'))
  const snapshot = fixture(), bytes = Buffer.from('protected-evidence')
  const digest = createHash('sha256').update(bytes).digest('hex')
  snapshot.tables.attachments = [['evidence-old', null, null, 'removed', 'evidence/old.png', 'image/png', digest, 'family-a', 'true']]
  const source = createFamilyBackupSource(snapshot, new Map([['evidence/old.png', bytes]]))
  const target = path.join(parent, 'snapshot')
  try {
    const saved = await writeFamilySnapshotDirectory(target, source)
    expect(saved.snapshot).toEqual(snapshot)
    expect((await fs.stat(target)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(path.join(target, 'family-database.json'))).mode & 0o777).toBe(0o600)
    await expect(writeFamilySnapshotDirectory(target, source)).rejects.toThrow()
    await fs.writeFile(path.join(target, 'evidence', 'old.png'), 'tampered')
    await expect(readFamilySource(target)).rejects.toThrow('hash')
  } finally { await fs.rm(parent, { recursive: true, force: true }) }
})

test('permits physically cleaned inaccessible tombstones but rejects missing accessible assets and unsafe paths', () => {
  const snapshot = fixture()
  snapshot.tables.attachments = [['deleted', null, null, null, 'evidence/deleted.png', 'image/png', 'a'.repeat(64), 'family-a', 'true']]
  expect(createFamilyBackupSource(snapshot, new Map()).snapshot.tables.attachments).toEqual(snapshot.tables.attachments)
  snapshot.tables.attachments[0][8] = 'false'
  expect(() => createFamilyBackupSource(snapshot, new Map())).toThrow('hash')
  snapshot.tables.attachments[0][4] = 'evidence/../../auth.json'
  expect(() => createFamilyBackupSource(snapshot, new Map())).toThrow('path')
})


test('rejects forged orphan asset map traversal before any filesystem writes', () => {
  expect(() => createFamilyBackupSource(fixture(), new Map([['avatars/../../escape', Buffer.from('secret')]]))).toThrow('Unsafe protected asset path')
  expect(() => createFamilyBackupSource(fixture(), new Map([['evidence/evil\\name.png', Buffer.from('secret')]]))).toThrow('Unsafe protected asset path')
})


test('retains reserved-looking historical wallet IDs without object-prototype collisions', () => {
  const snapshot = fixture()
  snapshot.tables.global_wallet_totals.push(['__proto__', '0'], ['constructor', '0'])
  expect(validateFamilySnapshot(snapshot)).toEqual({ dual: '0.3', 'historical-zero': '0', ['__proto__']: '0', constructor: '0' })
})


test('separate migration identity compares decoded URI usernames before connecting', async () => {
  const original = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_MIGRATION_URL: process.env.DATABASE_MIGRATION_URL }
  process.env.DATABASE_URL = 'postgresql://%61pp@127.0.0.1:1/habittrove'
  process.env.DATABASE_MIGRATION_URL = 'postgresql://app@127.0.0.1:1/habittrove'
  try { await expect(migrateFamilyDatabase()).rejects.toThrow('separate migration identity') }
  finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
