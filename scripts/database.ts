import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { emailSchema, newPasswordSchema } from '../lib/zod'
import { saltAndHashPassword } from '../lib/password'
import { getDefaultSettings, getDefaultHabitsData, getDefaultWishlistData, getDefaultCoinsData } from '../lib/types'
import { importDatabaseSnapshot, type DatabaseSnapshot } from '../lib/db/repository'
import { MigrationValidationError, captureDatabaseSource, captureLegacySource, importDatabaseSource, verifyDatabaseSource, verifySavedManifest, verifyProtectedAssets, readSnapshotFile, withProtectedAssetCapture, writeSnapshotDirectory } from '../lib/db-migration'
import { activateFamilyDatabase, captureFamilyDatabaseSource, familyStorageState, migrateFamilyDatabase, previewFamilyActivation, readFamilySource, restoreFamilyDatabase, verifyFamilyDatabase, withFamilyOperationalScope, writeFamilySnapshotDirectory } from '../lib/family-backup'
import type { LegacyFamilyMapping } from '../lib/family-types'
import { assertDatabaseTarget, closeDatabase, migrateDatabase } from '../lib/db/client'

export function createInitialDatabaseSnapshot(environment: Record<string, string | undefined> = process.env): DatabaseSnapshot {
  const password = newPasswordSchema.safeParse(environment.INITIAL_ADMIN_PASSWORD)
  if (!password.success) throw new MigrationValidationError('INITIAL_ADMIN_PASSWORD must be 12-128 characters')
  const email = emailSchema.safeParse(environment.INITIAL_ADMIN_EMAIL)
  if (!email.success) throw new MigrationValidationError('INITIAL_ADMIN_EMAIL must be a valid email')
  return {
    auth: { users: [{ id: randomUUID(), username: 'admin', email: email.data.toLowerCase(), password: saltAndHashPassword(password.data), isAdmin: true, authVersion: 0 }] },
    habits: getDefaultHabitsData(), wishlist: getDefaultWishlistData(), coins: getDefaultCoinsData(), settings: getDefaultSettings(),
  }
}

export async function databaseCommand(args = process.argv.slice(2)) {
  const [command, ...parameters] = args
  const noDirectory = ['migrate', 'init', 'prepare-family', 'preview-family-activation', 'activate-family']
  const directory = noDirectory.includes(command) ? '' : parameters.shift() ?? ''
  const flags = parameters
  const expectedHashFlag = flags.indexOf('--expected-source-hash')
  const expectedHash = expectedHashFlag >= 0 ? flags.splice(expectedHashFlag, 2)[1] : undefined
  if (expectedHashFlag >= 0 && (command !== 'activate-family' || !expectedHash)) throw new Error('Activation requires --expected-source-hash HASH')
  const allowEmpty = flags.includes('--allow-empty')
  if (allowEmpty && !['preview-family-activation', 'activate-family'].includes(command)) throw new Error('--allow-empty is limited to explicit empty activation')
  const manifestFlag = flags.indexOf('--manifest')
  const manifestPath = manifestFlag >= 0 ? flags.splice(manifestFlag, 2)[1] : undefined
  if (manifestFlag >= 0 && (!manifestPath || command !== 'dry-run')) throw new Error('--manifest requires a private output path and dry-run')
  if (!['dry-run-family', 'dry-run', 'import', 'verify', 'export', 'restore', 'migrate', 'init', 'prepare-family', 'preview-family-activation', 'activate-family', 'export-family', 'restore-family', 'verify-family', 'create-family', 'preview-family-mapping', 'apply-family-mapping'].includes(command) || !noDirectory.includes(command) && !directory || flags.some(flag => !['--allow-test-database', '--allow-empty'].includes(flag))) throw new MigrationValidationError('Usage: database.mjs dry-run|import|verify|export|restore DIRECTORY, migrate|init, prepare-family, create-family FILE, preview-family-mapping|apply-family-mapping FILE, preview-family-activation, activate-family --expected-source-hash HASH, or dry-run-family|export-family|verify-family|restore-family DIRECTORY')
  if (!['dry-run', 'dry-run-family'].includes(command)) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
    const allowTest = flags.includes('--allow-test-database') && process.env.HABITTROVE_TEST_DATABASE === '1'
    assertDatabaseTarget(process.env.DATABASE_URL, allowTest)
    if (command === 'migrate' && process.env.DATABASE_MIGRATION_URL) {
      assertDatabaseTarget(process.env.DATABASE_MIGRATION_URL, allowTest)
      const runtime = new URL(process.env.DATABASE_URL), migration = new URL(process.env.DATABASE_MIGRATION_URL)
      if (runtime.hostname !== migration.hostname || (runtime.port || '5432') !== (migration.port || '5432') || runtime.pathname !== migration.pathname) throw new Error('Migration and runtime must target the same HabitTrove database')
    }
  }
  try {
    if (command === 'dry-run-family') {
      const source = await readFamilySource(directory)
      console.log(JSON.stringify({ version: 2, snapshotDigest: source.manifest.snapshotDigest, counts: source.manifest.counts, assetCount: source.assets.size })); return
    }
    if (command === 'prepare-family') { await migrateFamilyDatabase(); console.log('Family schema version 2 prepared; activation remains explicit'); return }
    if (command === 'preview-family-activation') { console.log(JSON.stringify(await previewFamilyActivation(allowEmpty))); return }
    if (command === 'activate-family') { await activateFamilyDatabase(expectedHash ?? '', allowEmpty); console.log('Explicit family mapping verified and activated'); return }
    if (['create-family', 'preview-family-mapping', 'apply-family-mapping'].includes(command)) {
      const file = path.resolve(directory)
      let input: unknown
      try { input = JSON.parse((await readSnapshotFile(path.dirname(file), path.basename(file))).toString('utf8')) } catch { throw new MigrationValidationError('Invalid private family mapping JSON') }
      const store = await import('../lib/family-store')
      const result = await withFamilyOperationalScope(async actor => {
        if (command === 'create-family') {
          const request = input as { name: string; ownerId?: string }
          const family = await store.provisionFamily(actor, request.name, request.ownerId)
          return { familyId: family.id }
        }
        return command === 'preview-family-mapping' ? store.previewLegacyFamilyAdoption(actor, input as LegacyFamilyMapping) : store.applyLegacyFamilyAdoption(actor, input as LegacyFamilyMapping)
      })
      console.log(JSON.stringify(result)); return
    }
    if (command === 'restore-family' || command === 'verify-family') {
      const source = await readFamilySource(directory)
      if (command === 'restore-family') await restoreFamilyDatabase(source, path.join(process.cwd(), 'data'))
      else await verifyFamilyDatabase(source, path.join(process.cwd(), 'data'))
      console.log('Complete family snapshot verified; preserve external AUTH_SECRET separately'); return
    }
    if (command === 'migrate') { await migrateDatabase(); console.log('HabitTrove schema migrated'); return }
    if (command === 'init') {
      const snapshot = createInitialDatabaseSnapshot()
      try { await importDatabaseSnapshot(snapshot, `bootstrap:${randomUUID()}`) }
      catch (error) {
        if (error instanceof Error && ['Import target differs from source', 'Import requires an empty target database'].includes(error.message)) {
          throw new MigrationValidationError('Database init requires an empty target; existing data was not changed')
        }
        throw error
      }
      console.log('HabitTrove initialized; remove INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD from the private environment')
      return
    }
    if (command === 'export-family' || command === 'export' && await familyStorageState() === 'enabled') {
      const source = await captureFamilyDatabaseSource(path.join(process.cwd(), 'data'))
      await writeFamilySnapshotDirectory(directory, source)
      console.log('Complete version 2 family export verified; preserve external AUTH_SECRET separately'); return
    }
    if (command === 'export') {
      await withProtectedAssetCapture(async () => {
        const source = await captureDatabaseSource(path.join(process.cwd(), 'data'))
        await writeSnapshotDirectory(directory, source)
      })
      console.log('Private reverse export verified; preserve external AUTH_SECRET separately'); return
    }
    const source = await captureLegacySource(directory)
    if (command === 'restore') await verifySavedManifest(directory, source)
    if (command === 'dry-run') {
      const report = { format: source.manifest.format, version: source.manifest.version, counts: source.manifest.counts, sourceDigest: source.digest, assetCount: source.assets.size }
      // The private manifest contains account IDs and ledger totals; stdout deliberately contains only aggregate counts.
      if (manifestPath) {
        const output = path.resolve(manifestPath), root = path.resolve(directory)
        if (output === root || output.startsWith(`${root}${path.sep}`) || await fs.realpath(path.dirname(output)) !== path.dirname(output)) throw new Error('Manifest must be outside the source in a canonical private directory')
        await fs.writeFile(output, JSON.stringify(source.manifest, null, 2), { flag: 'wx', mode: 0o600 })
      }
      console.log(JSON.stringify(report))
      return
    }
    // Source assets must already be mounted at their final protected path. Import never overwrites that volume.
    await verifyProtectedAssets(path.join(process.cwd(), 'data'), source)
    if (command === 'verify') await verifyDatabaseSource(source)
    else await importDatabaseSource(source)
    console.log('HabitTrove snapshot verified; preserve external AUTH_SECRET separately')
  } finally { await closeDatabase() }
}
