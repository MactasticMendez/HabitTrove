# PostgreSQL operations

Version 0.9.0 (Stage A) changed persistence without changing existing product access. Version 1.0.0 (Stage B) adds explicit families through a separate preparation, mapping and activation gate; upgrading or starting the app does not enable them. PostgreSQL is the only authoritative production store for accounts/password hashes, OIDC bindings, invitations, permissions, manager assignments, habits/tasks, approvals, rewards, coin history, settings, encrypted administrator configuration, authentication throttles, job leases and attachment metadata. Binary avatar/evidence files remain in the protected `data` mount. IDs, event order, legacy/null/voided records and finite fractional coin values are preserved; import does not recalculate rewards.

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

An operator may additionally restrict a dedicated login to this database using deny-only PostgreSQL 17 HBA records placed before existing rules. For example, substitute the exact reviewed application login for `habittrove_runtime`:

```conf
local /^(?!habittrove$).*$,replication "habittrove_runtime" reject
host /^(?!habittrove$).*$,replication "habittrove_runtime" all reject
```

These reject other database names and physical replication while own-database connections still use the original authentication/network rules. Add no broad allow, preserve the original file/metadata and includes, require zero `pg_hba_file_rules` errors before reload, and verify fresh own/other/admin connections afterwards. HBA governs new connections; it does not remove inherited database/object privileges or replace role hardening and review of existing sessions. See the [PostgreSQL 17 HBA reference](https://www.postgresql.org/docs/17/auth-pg-hba-conf.html).

Store credentials outside Git in a restricted secret location. Runtime gets `DATABASE_URL` only; `DATABASE_MIGRATION_URL` is for an offline provisioning shell and must not be installed in the regular application container. The CLI checks that migration and runtime URLs target the same host, port and database. URLs accept only validated TLS options (`sslmode=verify-full`, optionally `sslrootcert`); do not use URL options to override roles, targets or timeouts. Use verified TLS on remote/untrusted networks. A trusted existing private host/container endpoint may use its approved local transport.

## Build the offline commands

From the checkout, install locked dependencies and build the Node bundles:

```bash
npm ci --ignore-scripts --force --no-audit --no-fund
npm run build:database
```

The production image also includes `scripts/database.mjs`, the built database/recovery bundles and SQL. CLI dependencies are bundled; PostgreSQL's `pg` driver uses the existing server runtime dependency. The final image build imports both CLI bundles without network, data or credentials so missing runtime dependencies stop the build. Bun is needed for tests, not production recovery. Run commands from a working directory whose `data` subdirectory is the final protected asset directory. Supply environment variables privately; never paste connection URLs into tickets or logs.

| Command | Effect |
| --- | --- |
| `node scripts/database.mjs migrate` | Offline schema creation/version validation using the migration connection |
| `node scripts/database.mjs init` | Initialize an empty, migrated database for a new installation |
| `node scripts/database.mjs dry-run SOURCE --manifest PRIVATE_MANIFEST` | Validate unchanged legacy files/assets and write a new private manifest outside the source; no database needed |
| `node scripts/database.mjs import SOURCE` | Import into an empty migrated target; identical replay verifies, different/nonempty target is rejected |
| `node scripts/database.mjs verify SOURCE` | Compare the database snapshot and protected assets with the validated source |
| `node scripts/database.mjs export NEW_DIRECTORY` | Export v1 before preparation; automatically export v2 when families are enabled. During preparation use `export-family` explicitly |
| `node scripts/database.mjs restore SNAPSHOT_DIRECTORY` | Verify the saved checksum manifest and import into an empty migrated target |

`SOURCE` contains `auth.json`, `habits.json`, `wishlist.json`, `coins.json`, `settings.json`, optional `admin-config.json`, and the protected asset directories. Dry-run rejects identity collisions, malformed history, unsafe numbers, missing/tampered assets, symlinks and unsafe paths. Its console report contains aggregate counts/digest; the private manifest contains account IDs, ledger totals and hashes. Export destinations must not exist; commands never overwrite rollback evidence.

External identities in JSON snapshots use `oidcSubject` and `oidcIssuer`. Before importing a snapshot from v1.0.2 or earlier, rename its external subject field in a private copy while retaining the exact subject and issuer; regenerate the migration manifest after conversion. Unsupported subject fields are rejected to prevent silent identity loss. Existing PostgreSQL `oidc_identities` rows and complete raw recovery backups retain their subject/issuer values without conversion. Configure `OIDC_*` and register `/api/auth/callback/oidc` before upgrading provider-specific deployments; keep local administrator recovery available.

Older settings can omit properties introduced by newer versions. Loading fills those omissions from the existing defaults without rewriting stored preferences; supplied values remain authoritative. PostgreSQL reads reject malformed settings sections. This also applies after family activation.

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

The v1 recovery path below applies to an unprepared Stage A database. After any family preparation, use the [complete v2 backup/restore procedure](#complete-family-backup-and-restore), including while activation is still disabled.

Application backups read a consistent database snapshot, copy required protected assets and include `manifest.json`; they do not archive stale JSON as authoritative data. Asset capture and cleanup share the database write lock. A shared database lease prevents duplicate scheduled backups. Archives publish only after completion, retain seven backups and fail if captured assets exceed the 512 MiB memory budget. The limit is an operational ceiling; monitor backup success and plan a reviewed streaming path before assets grow beyond it.

Backups contain sensitive credential hashes and encrypted secrets. Restrict archive/destination access. Preserve `AUTH_SECRET`, database connection/provisioning details and the prior application image separately; downloadable archives deliberately omit the external decryption key. A database-only `pg_dump` of **only** `habittrove` is an additional recovery path, not a replacement for asset capture or a license to restore globals/other databases.

For a restore drill, extract the private app snapshot into a new protected directory; provision/migrate a fresh isolated target, place the verified assets under its working directory's `data`, then run `restore SNAPSHOT_DIRECTORY` and `verify SNAPSHOT_DIRECTORY`. The saved manifest is mandatory for `restore`. Start the matching app with the original `AUTH_SECRET` and verify local login, provider-secret decryption, balances, event history and evidence. A successful file extraction or CLI status alone is not end-to-end recovery proof.

Before new PostgreSQL writes, rollback can restore the saved image, original files and environment. After new writes, stop writes and create a current verified `export NEW_DIRECTORY`; restore/reconcile that reverse export with the previous version and test it before switching traffic. Never point the old image at stale pre-cutover JSON and discard accepted database writes. Keep rollback assets and the previous image until acceptance is complete.

Password recovery uses `node scripts/set-local-password.mjs USERNAME` with the new password on stdin and the restricted runtime connection. Stop the app first, keep a complete backup and retain the script's owner-only prior credential snapshot. It preserves account IDs and OIDC links, updates the database password and invalidates sessions; editing `auth.json` no longer changes production accounts. See the README for the Compose recovery invocation.

## Isolated database tests

The PR workflow starts PostgreSQL 17.11 on `127.0.0.1:15432` with generated ephemeral administrator credentials and temporary storage. `node scripts/test-database.mjs` builds the Node CLI, creates a separate restricted runtime login and eighteen dedicated scratch databases, then runs Stage A repositories/import/recovery/init/auth/actions/media plus family repositories, membership/actions/startup, separate media-maintenance, complete v2 backup/restore, fresh-family activation, quoted generic runtime-role and invitation-password concurrency suites in separate Bun processes. The runner refuses existing names/roles and never drops a database or modifies production. Its administrator URL must target exactly `127.0.0.1:15432/postgres`, and `HABITTROVE_TEST_DATABASE=1` is required.

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

## Explicit family activation

Stop application writes, including login attempts and scheduled jobs, and preserve a verified pre-upgrade snapshot, assets, environment, external `AUTH_SECRET` and previous image. Rehearse the entire mapping and restore procedure on a disposable copy first. Preparation is additive; activation changes visibility and must be accepted separately.

| Offline command | Contract |
| --- | --- |
| `node scripts/database.mjs prepare-family` | Prepare schema v2 using a separate same-target `DATABASE_MIGRATION_URL`; leave families disabled |
| `node scripts/database.mjs create-family FAMILY_FILE` | Create a named family from `{ "name": "Example household", "ownerId": "EXISTING_ACCOUNT_ID" }`; omitted `ownerId` uses the operational site administrator |
| `node scripts/database.mjs preview-family-mapping MAPPING_FILE` | Return the source hash, counts and retained/discarded legacy manager assignments for review |
| `node scripts/database.mjs apply-family-mapping MAPPING_FILE` | Require that preview hash as `expectedSourceHash` in the same reviewed mapping JSON; assign records atomically |
| `node scripts/database.mjs preview-family-activation` | Report blocking issue counts, `canActivate` and an activation `sourceHash` |
| `node scripts/database.mjs activate-family --expected-source-hash REVIEWED_HASH` | Recheck the exact source and complete mapping, then explicitly enable families |

`FAMILY_FILE` and `MAPPING_FILE` are private operator JSON files, not repository configuration. Protect them and CLI outputs: they contain real account/item IDs and relationship decisions. Commands use the existing site administrator operational scope; they do not accept a browser-supplied actor or create an unrestricted new administrator.

1. Run `prepare-family` with runtime and separate migration credentials targeting the same dedicated database. Verify v2 ownership/grants and keep the migration URL out of the regular container. No memberships or household mapping are guessed.
2. Create each agreed named family with an explicitly reviewed existing owner. Family ownership is distinct from site administration; the chosen owner does not gain OIDC, SMTP, global-account deletion or infrastructure rights. A site administrator may create additional families later; unrestricted self-service creation is not enabled.
3. Prepare an explicit mapping file for each family. The shape is:

```json
{
  "familyId": "CREATED_FAMILY_ID",
  "userIds": ["EXISTING_OWNER_ID", "EXISTING_MEMBER_ID"],
  "habitIds": ["EXISTING_HABIT_OR_TASK_ID"],
  "wishlistIds": ["EXISTING_REWARD_ID"],
  "ledgerIds": ["EXISTING_TRANSACTION_ID"],
  "managers": [{ "managerId": "EXISTING_OWNER_ID", "memberId": "EXISTING_MEMBER_ID" }]
}
```

4. Run `preview-family-mapping` and review every selected identity, item, transaction and directed manager link. All active assignees/approvers must be explicitly included. Review the reported legacy assignments that will be discarded as well as retained ones. Add the returned `sourceHash` to that JSON as `expectedSourceHash`, then run `apply-family-mapping`. A source change requires a fresh preview; do not reuse a stale hash or copy relationships from an unrelated family.
5. Repeat for all records. Historical/deleted actors and transaction origins need explicit decisions; never duplicate items or coins to resolve ambiguity. Mapping preserves ledger amounts/IDs and copies selected preferences/calendar settings without issuing new rewards. The owner/member/manager relationships must be deliberately agreed, not inferred from the old global manager list.
6. Run `preview-family-activation`. Resolve every nonzero issue: unmapped domain/evidence rows, unclaimed ledger owners, legacy unbound invitations, missing owners/settings/permissions/revisions, inactive assignees or unreviewed delegations block activation. Revoke/resolve legacy invitations through a reviewed account-preserving process; do not convert them into guessed household invitations. Retain the reviewed output privately.
7. With writes still stopped, pass that preview's exact hash to `activate-family --expected-source-hash HASH`. Any source drift causes rejection. Confirm the activation flag, runtime privileges and fresh login/selector behavior, then test each account's intended membership, cross-family denial, rewards/undo and evidence before accepting the change. No ordinary startup step applies or activates families.

For a genuinely new empty installation only: migrate v1, explicitly `init` the single administrator, then `prepare-family`. Use `preview-family-activation --allow-empty` and `activate-family --allow-empty --expected-source-hash HASH` with the hash from that same empty preview. This exception requires exactly one administrator, no family and no habits/rewards/ledger/attachments. It does not bypass an existing installation's mapping. Afterwards create the first family through the operator command or site-admin Family page, then invite members. `--allow-empty` is rejected by unrelated commands.

### Runtime family privileges

Keep existing core DML grants. Add narrow DML for `families`, `family_memberships`, `family_manager_assignments`, `family_permissions`, `family_preferences`, `family_settings`, `family_document_revisions`, `household_invitations`, `family_audit` and `family_legacy_adoptions`. Grant `SELECT` only on `family_configuration` and `global_wallet_totals`; grant only `USAGE` on sequence `coin_ledger_family_order`, without `SELECT` or `UPDATE`. `prepare-family` installs these version-specific grants. Runtime must still own no application objects, have no bypass/elevated memberships and receive no schema creation, truncation or offline restore authority. Identity writes always recheck the verified actor version inside their PostgreSQL transaction, including before family activation. Startup and offline preparation inspect privileges reachable through role memberships too; NOINHERIT does not make an unsafe parent role acceptable.

Family-owned domain tables use forced row-level security with fresh transaction-local actor/family context on the same pooled connection. The selector is not authorization. Missing or revoked context fails closed; a stale explicit selection does not silently switch the action to another household. Site administrators retain explicitly scoped recovery access. RLS supplements application checks; it does not claim to contain arbitrary SQL injection or replace the shared-server privilege review.

## Family access and global wallets

Owners rename a family, invite members/managers and confirm membership/role/delegation changes. Managers oversee only explicitly assigned members. Ownership alone does not grant every member's habits or wallet history; an owner can intentionally assign themselves or another eligible manager, which membership settings explain. Member permissions and item assignments still govern ordinary actions. The final active owner cannot be removed/demoted.

Invitations bind one family, canonical email, stored member/manager offer and optional manager assignment. Tokens are hashed, one-use and expire after seven days. New accounts use the protected local-account acceptance flow; existing accounts sign in and explicitly accept with the matching email. The stored offer controls membership, not client-submitted family/role values. New-account acceptance preflights a usable offer before password derivation, uses bounded asynchronous credential work under a shared cross-worker budget, and rechecks acceptance atomically before creating the account. Invalid offers do not allocate persistent password-attempt rows. Passwords and OIDC links of existing accounts are never replaced by acceptance.

A user has one global wallet across all families. Credits/debits retain their family origin; authorized rewards may spend the combined available balance. An assigned manager can see the member's aggregate balance for redemption without private items or detailed transactions from other families. A user retains their own global ledger, coins and debt after leaving every family. Ordinary wallet loads, mutations and notes consistently return the signed-in account's wallet, including for site administrators; another member's rewards use the authorized Family flow. Undo reverses the original award even after spending; a negative balance blocks new redemption. No historical reward is recalculated, copied or redistributed during mapping, joining or removal.

Removal uses a current impact preview and atomically deactivates membership/delegations. Items without remaining active assignees are archived; affected pending submissions are withdrawn without awarding coins and retain replay/evidence tombstones. Sole approvers receive the reviewed fallback and affected work is flagged for review. The global login is retained. Rejoining keeps history/preferences but does not silently restore old delegations or unarchive work.

Timezone/week start belong to the selected family; language and display preferences remain personal. Switching families discards previous-family state and reloads the selected family. An account without membership can still read its own wallet/history; a stale/revoked selection presents recovery through the available family selector, and domain writes require a valid selection. Site-wide OIDC, SMTP, backups and global identity administration stay separate from family ownership. A site administrator can use the separately authorized global account list without being a family member; the family directory and ordinary member searches remain scoped. Member-specific administrator forms require an explicitly chosen recipient when the administrator is outside the selected family; they never silently choose the first listed member. Client public-user data carries a sanitized optional `currentUser` when the signed-in account is absent from that scoped list, keeping identity/personal controls available without adding that account to the family directory.

## Complete family backup and restore

After schema preparation, scheduled backups use version 2 even while families are disabled. Use `export-family` explicitly for operator snapshots of a prepared installation: generic `export` switches automatically only after activation. A selected-family DTO or v1 export is not a complete installation backup.

V2 contains allowlisted raw rows in `family-database.json`, `manifest.json` and retained protected avatar/evidence assets. It preserves every family, active/inactive membership, invitations, permissions, preferences/calendar settings, adoption/audit/replay history, exact numeric ledger values, global wallet totals and configuration/identity ciphertext. Retained files for inaccessible evidence can remain in the private operator backup until cleanup. Their metadata remains inaccessible after restore; retaining bytes does not grant delivery access. Snapshot/asset capture uses operational scope under the shared transaction/capture lock without an HTTP session; ordinary runtime grants are not broadened. Asset/file limits and owner-only handling remain in force. Preserve `AUTH_SECRET` separately; the archive does not contain that decryption key.

| Offline command | Contract |
| --- | --- |
| `node scripts/database.mjs export-family NEW_DIRECTORY` | Capture and verify a new complete private v2 snapshot; refuse an existing destination |
| `node scripts/database.mjs dry-run-family SNAPSHOT_DIRECTORY` | Validate raw payload, manifest and assets without any database credentials; report aggregate counts/digest |
| `node scripts/database.mjs verify-family SNAPSHOT_DIRECTORY` | Compare the complete raw database and protected assets using operational scope |
| `node scripts/database.mjs restore-family SNAPSHOT_DIRECTORY` | Restore only into an empty, prepared, disabled v2 target, using a separate same-target migration identity |

For a restore drill:

1. Extract the private archive into a new protected directory and run `dry-run-family` with no database credentials. Keep the snapshot/manifest unchanged; tampering or missing assets must fail.
2. Provision a new dedicated isolated target; apply the v1 schema then `prepare-family` with its restricted runtime and separate migration URLs. Do **not** run `init`: the target must have no users/domain rows and only the default disabled configuration row.
3. Place the required verified assets under the restore application's working directory `data/avatars` and `data/evidence`. Restore validates these bytes and never overwrites the asset volume. Keep the source archive separate.
4. Run `restore-family SNAPSHOT_DIRECTORY` from that application working directory. The operator URL is mandatory and must use a different identity from runtime. Restore checks the exact schema and inserts fixed typed columns in dependency order. Referential, membership, origin and wallet checks remain active; only the completion review-projection trigger is suspended inside the transaction. Restore reconciles the global wallet projection and resets ledger ordering transactionally. Failed/incomplete restore rolls back; a populated target is rejected.
5. Run `verify-family`, then start a matching v2 application with runtime credentials only and the original `AUTH_SECRET`. Verify local login/provider-secret recovery, both families, role/delegation boundaries, global balances including removed users/debt, history and evidence. Confirm restart persistence before calling recovery accepted.

A prepared/enabled v2 database is not a supported downgrade to the v0.9 image or old JSON. Before any new accepted writes, a reviewed pre-upgrade restore may be used. After writes, preserve a current complete v2 snapshot and recover with a compatible application; there is no automatic flattening of families into legacy JSON. Keep the prior image and all snapshots until the release-specific acceptance gate passes.
