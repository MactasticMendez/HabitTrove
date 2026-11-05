import { z } from "zod"
import { assertDatabaseTarget, currentDatabaseClient, withStorageTransaction } from './db/client'
import { readAuthDocument, readDocument } from './db/repository'
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
      const databasePrivileges = await client.query(`SELECT 1 FROM pg_database WHERE datname=current_database()
        AND (pg_has_role(current_user,datdba,'MEMBER') OR has_database_privilege(current_user,oid,'CREATE'))`)
      if (databasePrivileges.rowCount) throw new Error('Runtime database login must not own or create database schemas')
      const schemaPrivileges = await client.query(`SELECT 1 FROM pg_namespace
        WHERE pg_has_role(current_user,nspowner,'MEMBER') OR has_schema_privilege(current_user,oid,'CREATE') LIMIT 1`)
      if (schemaPrivileges.rowCount) throw new Error('Runtime database login must not own schemas or create schema objects')
      const accounts = await readAuthDocument()
      if (!accounts?.users.length || !accounts.users.some(user => user.isAdmin)) throw new Error('Missing initialized accounts')
      for (const kind of ['habits', 'wishlist', 'coins', 'settings'] as const) {
        if (!await readDocument(kind)) throw new Error('Missing imported application data')
      }
    }, { readOnly: true })
  } catch {
    throw new Error('HabitTrove database startup validation failed; verify configuration, migration and imported data')
  }
}
