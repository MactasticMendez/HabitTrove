import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
const SCHEMA_VERSION = 1;
const WRITE_LOCK = 724617631;
const context = new AsyncLocalStorage<{
  client: PoolClient;
  readOnly: boolean;
  failed: boolean;
  active: boolean;
  afterCommit: (()=>Promise<void>)[];
}>();
let pool: Pool | undefined;
export function assertDatabaseTarget(connectionString: string, allowTest = process.env.HABITTROVE_TEST_DATABASE === '1'): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  }
  catch {
    throw new Error('Invalid HabitTrove database configuration');
  }
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !(name === 'habittrove' || (allowTest && /^habittrove_(test|qa)_[a-z0-9_]+$/.test(name)))) {
    throw new Error('Refusing non-HabitTrove database target');
  }
  const accepted = new Set(['sslmode','sslrootcert']);
  const seen = new Set<string>();
  for(const [key] of url.searchParams) {
    if(!accepted.has(key) || seen.has(key)) throw new Error('Database URL query override is prohibited');
    seen.add(key);
  }
  if(url.hash || (url.searchParams.has('sslmode') && url.searchParams.get('sslmode') !== 'verify-full') ||
    (url.searchParams.has('sslrootcert') && url.searchParams.get('sslmode') !== 'verify-full')) {
    throw new Error('Database TLS configuration must verify the server');
  }
}
function configuredPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString)
    throw new Error('DATABASE_URL is required');
  assertDatabaseTarget(connectionString);
  const target = new URL(connectionString);
  const ssl = target.searchParams.get('sslmode') === 'verify-full'
    ? {rejectUnauthorized:true,...(target.searchParams.get('sslrootcert')?{ca:readFileSync(target.searchParams.get('sslrootcert')!,'utf8')}:{})}
    : false;
  // Remove validated TLS query keys so the driver cannot replace the explicit verified TLS policy.
  target.search='';
  const result = new Pool({ connectionString:target.toString(),ssl, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 15000, lock_timeout: 5000, application_name: 'habittrove', options: '-c search_path=habittrove,pg_catalog' });
  // Idle connection failures are reported by the next request without leaking connection details to logs.
  result.on('error', () => undefined);
  return result;
}
export function currentDatabaseClient(): PoolClient | undefined {
  const state=context.getStore();
  return state?.active?state.client:undefined;
}
async function runCleanup(operation:()=>Promise<void>):Promise<void> {
  try {await context.exit(operation);} catch {
    // A committed write must never be reported as retryable because its file cleanup failed.
  }
}
export async function afterStorageCommit(operation:()=>Promise<void>):Promise<void> {
  const state=context.getStore();
  if(!state) {await runCleanup(operation);return;}
  if(!state.active)throw new Error('Database transaction is no longer active');
  if(state.readOnly)throw new Error('Cannot register cleanup in a read-only database snapshot');
  state.afterCommit.push(operation);
}
export async function withStorageTransaction<T>(operation: () => Promise<T>, options: {
  readOnly?: boolean;
} = {}): Promise<T> {
  const existing = context.getStore();
  if (existing) {
    if(!existing.active)throw new Error('Database transaction is no longer active');
    if (existing.readOnly && !options.readOnly)
      throw new Error('Cannot write within a read-only database snapshot');
    try { return await operation(); }
    catch (error) { existing.failed = true; throw error; }
  }
  pool ??= configuredPool();
  const client = await pool.connect();
  const state={client,readOnly:!!options.readOnly,failed:false,active:true,afterCommit:[] as (()=>Promise<void>)[]};
  let result:T;
  try {
    await client.query(options.readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    if (!options.readOnly)
      await client.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK]);
    const version = await client.query('SELECT version FROM habittrove.schema_version WHERE singleton = true');
    if (version.rows[0]?.version !== SCHEMA_VERSION)
      throw new Error('HabitTrove database schema migration required');
    result = await context.run(state, operation);
    if (state.failed) throw new Error('Nested database operation failed; transaction rolled back');
    const committed = await client.query('COMMIT');
    if (committed.command !== 'COMMIT') throw new Error('Database transaction was aborted');
  }
  catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  finally {
    state.active=false;
    client.release();
  }
  for(const cleanup of state.afterCommit)await runCleanup(cleanup);
  return result;
}
// Called by the offline migration command only; runtime transactions never execute DDL.
export async function migrateDatabase(): Promise<void> {
  const migrationPool = configuredPool(process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL);
  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK]);
    const existing = await client.query("SELECT to_regclass('habittrove.schema_version') AS table_name");
    if (existing.rows[0].table_name) {
      const version = await client.query('SELECT version FROM habittrove.schema_version WHERE singleton = true');
      if (version.rows[0]?.version !== SCHEMA_VERSION)
        throw new Error('Unsupported HabitTrove schema version');
    }
    else {
      const occupied = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = 'habittrove'");
      if (occupied.rowCount)
        throw new Error('Refusing migration into an unversioned HabitTrove schema');
      await client.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    }
    await client.query('COMMIT');
  }
  catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  finally {
    client.release();
    await migrationPool.end();
  }
}
export async function closeDatabase(): Promise<void> {
  const old = pool;
  pool = undefined;
  if (old) await old.end();
}
