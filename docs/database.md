# PostgreSQL operations

Version 0.9.0 (Stage A) changes persistence without changing existing product access. PostgreSQL is the only authoritative production store for accounts/password hashes, OIDC bindings, invitations, permissions, manager assignments, habits/tasks, approvals, rewards, coin history, settings, encrypted administrator configuration, authentication throttles, job leases and attachment metadata. Binary avatar/evidence files remain in the protected `data` mount. IDs, event order, legacy/null/voided records and finite fractional coin values are preserved; import does not recalculate rewards.

Tables normalize relationships, events and ledger ownership. Validated JSONB retains flexible schedules/preferences and compatible legacy fields. Related authorization and business writes share one connection and transaction; a database advisory write lock serializes writers across processes. Read snapshots use repeatable-read transactions. The pool is limited to five connections per process, with 5-second connection/lock and 15-second statement timeouts. Database failure is an error, never permission to write stale JSON.

## Provision a dedicated database

Use the existing approved PostgreSQL 17.11 endpoint. Do not upgrade/recreate the shared server, change its volumes/network/configuration, alter another application's grants, or restore cluster-wide dumps. Provisioning is a separate, reviewed administrator operation; application startup performs no DDL.

Before provisioning, retain a metadata-only inventory of server version, database names/owners and relevant privileges. Confirm that `habittrove`, the selected owner/migration roles and the runtime login are unused; stop and inspect any collision. Production uses the dedicated login configured in `DATABASE_URL`; the app validates the actual database and login rather than requiring a particular personal username.

Create the `habittrove` database, a non-login owner, a separate offline migration identity and a runtime login. Apply `lib/db/schema.sql` once in a transaction under the owner identity through a reviewed owner session. The offline migration identity may assume that owner for DDL; runtime must never be a member of either owner or migration roles. `database.mjs migrate` can apply the initial schema with its migration identity or validate an existing version; when it creates objects, they belong to that executing identity, so the provisioning procedure must establish the intended non-login ownership before release.

Runtime must have `LOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, `NOBYPASSRLS`, and no membership path to elevated or application-owner roles. Use `NOINHERIT` as an additional restriction, not as a substitute for removing such memberships. Restrict database `CONNECT` and schema privileges to the intended roles. Grant runtime only:

| Object | Runtime privilege |
| --- | --- |
| `habittrove` database | `CONNECT` |
| `habittrove` schema | `USAGE`, no `CREATE` |
| `habittrove.schema_version` | `SELECT` only |
| Core application tables listed below | `SELECT`, `INSERT`, `UPDATE`, `DELETE` |

Core tables: `documents`, `users`, `oidc_identities`, `permissions`, `manager_assignments`, `folders`, `folder_items`, `status_days`, `invitations`, `habits`, `habit_assignees`, `habit_approvers`, `checklist_entries`, `completions`, `completion_recipients`, `slips`, `wishlist_items`, `wishlist_assignees`, `coin_ledger`, `setting_sections`, `admin_configuration`, `migration_batches`, `authentication_throttles`, `job_leases`, `attachments`. Do not grant `TRUNCATE`, schema creation or blanket rights on future tables.

Inspect effective privileges, including inherited `PUBLIC` database/schema/table/function grants, across the shared service using metadata only. Direct grants alone do not prove isolation. If this login would expose another application's objects, stop and choose reviewed isolation or separate hosting; do not repair another application's permissions. Repeat the version/database/owner inventory after provisioning and retain the comparison privately.

Store credentials outside Git in a restricted secret location. Runtime gets `DATABASE_URL` only; `DATABASE_MIGRATION_URL` is for an offline provisioning shell and must not be installed in the regular application container. The CLI checks that migration and runtime URLs target the same host, port and database. URLs accept only validated TLS options (`sslmode=verify-full`, optionally `sslrootcert`); do not use URL options to override roles, targets or timeouts. Use verified TLS on remote/untrusted networks. A trusted existing private host/container endpoint may use its approved local transport.

## Build the offline commands

From the checkout, install locked dependencies and build the Node bundles:

```bash
npm ci --ignore-scripts --force --no-audit --no-fund
npm run build:database
```

The production image also includes `scripts/database.mjs`, the built database/recovery bundles and SQL. Bun is needed for tests, not production recovery. Run commands from a working directory whose `data` subdirectory is the final protected asset directory. Supply environment variables privately; never paste connection URLs into tickets or logs.

| Command | Effect |
| --- | --- |
| `node scripts/database.mjs migrate` | Offline schema creation/version validation using the migration connection |
| `node scripts/database.mjs init` | Initialize an empty, migrated database for a new installation |
| `node scripts/database.mjs dry-run SOURCE --manifest PRIVATE_MANIFEST` | Validate unchanged legacy files/assets and write a new private manifest outside the source; no database needed |
| `node scripts/database.mjs import SOURCE` | Import into an empty migrated target; identical replay verifies, different/nonempty target is rejected |
| `node scripts/database.mjs verify SOURCE` | Compare the database snapshot and protected assets with the validated source |
| `node scripts/database.mjs export NEW_DIRECTORY` | Capture a current database snapshot and assets, write a new private reverse-export directory and checksum manifest |
| `node scripts/database.mjs restore SNAPSHOT_DIRECTORY` | Verify the saved checksum manifest and import into an empty migrated target |

`SOURCE` contains `auth.json`, `habits.json`, `wishlist.json`, `coins.json`, `settings.json`, optional `admin-config.json`, and the protected asset directories. Dry-run rejects identity collisions, malformed history, unsafe numbers, missing/tampered assets, symlinks and unsafe paths. Its console report contains aggregate counts/digest; the private manifest contains account IDs, ledger totals and hashes. Export destinations must not exist; commands never overwrite rollback evidence.

## New installation

Provision and migrate the database first. With the restricted runtime `DATABASE_URL` available only in the offline shell, choose the initial local administrator email and a 12–128-character password:

```bash
printf 'Initial administrator email: '
read -r INITIAL_ADMIN_EMAIL
printf 'Initial administrator password: '
read -rs INITIAL_ADMIN_PASSWORD
printf '\n'
export INITIAL_ADMIN_EMAIL INITIAL_ADMIN_PASSWORD
node scripts/database.mjs init
unset INITIAL_ADMIN_EMAIL INITIAL_ADMIN_PASSWORD
```

This creates username `admin`, a new account ID, a salted password hash and empty application/default settings documents atomically. It rejects an already populated database; do not use it for an existing installation. Remove the initial credentials from runtime configuration. Configure a stable random `AUTH_SECRET` of at least 32 characters, retain a separately protected recovery copy, mount the owner-only asset/backup directories and start the app. The first sign-in uses the chosen local credentials; no default password is created at startup.

## Existing installation migration

1. Build and test the pinned application image. Rehearse import and recovery against an empty isolated database, including local login, encrypted provider settings, balances and protected evidence. Retain the current image and a private backup of data, environment and application container/template settings.
2. Stop HabitTrove writes. Copy its JSON and asset directory to private read-only migration evidence. Preserve the original `AUTH_SECRET`; encrypted OIDC/SMTP values require it. The shared PostgreSQL server remains running.
3. Dry-run the frozen source and retain the manifest outside it. Review counts, identities, ledger totals and historical records privately. Fix source problems through a reviewed process, then produce a new dry-run manifest rather than editing one.
4. With offline migration credentials, run `migrate` against the dedicated target. Verify non-login ownership and runtime grants. Mount/copy the source assets at their final protected `data` paths before import; import validates those bytes and never overwrites the asset volume.
5. Run `import SOURCE`, then `verify SOURCE` with the restricted runtime URL. Confirm the source still matches the reviewed manifest. Never initialize or import automatically during app startup.
6. Start the pinned image with runtime credentials only. Check actual database identity/schema, mounts, startup logs and local HTTP, then exercise existing local and OIDC sign-ins, settings, approval/undo/reward flows and evidence. Confirm persisted results after restart before declaring the cutover accepted. Recheck the shared-server metadata inventory; no other application's state should change.

For disposable tests only, database commands accept `--allow-test-database` together with `HABITTROVE_TEST_DATABASE=1`; allowed names are `habittrove_test_*` or `habittrove_qa_*`. These switches never permit an unrelated database name.

## Backup, restore and rollback

Application backups read a consistent database snapshot, copy required protected assets and include `manifest.json`; they do not archive stale JSON as authoritative data. Asset capture and cleanup share the database write lock. A shared database lease prevents duplicate scheduled backups. Archives publish only after completion, retain seven backups and fail if captured assets exceed the 512 MiB memory budget. The limit is an operational ceiling; monitor backup success and plan a reviewed streaming path before assets grow beyond it.

Backups contain sensitive credential hashes and encrypted secrets. Restrict archive/destination access. Preserve `AUTH_SECRET`, database connection/provisioning details and the prior application image separately; downloadable archives deliberately omit the external decryption key. A database-only `pg_dump` of **only** `habittrove` is an additional recovery path, not a replacement for asset capture or a license to restore globals/other databases.

For a restore drill, extract the private app snapshot into a new protected directory; provision/migrate a fresh isolated target, place the verified assets under its working directory's `data`, then run `restore SNAPSHOT_DIRECTORY` and `verify SNAPSHOT_DIRECTORY`. The saved manifest is mandatory for `restore`. Start the matching app with the original `AUTH_SECRET` and verify local login, provider-secret decryption, balances, event history and evidence. A successful file extraction or CLI status alone is not end-to-end recovery proof.

Before new PostgreSQL writes, rollback can restore the saved image, original files and environment. After new writes, stop writes and create a current verified `export NEW_DIRECTORY`; restore/reconcile that reverse export with the previous version and test it before switching traffic. Never point the old image at stale pre-cutover JSON and discard accepted database writes. Keep rollback assets and the previous image until acceptance is complete.

Password recovery uses `node scripts/set-local-password.mjs USERNAME` with the new password on stdin and the restricted runtime connection. Stop the app first, keep a complete backup and retain the script's owner-only prior credential snapshot. It preserves account IDs and OIDC links, updates the database password and invalidates sessions; editing `auth.json` no longer changes production accounts. See the README for the Compose recovery invocation.

## Isolated database tests

The PR workflow starts PostgreSQL 17.11 on `127.0.0.1:15432` with generated ephemeral administrator credentials and temporary storage. `node scripts/test-database.mjs` builds the Node CLI, creates a separate restricted runtime login and eight dedicated scratch databases, then runs repository, import/backup/recovery, fresh-install rollback/concurrency, auth, server-action and media integration suites in separate Bun processes. The runner refuses existing names/roles and never drops a database or modifies production. Its administrator URL must target exactly `127.0.0.1:15432/postgres`, and `HABITTROVE_TEST_DATABASE=1` is required.

For local testing, use a fresh disposable service, not the shared server:

```bash
export POSTGRES_TEST_PASSWORD=$(openssl rand -hex 32)
# DATABASE_URL and AUTH_SECRET must also be configured for Compose interpolation.
docker compose --profile database-test up -d --wait postgres-test
export HABITTROVE_TEST_ADMIN_URL="postgresql://habittrove_test_owner:${POSTGRES_TEST_PASSWORD}@127.0.0.1:15432/postgres"
HABITTROVE_TEST_DATABASE=1 node scripts/test-database.mjs
docker compose --profile database-test stop postgres-test
docker compose --profile database-test rm -f postgres-test
unset POSTGRES_TEST_PASSWORD HABITTROVE_TEST_ADMIN_URL
```

The profile uses no persistent database volume and is never a dependency of the production app. Stopping/removing it discards only its disposable fixtures. Run the ordinary suite, lint, TypeScript and production build separately. Passing CI is not evidence that the production migration, OIDC provider or Unraid deployment has been exercised.

## Stage B boundary

Explicit named families and membership isolation are a separate v1.0 release. Stage A does not infer families, apply `family-schema.sql` at runtime, enable its flag, change delegation rules or split wallets. The additive schema/scope types may be present as dormant code; the media test fixture explicitly applies that SQL only to its isolated database. Future activation requires a reviewed mapping and its own acceptance gate. A user's wallet remains global across all families; family origins must never duplicate historical coins. Future runtime grants must keep `family_configuration` and `global_wallet_totals` read-only, with narrowly reviewed DML for other family tables.
