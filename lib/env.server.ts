import { z } from "zod"
import { assertDatabaseTarget, currentDatabaseClient, withStorageTransaction } from './db/client'
import { readAuthDocument, readDocument } from './db/repository'
import type { PoolClient } from 'pg'
import type { User } from './types'
import { usesPostgres } from './storage-mode'

const optionalUrl = z.preprocess(value => value === '' ? undefined : value, z.url().optional())
const optionalName = z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional())

const zodEnv = z.object({
  AUTH_SECRET: z.string().min(32),
  AUTH_URL: optionalUrl,
  AUTHENTIK_ISSUER: optionalUrl,
  AUTHENTIK_CLIENT_ID: optionalName,
  AUTHENTIK_CLIENT_SECRET: optionalName,
  OIDC_ISSUER: optionalUrl,
  OIDC_CLIENT_ID: optionalName,
  OIDC_CLIENT_SECRET: optionalName,
  DEMO: z.string().optional(),
}).superRefine((env, context) => {
  const fields = [env.AUTHENTIK_ISSUER, env.AUTHENTIK_CLIENT_ID, env.AUTHENTIK_CLIENT_SECRET]
  if (fields.some(Boolean) && (!fields.every(Boolean) || !env.AUTH_URL)) {
    context.addIssue({ code: 'custom', message: 'Authentik requires AUTH_URL, AUTHENTIK_ISSUER, AUTHENTIK_CLIENT_ID, and AUTHENTIK_CLIENT_SECRET' })
  }
  const oidcFields = [env.OIDC_ISSUER, env.OIDC_CLIENT_ID, env.OIDC_CLIENT_SECRET]
  if (oidcFields.some(Boolean) && (!oidcFields.every(Boolean) || !env.AUTH_URL)) {
    context.addIssue({ code: 'custom', message: 'OIDC requires AUTH_URL, OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET' })
  }
  for (const [name, value] of [['AUTH_URL', env.AUTH_URL], ['AUTHENTIK_ISSUER', env.AUTHENTIK_ISSUER], ['OIDC_ISSUER', env.OIDC_ISSUER]]) {
    if (value && new URL(value).protocol !== 'https:' && process.env.NODE_ENV !== 'development') {
      context.addIssue({ code: 'custom', message: `${name} must use HTTPS in production` })
    }
  }
})

declare global {
  interface ProcessEnv extends z.TypeOf<typeof zodEnv> {
    AUTH_SECRET: string;
    AUTH_URL?: string;
    AUTHENTIK_ISSUER?: string;
    AUTHENTIK_CLIENT_ID?: string;
    AUTHENTIK_CLIENT_SECRET?: string;
    OIDC_ISSUER?: string;
    OIDC_CLIENT_ID?: string;
    OIDC_CLIENT_SECRET?: string;
    DEMO?: string;
  }
}

export function init() {
  try {
    zodEnv.parse(process.env)
    if (usesPostgres()) {
      assertDatabaseTarget(process.env.DATABASE_URL!)
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      const { fieldErrors, formErrors } = err.flatten()
      const errorMessage = Object.entries(fieldErrors)
        .map(([field, errors]) =>
          Array.isArray(errors) ? `${field}: ${errors.join(", ")}` : field,
        )
        .concat(formErrors)
        .join("\n ")

      throw new Error(
        `Invalid environment variables:\n ${errorMessage}`,
      )
    }
    throw err
  }
}

const familyBoundaryTables = [
  'families', 'family_memberships', 'family_document_revisions', 'family_manager_assignments',
  'family_permissions', 'family_preferences', 'family_settings', 'household_invitations',
  'family_audit', 'family_legacy_adoptions', 'habits', 'habit_assignees', 'habit_approvers',
  'checklist_entries', 'completions', 'completion_recipients', 'slips', 'wishlist_items',
  'wishlist_assignees', 'coin_ledger', 'attachments',
]
const familyOriginTables = [
  'habits', 'habit_assignees', 'habit_approvers', 'checklist_entries', 'completions',
  'completion_recipients', 'slips', 'wishlist_items', 'wishlist_assignees', 'coin_ledger',
]

async function validateFamilyStorage(client: PoolClient, administrator: User): Promise<void> {
  const tables = (await client.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='habittrove' AND c.relkind='r' AND c.relname=ANY($1::text[])`,
  [[...familyBoundaryTables, 'global_wallet_totals', 'family_configuration']])).rows
  if (tables.length !== familyBoundaryTables.length + 2 || tables.some(table =>
    table.relname !== 'family_configuration' && (!table.relrowsecurity ||
      table.relname !== 'global_wallet_totals' && !table.relforcerowsecurity))) {
    throw new Error('Incomplete family row-security preparation')
  }
  const protectedWrites = (await client.query(`SELECT EXISTS(SELECT 1 FROM pg_roles r
    WHERE pg_has_role(current_user,r.oid,'MEMBER') AND (
      has_table_privilege(r.oid,'habittrove.family_configuration','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_any_column_privilege(r.oid,'habittrove.family_configuration','INSERT,UPDATE,REFERENCES') OR
      has_table_privilege(r.oid,'habittrove.global_wallet_totals','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_any_column_privilege(r.oid,'habittrove.global_wallet_totals','INSERT,UPDATE,REFERENCES'))) AS writable`)).rows[0].writable
  if (protectedWrites) throw new Error('Runtime cannot modify family activation or derived wallet totals')
  const columns = (await client.query(`SELECT table_name FROM information_schema.columns
    WHERE table_schema='habittrove' AND column_name='family_id' AND table_name=ANY($1::text[])`,
  [[...familyOriginTables, 'attachments']])).rows
  if (columns.length !== familyOriginTables.length + 1) throw new Error('Incomplete family origin preparation')
  const functions = (await client.query(`SELECT p.proname,p.prosecdef,pg_has_role(current_user,p.proowner,'MEMBER') AS runtime_owned
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='habittrove'
    AND p.proname=ANY($1::text[])`,
  [['maintain_global_wallet', 'check_family_ledger_origin', 'family_scope_matches', 'family_legacy_mode']])).rows
  if (functions.length !== 4 || functions.some(fn => fn.runtime_owned ||
    fn.prosecdef !== ['maintain_global_wallet', 'check_family_ledger_origin'].includes(fn.proname))) {
    throw new Error('Invalid family function authority')
  }
  if (!(await client.query("SELECT to_regclass('habittrove.coin_ledger_family_order') AS name")).rows[0].name) {
    throw new Error('Missing family ledger sequence')
  }
  const enabled = (await client.query('SELECT enabled FROM habittrove.family_configuration WHERE singleton=true')).rows[0]?.enabled
  if (enabled !== true) return
  // Startup has no HTTP identity. Use a freshly persisted site administrator solely for this read-only audit.
  const { withFreshFamilyActor } = await import('./family-scope')
  await withFreshFamilyActor(administrator, async siteAdmin => {
    if (!siteAdmin) throw new Error('Missing operational administrator')
    for (const table of familyOriginTables) {
      if ((await client.query(`SELECT 1 FROM habittrove.${table} WHERE family_id IS NULL LIMIT 1`)).rowCount) {
        throw new Error('Incomplete family origin mapping')
      }
    }
    if ((await client.query(`SELECT 1 FROM habittrove.attachments
      WHERE (path NOT LIKE 'avatars/%' AND family_id IS NULL) OR (path LIKE 'avatars/%' AND family_id IS NOT NULL) LIMIT 1`)).rowCount) {
      throw new Error('Incomplete attachment family mapping')
    }
    if ((await client.query(`SELECT 1 FROM habittrove.families f
      WHERE NOT EXISTS(SELECT 1 FROM habittrove.family_memberships m WHERE m.family_id=f.id AND m.active AND m.role='owner')
      OR NOT EXISTS(SELECT 1 FROM habittrove.family_document_revisions d WHERE d.family_id=f.id AND d.kind='habits')
      OR NOT EXISTS(SELECT 1 FROM habittrove.family_document_revisions d WHERE d.family_id=f.id AND d.kind='wishlist')
      OR NOT EXISTS(SELECT 1 FROM habittrove.family_settings s WHERE s.family_id=f.id) LIMIT 1`)).rowCount) {
      throw new Error('Incomplete family ownership or document initialization')
    }
    if ((await client.query(`SELECT 1 FROM habittrove.family_memberships m
      CROSS JOIN (VALUES('habit'),('wishlist'),('coins')) resource(name)
      WHERE m.active AND NOT EXISTS(SELECT 1 FROM habittrove.family_permissions p
        WHERE p.family_id=m.family_id AND p.user_id=m.user_id AND p.resource=resource.name) LIMIT 1`)).rowCount) {
      throw new Error('Incomplete family permission initialization')
    }
  }, { readOnly: true })
}

// Read-only validation: provisioning and imports belong to the offline CLI.
export async function validateRuntimeStorage(): Promise<void> {
  if (!usesPostgres()) return
  try {
    await withStorageTransaction(async () => {
      const client = currentDatabaseClient()!
      const identity = (await client.query(`SELECT current_database() AS database, current_user AS username,
        rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
        FROM pg_roles WHERE rolname=current_user`)).rows[0]
      const target = new URL(process.env.DATABASE_URL!)
      if (!identity || identity.database !== decodeURIComponent(target.pathname.slice(1)) ||
          identity.username !== decodeURIComponent(target.username) || identity.rolsuper || identity.rolcreatedb ||
          identity.rolcreaterole || identity.rolreplication || identity.rolbypassrls) {
        throw new Error('Invalid runtime database identity or privileges')
      }
      const owners = await client.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='habittrove' AND pg_has_role(current_user,c.relowner,'MEMBER') LIMIT 1`)
      if (owners.rowCount) throw new Error('Runtime database login must not own application tables')
      const elevated = await client.query(`SELECT 1 FROM pg_roles WHERE
        (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR left(rolname,3)='pg_')
        AND pg_has_role(current_user,oid,'MEMBER') LIMIT 1`)
      if (elevated.rowCount) throw new Error('Runtime database login must not inherit privileged roles')
      // NOINHERIT still permits SET ROLE; include ACLs of every reachable membership.
      const databasePrivileges = await client.query(`SELECT 1 FROM pg_database d WHERE datname=current_database()
        AND (pg_has_role(current_user,d.datdba,'MEMBER') OR EXISTS(SELECT 1 FROM pg_roles r
          WHERE pg_has_role(current_user,r.oid,'MEMBER') AND has_database_privilege(r.oid,d.oid,'CREATE')))`)
      if (databasePrivileges.rowCount) throw new Error('Runtime database login must not own or create database schemas')
      const schemaPrivileges = await client.query(`SELECT 1 FROM pg_namespace n
        WHERE pg_has_role(current_user,n.nspowner,'MEMBER') OR EXISTS(SELECT 1 FROM pg_roles r
          WHERE pg_has_role(current_user,r.oid,'MEMBER') AND has_schema_privilege(r.oid,n.oid,'CREATE')) LIMIT 1`)
      if (schemaPrivileges.rowCount) throw new Error('Runtime database login must not own schemas or create schema objects')
      const accounts = await readAuthDocument()
      const administrator = accounts?.users.find(user => user.isAdmin)
      if (!accounts?.users.length || !administrator) throw new Error('Missing initialized accounts')
      const version = (await client.query('SELECT version FROM habittrove.schema_version WHERE singleton=true')).rows[0].version
      if (version === 1) {
        for (const kind of ['habits', 'wishlist', 'coins', 'settings'] as const) {
          if (!await readDocument(kind)) throw new Error('Missing imported application data')
        }
      } else {
        const documents = await client.query("SELECT kind FROM habittrove.documents WHERE kind=ANY($1::text[])", [['auth', 'habits', 'wishlist', 'coins', 'settings']])
        if (documents.rowCount !== 5) throw new Error('Missing initialized global documents')
        await validateFamilyStorage(client, administrator)
      }
    }, { readOnly: true })
  } catch {
    throw new Error('HabitTrove database startup validation failed; verify configuration, migration and imported data')
  }
}
