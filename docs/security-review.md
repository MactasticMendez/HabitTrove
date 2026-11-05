# Security and repository privacy

## Current controls

Production account, family, settings and ledger data live in PostgreSQL. The runtime uses a restricted non-owner role; offline migration and restore credentials stay outside the application container. Startup checks actual roles, schema state and initialized accounts and fails closed on database errors. JSON storage is limited to development, tests and demo mode.

Sessions carry the authenticated credential version. Identity and permission changes invalidate older sessions, and sensitive writes recheck current authority inside their transaction. Local passwords use salted derivation with bounded asynchronous verification and shared throttling. Known accounts can still be targeted for temporary public-login lockout; use a trusted ingress abuse control and retain local administrator recovery.

OIDC uses discovery, PKCE, state and nonce. Accounts bind both subject and issuer. Self-linking requires a short-lived signed intent, the current local password and a matching verified email. Email alone never links or authenticates an account. Administrator changes require a current local password; saved OIDC/SMTP secrets are encrypted using the external `AUTH_SECRET` and excluded from client responses.

Family operations resolve a fresh actor, active membership, resource permissions and directed manager assignments. PostgreSQL transaction-local context and forced row-level security reinforce those boundaries. Global site administration does not grant implicit family oversight. Invitation acceptance binds the offered email, family and role, rechecks authority and consumes a hashed token transactionally.

SQL values are parameterized. Protected avatars and completion evidence require authorized routes, bounded image types and private response headers. Upload and backup paths reject traversal and symlinks. Backups capture consistent state and assets, verify checksums, and publish owner-only archives only after successful completion. Complete family recovery uses the version 2 raw format and a separate offline identity against an empty prepared target. Keep `AUTH_SECRET` separately; losing it prevents decryption of saved provider/mail credentials.

## OIDC upgrade

All provider configuration now uses `OIDC_*` and `/api/auth/callback/oidc`. Provider-specific aliases are removed. Register the callback and preserve the current issuer/client before restarting. Existing PostgreSQL links are read from `oidc_identities` independently of older field-presence metadata. Begin in-flight link requests again after upgrading.

Private JSON snapshots imported from older releases must use `oidcSubject` for external subjects and retain `oidcIssuer`. Convert a private copy and regenerate its migration manifest; do not edit an archive covered by an existing checksum. See [database operations](database.md) and [OIDC setup](../README.md#oidc-sign-in). Keep a local administrator recovery password throughout.

## Repository privacy checks

Use fictional test identities, reserved example email domains and documentation addresses. Generate integration credentials at runtime. Do not commit real account exports, password hashes, invitation links, personal hostnames, credentials or infrastructure inventories. Package integrity hashes, public asset identifiers, loopback/bind addresses and synthetic cryptographic test vectors have legitimate uses and are not credentials.

Run `npm run check:privacy` before publishing. It inspects the tracked working tree and reports paths/reasons without printing matched values. CI also runs this check. It rejects private contact/address literals, recognized credential formats and runtime artifacts; it is a regression guard, not a complete secret detector. Review entropy-based scanner results in context and never try discovered credentials against a service.

Git ignores and Docker exclusions protect local environment files, credential files, database dumps, backups and generated output. Ignore rules do not remove files already committed. Changes to the latest tree do not erase earlier commits, branch tips, tags, pull-request diffs, Actions logs/artifacts, releases, cached objects or clones. Review these separately before claiming a published repository is free of personal data. History rewriting and credential rotation are separate actions; deletion alone never revokes a credential.

## Review limits

The current cleanup includes offline source review, tracked-content privacy searches and a separate reachable-history secret scan. It does not establish live credential validity, production identity-provider behavior, hosted artifact privacy or whole-application accessibility conformance. Detailed local results and remaining actions are reported with the cleanup rather than embedding private scan output in Git.

The dependency advisory check on 2026-11-05 reported no production advisories and six moderate development-only rows from the lint toolchain, all cascading from [the minimatch amplification advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249). A compatible lint-toolchain update remains outstanding; no broad dependency or major-version override was applied.

Retain these operational assumptions:

* Treat the administrator-configured OIDC issuer and SMTP host as trusted infrastructure. The application contacts them with configured credentials.
* Use HTTPS and verified remote database TLS. Limit access to logs, protected volumes, backups and offline manifests.
* Habit completion is self-reported. Database consistency cannot establish real-world activity.
* JSON development storage supports one process per directory; it does not provide production concurrency guarantees.
* Review permissions on files created by older releases. Current owner-only creation does not repair old files.
* UI labels, focus behavior and semantics must remain accessible; automated axe checks cover selected rendered states, not every workflow or assistive technology.
