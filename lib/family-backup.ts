import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Client, type PoolClient } from 'pg'
import stringify from 'json-stable-stringify'
import { assertDatabaseTarget, currentDatabaseClient, withStorageTransaction } from './db/client'
import { MigrationValidationError, canonicalSourceDirectory, captureProtectedAssets, readSnapshotFile, validateProtectedAssetMap, verifyProtectedAssets } from './db-migration'
import type { User } from './types'

type CellType = 'text' | 'integer' | 'bigint' | 'numeric' | 'boolean' | 'date' | 'timestamptz' | 'jsonb'
interface Column { name: string; type: CellType; nullable: boolean }
function columns(specification: string): Column[] {
  return specification.split(' ').map(value => {
    const [name, kind] = value.split(':')
    return { name, type: kind.replace('?', '') as CellType, nullable: kind.endsWith('?') }
  })
}
// This order is also the restore dependency order. Identifiers never come from archive input.
export const FAMILY_SNAPSHOT_TABLES = {
  documents: columns('kind:text revision:bigint metadata:jsonb'),
  users: columns('id:text ordinal:integer username:text password_hash:text? email:text? is_admin:boolean? auth_version:integer? attributes:jsonb'),
  oidc_identities: columns('user_id:text issuer:text? subject:text'),
  permissions: columns('user_id:text ordinal:integer resource:text can_write:boolean can_interact:boolean'),
  manager_assignments: columns('manager_id:text member_id:text ordinal:integer'),
  folders: columns('user_id:text ordinal:integer id:text name:text'),
  folder_items: columns('user_id:text folder_ordinal:integer ordinal:integer item_id:text'),
  status_days: columns('user_id:text ordinal:integer local_date:date status:text'),
  invitations: columns('token_hash:text ordinal:integer email:text created_by:text managed_by:text? expires_at:timestamptz attributes:jsonb'),
  setting_sections: columns('name:text value:jsonb'),
  admin_configuration: columns('name:text value:jsonb'),
  migration_batches: columns('source_digest:text imported_at:timestamptz'),
  authentication_throttles: columns('key_hash:text attempts:integer expires_at:timestamptz'),
  job_leases: columns('name:text owner:text expires_at:timestamptz'),
  families: columns('id:text name:text revision:bigint created_at:timestamptz'),
  family_memberships: columns('family_id:text user_id:text role:text active:boolean joined_at:timestamptz removed_at:timestamptz?'),
  family_manager_assignments: columns('family_id:text manager_id:text member_id:text'),
  family_permissions: columns('family_id:text user_id:text resource:text can_write:boolean can_interact:boolean'),
  family_preferences: columns('family_id:text user_id:text preferences:jsonb'),
  family_settings: columns('family_id:text settings:jsonb'),
  family_document_revisions: columns('family_id:text kind:text revision:bigint metadata:jsonb'),
  household_invitations: columns('token_hash:text family_id:text email:text role:text created_by:text managed_by:text? expires_at:timestamptz consumed_at:timestamptz? consumed_by:text? revoked_at:timestamptz?'),
  family_audit: columns('id:text family_id:text actor_id:text action:text target_id:text? occurred_at:timestamptz'),
  family_legacy_adoptions: columns('source_hash:text family_id:text actor_id:text mapping:jsonb adopted_at:timestamptz'),
  habits: columns('id:text ordinal:integer revision:bigint name:text created_by:text? requires_approval:boolean? archived:boolean? coin_reward:numeric attributes:jsonb family_id:text?'),
  habit_assignees: columns('habit_id:text ordinal:integer user_id:text family_id:text?'),
  habit_approvers: columns('habit_id:text ordinal:integer user_id:text family_id:text?'),
  checklist_entries: columns('habit_id:text ordinal:integer id:text text:text completed:boolean family_id:text?'),
  completions: columns('habit_id:text ordinal:integer completed_at:timestamptz? timestamp_text:text? record_kind:text id:text? actor_id:text? beneficiary_id:text? request_id:text? voided:boolean? approval:text? reward_amount:numeric? reviewed_by:text? reviewed_at:timestamptz? evidence_id:text? evidence_mime:text? attributes:jsonb? family_id:text? needs_review:boolean'),
  completion_recipients: columns('habit_id:text completion_ordinal:integer ordinal:integer user_id:text family_id:text?'),
  slips: columns('habit_id:text ordinal:integer id:text actor_id:text occurred_at:timestamptz penalty:numeric attributes:jsonb family_id:text?'),
  wishlist_items: columns('id:text ordinal:integer revision:bigint name:text coin_cost:numeric attributes:jsonb family_id:text?'),
  wishlist_assignees: columns('item_id:text ordinal:integer user_id:text family_id:text?'),
  coin_ledger: columns('id:text ordinal:bigint user_id:text? actor_id:text? related_item_id:text? completion_id:text? request_id:text? amount:numeric type:text occurred_at:timestamptz attributes:jsonb family_id:text?'),
  attachments: columns('id:text habit_id:text? completion_id:text? owner_id:text? path:text mime_type:text sha256:text? family_id:text? inaccessible:boolean'),
  global_wallet_totals: columns('user_id:text balance:numeric'),
  family_configuration: columns('singleton:boolean enabled:boolean'),
} as const
export type FamilySnapshotTable = keyof typeof FAMILY_SNAPSHOT_TABLES
export type FamilySnapshotRow = (string | null)[]
export interface FamilyDatabaseSnapshot {
  format: 'habittrove-family-database'; version: 2; schemaVersion: 2
  tables: Record<FamilySnapshotTable, FamilySnapshotRow[]>
}
export interface FamilyBackupManifest {
  format: 'habittrove-snapshot'; version: 2; schemaVersion: 2; snapshotDigest: string
  files: { 'family-database.json': { sha256: string; bytes: number } }
  counts: Record<FamilySnapshotTable, number>; ledgerTotals: Record<string, string>
  assets: Record<string, { sha256: string; bytes: number }>; externalSecretsRequired: ['AUTH_SECRET']
}
export interface CapturedFamilySource { snapshot: FamilyDatabaseSnapshot; manifest: FamilyBackupManifest; digest: string; assets: Map<string, Buffer> }
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const encoded = (value: unknown) => stringify(value)!
const names = Object.keys(FAMILY_SNAPSHOT_TABLES) as FamilySnapshotTable[]
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
function requireValid(value: unknown, message: string): asserts value { if (!value) throw new MigrationValidationError(message) }
function rowObject(table: FamilySnapshotTable, row: FamilySnapshotRow) { return Object.fromEntries(FAMILY_SNAPSHOT_TABLES[table].map((column, index) => [column.name, row[index]])) }
function canonicalTables(snapshot: FamilyDatabaseSnapshot) {
  return Object.fromEntries(names.map(name => [name, [...snapshot.tables[name]].sort((a, b) => encoded(a).localeCompare(encoded(b), 'en'))])) as FamilyDatabaseSnapshot['tables']
}
function decimal(value: string): [bigint, number] {
  requireValid(/^-?\d+(?:\.\d+)?$/.test(value) && value.length <= 16384, 'Invalid finite wallet amount')
  const [whole, fraction = ''] = value.split('.')
  return [BigInt(whole + fraction), fraction.length]
}
function sumDecimals(values: string[]) {
  const parts = values.map(decimal), scale = parts.reduce((maximum, part) => Math.max(maximum, part[1]), 0)
  const total = parts.reduce((sum, [amount, digits]) => sum + amount * BigInt(10) ** BigInt(scale - digits), BigInt(0))
  const negative = total < BigInt(0), digits = (negative ? -total : total).toString().padStart(scale + 1, '0')
  const result = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '') : digits
  return `${negative ? '-' : ''}${result}`
}
export function validateFamilySnapshot(snapshot: FamilyDatabaseSnapshot): Record<string, string> {
  requireValid(snapshot?.format === 'habittrove-family-database' && snapshot.version === 2 && snapshot.schemaVersion === 2 && snapshot.tables && typeof snapshot.tables === 'object', 'Unsupported family snapshot')
  requireValid(encoded(Object.keys(snapshot.tables).sort()) === encoded([...names].sort()), 'Family snapshot table allowlist mismatch')
  for (const table of names) {
    const rows = snapshot.tables[table], specification = FAMILY_SNAPSHOT_TABLES[table]
    requireValid(Array.isArray(rows), 'Invalid family table rows')
    const seen = new Set<string>()
    for (const row of rows) {
      requireValid(Array.isArray(row) && row.length === specification.length && !seen.has(encoded(row)), 'Invalid or duplicate family row')
      seen.add(encoded(row))
      specification.forEach((column, index) => {
        const value = row[index]
        if (value === null) { requireValid(column.nullable, 'Null in a required family snapshot column'); return }
        requireValid(typeof value === 'string' && !value.includes('\0'), 'Invalid family snapshot cell')
        if (column.type === 'boolean') requireValid(value === 'true' || value === 'false', 'Invalid family boolean')
        if (column.type === 'integer' || column.type === 'bigint') requireValid(/^-?\d+$/.test(value) && value.length < 21, 'Invalid family integer')
        if (column.type === 'numeric') requireValid(sumDecimals([value]) === value, 'Noncanonical family numeric value')
        if (column.type === 'date') requireValid(/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)), 'Invalid family date')
        if (column.type === 'timestamptz') requireValid(/^\d{4}-\d{2}-\d{2} /.test(value) && /[+-]\d\d(?::\d\d)?$/.test(value) && Number.isFinite(Date.parse(value)), 'Invalid family timestamp')
        if (column.type === 'jsonb') { try { JSON.parse(value) } catch { throw new MigrationValidationError('Invalid family JSONB cell') } }
      })
    }
  }
  const users = snapshot.tables.users.map(row => rowObject('users', row))
  requireValid(users.some(user => user.is_admin === 'true'), 'Family snapshot requires a recoverable site administrator')
  const configuration = snapshot.tables.family_configuration.map(row => rowObject('family_configuration', row))
  requireValid(configuration.length === 1 && configuration[0].singleton === 'true', 'Invalid family configuration')
  const ledger = new Map<string, string[]>()
  for (const row of snapshot.tables.coin_ledger) { const item = rowObject('coin_ledger', row); if (item.user_id !== null) { if (!ledger.has(item.user_id)) ledger.set(item.user_id, []); ledger.get(item.user_id)!.push(item.amount!) } }
  const totals = new Map([...ledger].map(([id, amounts]) => [id, sumDecimals(amounts)]))
  const wallets = new Map(snapshot.tables.global_wallet_totals.map(row => { const item = rowObject('global_wallet_totals', row); return [item.user_id!, sumDecimals([item.balance!])] }))
  requireValid(wallets.size === snapshot.tables.global_wallet_totals.length, 'Duplicate global wallet summary')
  for (const [id, amount] of totals) requireValid(wallets.get(id) === amount, 'Global wallet total does not reconcile with ledger')
  for (const [id, amount] of wallets) requireValid(amount === (totals.get(id) ?? '0'), 'Global wallet total does not reconcile with ledger')
  return Object.fromEntries([...wallets].sort(([a], [b]) => a.localeCompare(b, 'en')))
}

const scopeKeys = ['actor_id', 'site_admin', 'family_id', 'family_role', 'scope_validated', 'evidence_maintenance']
export async function withFamilyOperationalScope<T>(operation: (actor: User) => Promise<T>): Promise<T> {
  return withStorageTransaction(async () => {
    const client = currentDatabaseClient()!
    const actor = (await client.query('SELECT id,username,is_admin,auth_version FROM habittrove.users WHERE is_admin IS TRUE ORDER BY id LIMIT 1')).rows[0]
    requireValid(actor?.is_admin === true, 'Operational backup requires an existing site administrator')
    const prior = await client.query(`SELECT ${scopeKeys.map(key => `current_setting('habittrove.${key}',true) AS ${key}`).join(',')}, current_setting('TimeZone') AS timezone`)
    await client.query("SELECT set_config('habittrove.actor_id',$1,true),set_config('habittrove.site_admin','true',true),set_config('habittrove.family_id','',true),set_config('habittrove.family_role','site-admin',true),set_config('habittrove.scope_validated','',true),set_config('habittrove.evidence_maintenance','true',true),set_config('TimeZone','UTC',true)", [actor.id])
    try { return await operation({ id: actor.id, username: actor.username, isAdmin: true, authVersion: actor.auth_version ?? 0 }) }
    finally { await client.query(`SELECT ${scopeKeys.map((key, index) => `set_config('habittrove.${key}',$${index + 1},true)`).join(',')},set_config('TimeZone',$7,true)`, [...scopeKeys.map(key => prior.rows[0][key] ?? ''), prior.rows[0].timezone]).catch(() => undefined) }
  })
}
export async function familyStorageState(): Promise<'legacy' | 'prepared' | 'enabled'> {
  return withStorageTransaction(async () => {
    const client = currentDatabaseClient()!
    if (!(await client.query("SELECT to_regclass('habittrove.family_configuration') AS name")).rows[0].name) return 'legacy'
    return (await client.query('SELECT enabled FROM habittrove.family_configuration WHERE singleton')).rows[0]?.enabled === true ? 'enabled' : 'prepared'
  }, { readOnly: true })
}
export async function familyBackupRequired() { return await familyStorageState() !== 'legacy' }
async function assertFamilySchema(client: Client | PoolClient) {
  requireValid((await client.query('SELECT version FROM habittrove.schema_version WHERE singleton')).rows[0]?.version === 2, 'Family schema version 2 is required')
  const actual = (await client.query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='habittrove' ORDER BY ordinal_position")).rows
  for (const table of names) {
    const known = FAMILY_SNAPSHOT_TABLES[table]
    const found = actual.filter(row => row.table_name === table)
    requireValid(found.length === known.length && known.every(column => found.some(row => row.column_name === column.name && row.data_type === ({ text: 'text', integer: 'integer', bigint: 'bigint', numeric: 'numeric', boolean: 'boolean', date: 'date', timestamptz: 'timestamp with time zone', jsonb: 'jsonb' }[column.type]))), 'Family schema columns do not match backup version')
  }
  requireValid(actual.every(row => row.table_name === 'schema_version' || names.includes(row.table_name)), 'Unknown family data table requires a newer backup version')
}
async function captureTables(client: Client | PoolClient): Promise<FamilyDatabaseSnapshot> {
  await assertFamilySchema(client)
  const tables = {} as FamilyDatabaseSnapshot['tables']; let bytes = 0
  for (const table of names) {
    bytes += Number((await client.query(`SELECT COALESCE(sum(octet_length(to_jsonb(t)::text)),0)::text AS bytes FROM habittrove.${table} t`)).rows[0].bytes)
    requireValid(bytes <= MAX_SNAPSHOT_BYTES, 'Family structured snapshot exceeds memory budget')
    tables[table] = (await client.query(`SELECT ${FAMILY_SNAPSHOT_TABLES[table].map(column => `${column.name}::text`).join(',')} FROM habittrove.${table}`)).rows.map(row => FAMILY_SNAPSHOT_TABLES[table].map(column => row[column.name] !== null && column.type === 'numeric' ? sumDecimals([row[column.name]]) : row[column.name]))
  }
  const snapshot: FamilyDatabaseSnapshot = { format: 'habittrove-family-database', version: 2, schemaVersion: 2, tables }
  snapshot.tables = canonicalTables(snapshot); validateFamilySnapshot(snapshot)
  requireValid(Buffer.byteLength(JSON.stringify(snapshot)) <= MAX_SNAPSHOT_BYTES, 'Family structured snapshot exceeds memory budget')
  return snapshot
}
function validateFamilyAssets(snapshot: FamilyDatabaseSnapshot, assets: Map<string, Buffer>) {
  for (const row of snapshot.tables.attachments) {
    const attachment = rowObject('attachments', row)
    requireValid(typeof attachment.path === 'string' && /^(avatars|evidence)\/[^/\\]+$/.test(attachment.path), 'Invalid family attachment path')
    const bytes = assets.get(attachment.path)
    // Inaccessible tombstones can survive successful physical cleanup; their flag is still restored.
    if (!bytes && attachment.inaccessible === 'true') continue
    requireValid(bytes && attachment.sha256 && hash(bytes) === attachment.sha256, 'Family attachment asset does not match its stored hash')
  }
}
function capturedFamily(snapshot: FamilyDatabaseSnapshot, assets: Map<string, Buffer>): CapturedFamilySource {
  validateProtectedAssetMap(assets)
  const totals = validateFamilySnapshot(snapshot); validateFamilyAssets(snapshot, assets)
  const data = Buffer.from(JSON.stringify(snapshot, null, 2))
  requireValid(data.length <= MAX_SNAPSHOT_BYTES, 'Family structured snapshot exceeds memory budget')
  const manifest: FamilyBackupManifest = { format: 'habittrove-snapshot', version: 2, schemaVersion: 2, snapshotDigest: hash(encoded(snapshot)), files: { 'family-database.json': { sha256: hash(data), bytes: data.length } }, counts: Object.fromEntries(names.map(name => [name, snapshot.tables[name].length])) as FamilyBackupManifest['counts'], ledgerTotals: totals, assets: Object.fromEntries([...assets].map(([name, bytes]) => [name, { sha256: hash(bytes), bytes: bytes.length }])), externalSecretsRequired: ['AUTH_SECRET'] }
  return { snapshot, manifest, digest: hash(encoded(manifest)), assets }
}
export const createFamilyBackupSource = capturedFamily

export async function captureFamilyDatabaseSource(assetDirectory: string): Promise<CapturedFamilySource> {
  return withFamilyOperationalScope(async () => capturedFamily(await captureTables(currentDatabaseClient()!), await captureProtectedAssets(assetDirectory)))
}
export async function readFamilySource(directory: string): Promise<CapturedFamilySource> {
  const data = await readSnapshotFile(directory, 'family-database.json'), manifestBytes = await readSnapshotFile(directory, 'manifest.json')
  let snapshot: FamilyDatabaseSnapshot, manifest: FamilyBackupManifest
  try { snapshot = JSON.parse(data.toString('utf8')); manifest = JSON.parse(manifestBytes.toString('utf8')) } catch { throw new MigrationValidationError('Invalid family backup JSON') }
  const source = capturedFamily(snapshot, await captureProtectedAssets(directory))
  requireValid(encoded(source.manifest) === encoded(manifest) && data.equals(Buffer.from(JSON.stringify(snapshot, null, 2))), 'Family backup manifest or payload checksum mismatch')
  requireValid(data.equals(await readSnapshotFile(directory, 'family-database.json')) && manifestBytes.equals(await readSnapshotFile(directory, 'manifest.json')), 'Family backup changed during capture')
  return source
}
export async function writeFamilySnapshotDirectory(destination: string, source: CapturedFamilySource) {
  requireValid(encoded(capturedFamily(source.snapshot, source.assets).manifest) === encoded(source.manifest), 'Family capture changed after validation')
  const target = path.resolve(destination)
  await canonicalSourceDirectory(path.dirname(target))
  await fs.mkdir(target, { mode: 0o700 })
  try {
    await fs.writeFile(path.join(target, 'family-database.json'), JSON.stringify(source.snapshot, null, 2), { flag: 'wx', mode: 0o600 })
    await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(source.manifest, null, 2), { flag: 'wx', mode: 0o600 })
    for (const [name, bytes] of source.assets) { await fs.mkdir(path.dirname(path.join(target, name)), { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(target, name), bytes, { flag: 'wx', mode: 0o600 }) }
    return await readFamilySource(target)
  } catch (error) { await fs.rm(target, { recursive: true, force: true }); throw error }
}

type MigrationTls = false | { rejectUnauthorized: true; ca?: string }
function migrationConfiguration(): { target: string; ssl: MigrationTls } {
  const runtime = process.env.DATABASE_URL, migration = process.env.DATABASE_MIGRATION_URL
  requireValid(runtime && migration, 'A separate DATABASE_MIGRATION_URL is required for offline family operations')
  assertDatabaseTarget(runtime); assertDatabaseTarget(migration)
  const active = new URL(runtime), target = new URL(migration)
  requireValid(active.username && target.username && decodeURIComponent(active.username) !== decodeURIComponent(target.username), 'Offline family operations require a separate migration identity')
  requireValid(active.hostname === target.hostname && (active.port || '5432') === (target.port || '5432') && active.pathname === target.pathname, 'Family migration and runtime database targets differ')
  const ssl: MigrationTls = target.searchParams.get('sslmode') === 'verify-full' ? { rejectUnauthorized: true, ...(target.searchParams.get('sslrootcert') ? { ca: target.searchParams.get('sslrootcert')! } : {}) } : false
  target.search = ''
  return { target: target.toString(), ssl }
}
async function withFamilyMigration<T>(operation: (client: Client) => Promise<T>): Promise<T> {
  requireValid(!currentDatabaseClient(), 'Offline family migration must run outside application transactions')
  const configuration = migrationConfiguration()
  const ssl = configuration.ssl === false ? false : { ...configuration.ssl, ...(configuration.ssl.ca ? { ca: await fs.readFile(configuration.ssl.ca, 'utf8') } : {}) }
  const client = new Client({ connectionString: configuration.target, ssl, application_name: 'habittrove-family-offline', connectionTimeoutMillis: 5000, statement_timeout: 15000, lock_timeout: 5000, options: '-c search_path=habittrove,pg_catalog -c timezone=UTC' })
  await client.connect()
  try {
    await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock($1)', [724617631])
    await client.query("SELECT set_config('habittrove.site_admin','true',true),set_config('habittrove.family_role','site-admin',true),set_config('habittrove.evidence_maintenance','true',true)")
    const result = await operation(client)
    await client.query('COMMIT'); return result
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
  finally { await client.end() }
}
function quotedIdentifier(name: string) { return `"${name.replace(/"/g, '""')}"` }
async function configuredRuntimeRole(client: Client): Promise<string> {
  const name = decodeURIComponent(new URL(process.env.DATABASE_URL!).username)
  const role = (await client.query('SELECT oid,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1', [name])).rows[0]
  requireValid(role?.rolcanlogin && !role.rolsuper && !role.rolcreatedb && !role.rolcreaterole && !role.rolreplication && !role.rolbypassrls, 'Configured runtime login must have restricted role attributes')
  const elevated = (await client.query(`SELECT 1 FROM pg_roles WHERE
    (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR left(rolname,3)='pg_')
    AND pg_has_role($1::name,oid,'MEMBER') LIMIT 1`, [name])).rowCount
  requireValid(!elevated, 'Configured runtime login must not inherit privileged roles')
  const ownership = (await client.query(`SELECT
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='habittrove' AND pg_has_role($1::name,c.relowner,'MEMBER')) OR
    EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='habittrove' AND (pg_has_role($1::name,n.nspowner,'MEMBER') OR EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role($1::name,r.oid,'MEMBER') AND has_schema_privilege(r.oid,n.oid,'CREATE')))) OR
    EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND (pg_has_role($1::name,d.datdba,'MEMBER') OR EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role($1::name,r.oid,'MEMBER') AND has_database_privilege(r.oid,d.oid,'CREATE')))) AS authority`, [name])).rows[0].authority
  requireValid(!ownership, 'Configured runtime login must not own or create application objects')
  return quotedIdentifier(role.rolname)
}
export async function migrateFamilyDatabase(): Promise<'prepared' | 'verified'> {
  return withFamilyMigration(async client => {
    const runtime = await configuredRuntimeRole(client)
    const version = (await client.query('SELECT version FROM habittrove.schema_version WHERE singleton')).rows[0]?.version
    const present = (await client.query("SELECT to_regclass('habittrove.family_configuration') AS name")).rows[0]?.name
    if (present) await assertFamilySchema(client)
    else {
      requireValid(version === 1, 'Family prepare requires an existing version 1 database')
      await client.query(await fs.readFile(new URL('./db/family-schema.sql', import.meta.url), 'utf8'))
      await client.query('UPDATE habittrove.schema_version SET version=2 WHERE singleton')
      await assertFamilySchema(client)
    }
    const familyTables = names.filter(name => name.startsWith('family_') || name === 'families' || name === 'household_invitations').filter(name => name !== 'family_configuration')
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${familyTables.map(name => `habittrove.${name}`).join(',')} TO ${runtime}`)
    await client.query(`REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON habittrove.family_configuration,habittrove.global_wallet_totals FROM ${runtime}`)
    await client.query(`GRANT SELECT ON habittrove.family_configuration,habittrove.global_wallet_totals TO ${runtime}`)
    await client.query(`GRANT USAGE ON SEQUENCE habittrove.coin_ledger_family_order TO ${runtime}`)
    const roleName = decodeURIComponent(new URL(process.env.DATABASE_URL!).username)
    const protectedWrites = (await client.query(`SELECT EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role($1::name,r.oid,'MEMBER') AND (has_table_privilege(r.oid,'habittrove.family_configuration','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_table_privilege(r.oid,'habittrove.global_wallet_totals','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r.oid,'habittrove.family_configuration','INSERT,UPDATE,REFERENCES') OR has_any_column_privilege(r.oid,'habittrove.global_wallet_totals','INSERT,UPDATE,REFERENCES'))) AS writable`, [roleName])).rows[0].writable
    requireValid(!protectedWrites, 'Runtime inherits unsafe activation or derived wallet privileges')
    return present ? 'verified' : 'prepared'
  })
}
export async function restoreFamilyDatabase(source: CapturedFamilySource, assetDirectory: string) {
  requireValid(encoded(capturedFamily(source.snapshot, source.assets).manifest) === encoded(source.manifest), 'Family capture changed after validation')
  return withFamilyMigration(async client => {
    await assertFamilySchema(client)
    for (const table of names) {
      if (table === 'family_configuration') {
        const rows = (await client.query('SELECT singleton,enabled FROM habittrove.family_configuration')).rows
        requireValid(rows.length === 1 && rows[0].singleton === true && rows[0].enabled === false, 'Family restore requires an empty disabled target')
      } else requireValid(!(await client.query(`SELECT 1 FROM habittrove.${table} LIMIT 1`)).rowCount, 'Family restore requires an empty target')
    }
    await verifyProtectedAssets(assetDirectory, source)
    // Only this projection trigger is suspended; FK, membership, origin and wallet triggers stay active.
    await client.query('ALTER TABLE habittrove.completions DISABLE TRIGGER family_completion_review_flag')
    for (const table of names) {
      if (table === 'family_configuration' || table === 'global_wallet_totals') continue
      const specification = FAMILY_SNAPSHOT_TABLES[table]
      for (const row of source.snapshot.tables[table]) await client.query(`INSERT INTO habittrove.${table}(${specification.map(column => column.name).join(',')}) VALUES(${specification.map((column, index) => `$${index + 1}::${column.type}`).join(',')})`, row)
    }
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    await client.query('ALTER TABLE habittrove.completions ENABLE TRIGGER family_completion_review_flag')
    for (const row of source.snapshot.tables.global_wallet_totals) {
      const wallet = rowObject('global_wallet_totals', row)
      if (sumDecimals([wallet.balance!]) === '0') await client.query('INSERT INTO habittrove.global_wallet_totals(user_id,balance) VALUES($1,0) ON CONFLICT DO NOTHING', [wallet.user_id])
    }
    await restartFamilyLedgerSequence(client)
    const configuration = rowObject('family_configuration', source.snapshot.tables.family_configuration[0])
    if (configuration.enabled === 'true') requireValid((await activationPreview(client, true)).canActivate, 'Family restore cannot activate incomplete mapping')
    await client.query('UPDATE habittrove.family_configuration SET enabled=$1::boolean WHERE singleton', [configuration.enabled])
    const restored = await captureTables(client)
    requireValid(encoded(restored) === encoded(source.snapshot), 'Family restore did not round-trip exactly')
    return 'restored' as const
  })
}
export async function verifyFamilyDatabase(source: CapturedFamilySource, assetDirectory?: string) {
  return withFamilyOperationalScope(async () => {
    if (assetDirectory) await verifyProtectedAssets(assetDirectory, source)
    requireValid(encoded(await captureTables(currentDatabaseClient()!)) === encoded(source.snapshot), 'Family database does not match snapshot')
  })
}

export function readFamilyBackupSettings(source: CapturedFamilySource): import('./types').Settings {
  const settings = Object.fromEntries(source.snapshot.tables.setting_sections.map(row => {
    const item = rowObject('setting_sections', row)
    return [item.name!, JSON.parse(item.value!)]
  })) as import('./types').Settings
  requireValid(settings.system && typeof settings.system.autoBackupEnabled === 'boolean', 'Missing instance backup settings')
  return settings
}

export interface FamilyActivationPreview { sourceHash: string; issues: Record<string, number>; canActivate: boolean }
async function activationPreview(client: Client | PoolClient, allowEmpty: boolean): Promise<FamilyActivationPreview> {
  const snapshot = await captureTables(client)
  const issues: Record<string, number> = {}
  const count = async (name: string, sql: string) => { issues[name] = Number((await client.query(sql)).rows[0].count) }
  for (const table of ['habits', 'habit_assignees', 'habit_approvers', 'checklist_entries', 'completions', 'completion_recipients', 'slips', 'wishlist_items', 'wishlist_assignees', 'coin_ledger']) {
    await count(`unmapped_${table}`, `SELECT count(*) FROM habittrove.${table} WHERE family_id IS NULL`)
  }
  await count('unmapped_evidence', "SELECT count(*) FROM habittrove.attachments WHERE path NOT LIKE 'avatars/%' AND family_id IS NULL")
  await count('unclaimed_ledger', 'SELECT count(*) FROM habittrove.coin_ledger WHERE user_id IS NULL')
  await count('unbound_invitations', 'SELECT count(*) FROM habittrove.invitations')
  await count('families_without_owner', "SELECT count(*) FROM habittrove.families f WHERE NOT EXISTS(SELECT 1 FROM habittrove.family_memberships m WHERE m.family_id=f.id AND m.active AND m.role='owner')")
  await count('inactive_assignments', `SELECT count(*) FROM (
    SELECT family_id,user_id FROM habittrove.habit_assignees UNION ALL SELECT family_id,user_id FROM habittrove.habit_approvers UNION ALL SELECT family_id,user_id FROM habittrove.wishlist_assignees
    ) a WHERE NOT EXISTS(SELECT 1 FROM habittrove.family_memberships m WHERE m.family_id=a.family_id AND m.user_id=a.user_id AND m.active)`)
  await count('invalid_delegations', `SELECT count(*) FROM habittrove.family_manager_assignments a
    WHERE NOT EXISTS(SELECT 1 FROM habittrove.family_memberships m WHERE m.family_id=a.family_id AND m.user_id=a.manager_id AND m.active AND m.role IN ('owner','manager'))
       OR NOT EXISTS(SELECT 1 FROM habittrove.family_memberships m WHERE m.family_id=a.family_id AND m.user_id=a.member_id AND m.active)`)
  await count('unreviewed_delegations', `SELECT count(*) FROM habittrove.manager_assignments a WHERE NOT EXISTS(SELECT 1 FROM habittrove.family_manager_assignments f WHERE f.manager_id=a.manager_id AND f.member_id=a.member_id) AND NOT EXISTS(SELECT 1 FROM habittrove.family_legacy_adoptions d WHERE (d.mapping->'userIds') ? a.manager_id AND (d.mapping->'userIds') ? a.member_id)`)
  await count('missing_revisions', "SELECT count(*) FROM habittrove.families f CROSS JOIN (VALUES('habits'),('wishlist')) k(kind) WHERE NOT EXISTS(SELECT 1 FROM habittrove.family_document_revisions r WHERE r.family_id=f.id AND r.kind=k.kind)")
  await count('missing_settings', 'SELECT count(*) FROM habittrove.families f WHERE NOT EXISTS(SELECT 1 FROM habittrove.family_settings s WHERE s.family_id=f.id)')
  await count('missing_permissions', "SELECT count(*) FROM habittrove.family_memberships m CROSS JOIN (VALUES('habit'),('wishlist'),('coins')) p(resource) WHERE m.active AND NOT EXISTS(SELECT 1 FROM habittrove.family_permissions f WHERE f.family_id=m.family_id AND f.user_id=m.user_id AND f.resource=p.resource)")
  const empty = snapshot.tables.families.length === 0
  const adminOnly = snapshot.tables.users.length === 1 && rowObject('users', snapshot.tables.users[0]).is_admin === 'true'
  const noDomain = ['habits', 'wishlist_items', 'coin_ledger', 'attachments'].every(name => snapshot.tables[name as FamilySnapshotTable].length === 0)
  issues.empty_installation = empty && !(allowEmpty && adminOnly && noDomain) ? 1 : 0
  return { sourceHash: hash(encoded({ snapshot, allowEmpty })), issues, canActivate: Object.values(issues).every(value => value === 0) }
}
export async function previewFamilyActivation(allowEmpty = false) {
  return withFamilyOperationalScope(async () => activationPreview(currentDatabaseClient()!, allowEmpty))
}
export async function activateFamilyDatabase(expectedSourceHash: string, allowEmpty = false) {
  requireValid(/^[a-f0-9]{64}$/.test(expectedSourceHash), 'A reviewed activation source hash is required')
  return withFamilyMigration(async client => {
    await assertFamilySchema(client)
    const actor = (await client.query('SELECT id FROM habittrove.users WHERE is_admin IS TRUE ORDER BY id LIMIT 1')).rows[0]
    requireValid(actor, 'Activation requires an existing site administrator')
    requireValid((await client.query('SELECT enabled FROM habittrove.family_configuration WHERE singleton')).rows[0]?.enabled === false, 'Family activation requires a disabled installation')
    const preview = await activationPreview(client, allowEmpty)
    requireValid(preview.sourceHash === expectedSourceHash, 'Family activation source changed; review a new preview')
    requireValid(preview.canActivate, 'Family activation requires complete explicit mapping and valid membership')
    await restartFamilyLedgerSequence(client)
    await client.query('UPDATE habittrove.family_configuration SET enabled=true WHERE singleton')
    for (const family of (await client.query('SELECT id FROM habittrove.families')).rows) await client.query("INSERT INTO habittrove.family_audit(id,family_id,actor_id,action) VALUES($1,$2,$3,'families-enabled')", [randomUUID(), family.id, actor.id])
    return 'activated' as const
  })
}

async function restartFamilyLedgerSequence(client: Client) {
  const minimum = BigInt((await client.query('SELECT COALESCE(min(ordinal),0)::text AS minimum FROM habittrove.coin_ledger')).rows[0].minimum)
  const next = minimum < BigInt(0) ? minimum - BigInt(1) : BigInt(-1)
  requireValid(next >= BigInt('-9223372036854775808'), 'Family ledger order is exhausted')
  // RESTART is transactional; a failed restore/activation cannot leave a partially advanced sequence.
  await client.query(`ALTER SEQUENCE habittrove.coin_ledger_family_order RESTART WITH ${next.toString()}`)
}
