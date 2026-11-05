# Changelog

## Unreleased

## Version 1.0.0

### Added

* Add named families, an explicit family selector, owner/manager/member roles, directed manager assignments and confirmed membership changes/removal previews.
* Add family-bound invitations for new and existing accounts, with email-matched explicit acceptance and no credential replacement.
* Add offline family schema preparation, reviewed legacy mapping and hash-bound activation, plus complete version 2 backup/export/verification and empty-target restore.
* Extend isolated restricted-role PostgreSQL CI coverage to family repositories, actions, startup, media maintenance, activation and full backup/recovery.

### Changed

* Scope items, approvals, member searches, evidence and calendar settings to the selected family; preserve personal display/language preferences and clear prior-family client data on switching.
* Preserve the signed-in account and personal settings independently of family member lists; keep global administrator account management available to administrators without family membership.
* Keep one global wallet per account across families. Leaving retains coins/history/debt; authorized redemption uses the combined balance, and undo can restore a negative balance without permitting further spending.
* Use complete raw family snapshots for scheduled backups after schema preparation, preserving pending mappings, inaccessible evidence metadata and retained protected assets.

### Fixed

* Keep personal settings/language and the signed-in wallet consistent without a selected family, including site-administrator loads, coin changes and notes.
* Resolve protected media through the same authorized family selection while preserving access to the account's own global avatar.
* Require an explicit recipient for member-specific administrator forms when the administrator is not a family member; use Family management for another member's wallet.
* Give loaded avatar images appropriate alternative text while avoiding duplicate names in account and selection controls.
* Keep habit schedule captions, archived items and empty-state descriptions readable in light and dark themes while retaining a visible archive cue.
* Keep empty and archived lists within their mobile grid and wrap habit actions and filters on narrow screens.
* Retain archived any-time and negative-habit history after removing its sole assignee without blocking unrelated habit edits.
* Allow site administrators outside a family's membership to record and undo authorized manager-policy actions while preserving member-only policies and legacy permission checks.

### Security

* Recheck actor, membership and directed oversight inside each transaction, with forced row-level security, scoped revisions and no permissive fallback for missing/revoked family context.
* Require explicit reviewed mapping and activation hashes; keep configuration/wallet summaries read-only for runtime and restore privileges isolated to the offline operator identity.
* Reject unsafe runtime privileges reachable through role memberships, including NOINHERIT custom roles.
* Preflight invitations before bounded asynchronous password derivation, share credential-work/attempt limits across workers and recheck acceptance before committing a new account.
* Carry the verified session version through identity lookup and fence all PostgreSQL identity writes against it, including before family activation; recheck credential state before committing password changes.


## Version 0.9.0

### Added

* Add offline PostgreSQL schema, fresh-install initialization, legacy import/verification, checksum manifests, reverse export and empty-target restore commands.
* Add isolated PostgreSQL 17.11 CI coverage using a restricted runtime role and separate migration credentials, plus an optional disposable local test profile.

### Changed

* Make PostgreSQL authoritative for production accounts, settings, habits, approvals, rewards, coin history and protected-asset metadata while keeping binary assets in the existing volume.
* Preserve legacy IDs, password hashes, identity links, event ordering, fractional coins and encrypted administrator settings through normalized tables with JSONB for flexible fields.
* Capture database snapshots, protected assets and manifests in backups; document the separate recovery key, restore drills and verified reverse-export rollback after new writes.

### Fixed

* Refresh reward revisions after redemption so the next edit can be saved without reloading the page.
* Keep wallet notes and their edit revision in the same database snapshot so concurrent edits cannot overwrite newer notes.
* Preserve backup/export consistency for evidence recorded on another member's behalf and administrator-assigned avatars; retain transferred avatars when their original uploader is deleted.
* Name notification, mobile view, reward-menu and coin controls, correct notification semantics and improve dashboard contrast for screen reader and low-vision access.
* Restore the numeric remaining-use count on limited rewards.

### Security

* Move related authorization/business writes, authentication throttles and scheduled-backup ownership into shared database transactions/leases; fail closed when storage is unavailable.
* Validate the actual restricted non-owner runtime identity, bound database pools/timeouts, isolate offline DDL credentials and verify protected asset hashes/paths. Production never falls back to writable JSON.
* Recheck administrator authority, credentials and provider-account constraints inside the same transaction as administrator settings changes.

Stage A retains existing access/delegation behavior. Explicit family membership and activation remain a separate release; dormant family helpers are not enabled by this migration.

## Version 0.8.0

### Added

* Add guided custom calendar intervals, monthly dates/nth weekdays, yearly dates and schedule start/end dates; add repeat intervals measured from an approved completion ([upstream #143](https://github.com/dohsimpson/HabitTrove/issues/143), [#116](https://github.com/dohsimpson/HabitTrove/issues/116)).
* Add any-time habits with one assignee, creator-selected member/manager/both recording permissions, independent per-action rewards, optional approval and evidence ([upstream discussion #158](https://github.com/dohsimpson/HabitTrove/discussions/158)).
* Add a Family overview with scoped member progress, balances, status, pending approvals, item management and confirmed reward redemption from the selected member's balance ([upstream #95](https://github.com/dohsimpson/HabitTrove/issues/95)).

* Add personal folders for habits and tasks, with a folder or flat-list view ([upstream #118](https://github.com/dohsimpson/HabitTrove/issues/118), [#120](https://github.com/dohsimpson/HabitTrove/issues/120)).
* Add one-use family invitations, configurable SMTP delivery in the Admin panel, and designated managers for assigned members' habits and rewards ([upstream #95](https://github.com/dohsimpson/HabitTrove/issues/95)).
* Add negative habits with optional coins for avoided days and optional balance-capped penalties for recorded slips ([upstream #153](https://github.com/dohsimpson/HabitTrove/issues/153)).
* Add personal sick, travel, rest, and other status dates that pause streaks without creating completions or coins ([upstream #28](https://github.com/dohsimpson/HabitTrove/issues/28)).

### Fixed

* Keep the family reward editor responsive and synchronize its related app data after a family action.
* Restore mocked clocks after scheduling tests and remove a millisecond-boundary race so the full suite remains isolated and deterministic.

* Restore the task and habit editor layout, stack fields on narrow screens, and keep controls inside the dialog. Add descriptive names to completion and reward stepper buttons.

* Allow an administrator to designate their own account as the family manager when inviting a member, and clarify that administrator access remains available when no manager is chosen.
* Keep the npm lockfile compatible with the Node 22 Docker build and GitHub Actions.
* Place the OIDC sign-in button name save action below its field and help text.

### Security

* Make any-time and family-redemption requests idempotent, retain undo replay protection, and enforce the selected beneficiary and current manager scope on the server.
* Keep withdrawn evidence inaccessible even if its file cleanup fails; preserve creator control and pending-approval locks when editing schedules and recording permissions.
* Bound recurrence intervals and occurrence counts; preserve unchanged legacy schedules while unsafe rules fail closed during evaluation.

* Store only hashes of invitation tokens, expire them after seven days, and consume each token once.
* Encrypt SMTP passwords at rest, require an administrator's local password to edit SMTP settings, and limit manager edits to their assigned family members.

## Version 0.7.0

### Added

* Let administrators set the OIDC sign-in button name without changing provider configuration.

### Changed

* Arrange dashboard tiles in fluid columns so tall tiles do not leave empty grid rows.

### Fixed

* Keep compact task and habit columns and action buttons aligned when Undo appears after a completion.
* Give habit action menus an accessible name and improve the manual-order hint contrast.

## Version 0.6.1

### Fixed

* Synchronize the npm lockfile with the Docker image's npm version so clean image builds succeed.

## Version 0.6.0

### Added

* Add recurring tasks with optional occurrence goals, missed-date catch-up, and task checklists ([upstream #55](https://github.com/dohsimpson/HabitTrove/issues/55), [#115](https://github.com/dohsimpson/HabitTrove/issues/115), [#122](https://github.com/dohsimpson/HabitTrove/issues/122)).
* Add per-habit streaks with a one-occurrence grace period, configured-week progress, and achievement badges ([upstream #65](https://github.com/dohsimpson/HabitTrove/issues/65), [#25](https://github.com/dohsimpson/HabitTrove/issues/25), [#10](https://github.com/dohsimpson/HabitTrove/issues/10)).
* Add dashboard section ordering and a Daily only filter for the dashboard and item list ([upstream #71](https://github.com/dohsimpson/HabitTrove/issues/71), [#79](https://github.com/dohsimpson/HabitTrove/issues/79)).
* Add optional per-item time reminders with browser-local controls and temporary 2× or 3× coin boosts ([upstream #123](https://github.com/dohsimpson/HabitTrove/issues/123), [#80](https://github.com/dohsimpson/HabitTrove/issues/80)).
* Add creator-configured completion approval with multiple username-selected approvers, optional photo evidence, and an Approvals screen ([upstream #185](https://github.com/dohsimpson/HabitTrove/issues/185)).

### Changed

* Hold coins until a required completion is approved; a listed approver may approve their own submission. Existing completion and coin history is retained.

### Fixed

* Keep rejected submissions out of completion counts and permit a corrected resubmission.
* Improve approval form screen reader references and approval queue text contrast.
* Make avatar route tests use isolated temporary files so the full Bun suite remains stable across test orderings.
* Count completed scheduled dates toward recurring task goals, and keep one-off tasks overdue beyond a year.
* Reverse an approval reward if undoing a later check-in drops the approved count below the target, while preserving awards made under an earlier target.
* Keep completed archived tasks in calendar history and allow unrelated edits after a temporary boost expires.
* Reassign approval to the creator or a remaining administrator when the last named approver is deleted; reject a deleted completer's pending submissions.

### Security

* Restrict evidence viewing to the completing user, item creator, and designated approvers; store uploads as size-limited, metadata-free WebP files.
* Restrict approval-setting edits to the recorded creator or an administrator and serialize approval rewards with other coin changes.
* Limit approval responses to the submission outcome for designated approvers who are not assigned to the item.
* Remove a deleted account's completion evidence and reject its unreviewable pending submissions.

## Version 0.5.0

### Added

* Add a current completion streak, a keyboard-readable 12-week activity calendar, and explicit dates in chart tooltips ([upstream #111](https://github.com/dohsimpson/HabitTrove/issues/111), [#112](https://github.com/dohsimpson/HabitTrove/issues/112), [#113](https://github.com/dohsimpson/HabitTrove/issues/113)).
* Add a reward-redemption filter to the existing coin transaction ledger ([upstream #121](https://github.com/dohsimpson/HabitTrove/issues/121)).

### Changed

* Remove the link to the upstream demo from this fork's README because it does not show the fork's changes.

### Fixed

* Refresh dashboard activity statistics at midnight in the configured timezone and show chart series labels correctly in every supported language.

## Version 0.4.0

### Added

* Add repeat-schedule choices, weekday buttons, an inline schedule guide, and a task date picker ([upstream #116](https://github.com/dohsimpson/HabitTrove/issues/116), [#117](https://github.com/dohsimpson/HabitTrove/issues/117), [#114](https://github.com/dohsimpson/HabitTrove/issues/114)).
* Add saved manual ordering with drag and keyboard-accessible move buttons, compact habit/task cards, and a combined Today view ([upstream #164](https://github.com/dohsimpson/HabitTrove/issues/164), [#70](https://github.com/dohsimpson/HabitTrove/issues/70), [#119](https://github.com/dohsimpson/HabitTrove/issues/119)).

### Changed

* Anchor every-other-day habits to their saved start day, including across daylight saving changes.

### Fixed

* Interpret typed ISO task dates in the configured timezone without shifting the selected day.
* Improve mobile navigation hover text contrast found during the new view's accessibility check.
* Give the shared emoji picker an accessible name and remove a dangling dialog description reference.

## Version 0.3.1

### Changed

* Award future shared-habit coins only to the member who records the target-reaching completion. Existing awards and their undo history remain unchanged.

## Version 0.3.0

### Added

* Record the member who adds each new habit completion and the members rewarded when its daily target is reached.
* Add an administrator tab in Settings for generic OIDC setup and application log level.
* Support standard OIDC providers through in-app settings or `OIDC_*` environment variables, while retaining legacy Authentik configuration and linked accounts.
* Add local and OIDC sign-in, required account email, and a password-confirmed account-link flow for matching verified emails.
* Add a recovery script for assigning local passwords to legacy passwordless accounts.

### Changed

* Award shared habit coins to every assigned member at most once per local day and allow only the member who recorded the latest completion to undo it; administrators retain a recovery action.
* Move existing system settings into the administrator tab; apply log level changes immediately and OIDC changes after a restart.
* Require email for new accounts and first-use completion for existing accounts without one, while preserving account IDs and data.
* Show a dedicated sign-in screen to signed-out visitors.
* Build the fork's local image in the example Compose deployment.
* Show system settings only to administrators; existing account data remains unchanged until users complete email setup or an administrator assigns credentials.
* Declare the required emoji and linkification peer packages so production builds resolve.

### Fixed

* Keep a habit's pinned, task, and archive state when editing its other details ([upstream #109](https://github.com/dohsimpson/HabitTrove/issues/109)).
* Use the configured timezone for calendar day selection and refresh dashboard due items at local midnight ([upstream #13](https://github.com/dohsimpson/HabitTrove/issues/13), [#165](https://github.com/dohsimpson/HabitTrove/issues/165)).
* Guard mobile navigation's browser-only iOS detection during server rendering ([upstream #130](https://github.com/dohsimpson/HabitTrove/issues/130)).
* Restore OIDC sign-in for linked accounts by carrying the local account ID through Auth.js profile normalization.
* Update Linkify React to match LinkifyJS and prevent a client-side crash on the dashboard.
* Improve chart label contrast and give the profile menu an accessible name.
* Keep scheduled backups disabled when the backup setting is off, and fall back safely when old habit schedules or locale settings are malformed.
* Download Bun for CI from its official GitHub release when the Bun download endpoint returns 403.
* Make public assets readable by the non-root Docker user when the build source has restrictive permissions.

### Security

* Enforce shared completion ownership and reward reversal in server actions; block direct edits to completion history and managed coin rewards, including stale administrator saves.
* Bound concurrent local password verification and keep unknown usernames out of the account failure tracker; authenticated password confirmations have a separate 10-failure throttle from public sign-in.
* Reject malformed or oversized coin transaction text and new completions on already archived habits.
* Reject recurrence rules with more than 256 daily time combinations, including when evaluating older saved habits.
* Discard incomplete backup archives on Archiver warnings before publication or rotation, and remove generated avatars when an account is deleted.
* Use unique, owner-only files for concurrent data-directory permission checks.
* Block disabling OIDC while linked accounts lack local passwords, and fail closed if the saved OIDC configuration cannot be read.
* Require administrator access and current local-password proof for OIDC changes, encrypt the OIDC client secret in an owner-only file, and prevent issuer changes while linked accounts exist.
* Require a fresh client secret when changing the OIDC issuer or client ID.
* Bind OIDC account links to the issuer and reject a matching subject from a different provider; preserve legacy Authentik links for their original issuer.
* Pin the Docker build and runtime to Node.js 22.23.4 for CVE-2026-111497.
* Update Next.js, Auth.js, next-intl, and Zod to patched releases; refresh compatible locked dependencies.
* Require an initial administrator password for new non-demo installations, strengthen new passwords, enforce server-side account, item, coin, and settings permissions, and prevent replayed habit rewards.
* Require authentication for avatar uploads and freshness checks, protect account deletion from cross-origin requests, and remove unused push actions.
* Reject malformed data instead of silently replacing it, and compare password hashes in constant time.
* Block local sign-in for passwordless accounts, throttle failed local sign-ins, and invalidate sessions after credential, email, role, or Authentik-link changes.
* Require local-password proof and a matching verified Authentik email before linking accounts; use Authentik's subject for subsequent sign-ins.
* Update Archiver and node-cron, and replace Next.js's vulnerable nested PostCSS version with a patched release.
* Write JSON data atomically and serialize in-process mutations to prevent duplicate rewards and concurrent overspending.
* Restrict reward links to HTTP(S), isolate external popups, validate shared drawings, habit schedules, rewards, and settings, and bound retained avatar uploads.
* Enforce demo restrictions in server actions, require resource permissions for habit credits and wishlist redemption, and make redemption limits and task archive transitions server controlled.
* Restrict new data and backup files to their owner, hide other users' coin balances, and require an administrator to add the first local password to an Authentik-only account.
* Pin the demo deployment action to a fixed revision, publish only from upstream main, and validate release versions before shell use.

## Version 0.2.31

**This Release contains important security patches, please update as soon as possible**

### Fixed

* Security: Updated Next.js from 15.5.7 to 15.5.10
* Security: Hardened avatar route against path traversal attacks
* Security: Sanitized user data in client-facing payloads
* Security: Hardened debug actions and avatar validation
* Fixed missing English translations for DrawingModal

Thank you @1ARdotNO for the security audit!

## Version 0.2.30

### Fixed

* Security: Updated Next.js from 15.2.3 to 15.5.7 to address CVE-2025-55182 (https://github.com/vercel/next.js/security/advisories/GHSA-9qr9-h5gf-34mp)

## Version 0.2.29

### Added

* ✏️ Freehand drawing capability for habits and wishlist items

### Fixed

* Wishlist and Habit card layout - time and rewards sections now stay at bottom regardless of description length
* Wishlist card user avatars now appear on same row as title for consistency with habit cards

## Version 0.2.28

### Added

* Server permission checking system to validate data directory access on startup
* Permission error display with troubleshooting guidance and recheck functionality

## Version 0.2.27

### Fixed

* Mobile navigation text centering and sizing for multi-word translations

## Version 0.2.26

### Improved

* Docker build performance optimization with cache mounts

## Version 0.2.25

### Added

* 🌍 Added Catalan language support (Català)

### Fixed

* Translation files consistency: Added missing UserForm keys to English and Korean translations

## Version 0.2.24

### Added

* 🌍 Added Korean language support (한국어)

## Version 0.2.23

### Fixed

* floating number coin balance (#155)
* disable freshness check if browser does not support web crypto (#161)

### Improved

* use transparent background PWA icon with correct text (#103)
* display icon in logo

## Version 0.2.22

### Added

* auto check data freshness on interval (#138)
* warn about out-of-sync data

## Version 0.2.21

### Fixed

* emoji picker overlay issue (#150)

## Version 0.2.20

### Fixed

* coin balance shows correct value for selected user in coin management view (#151)

### Improved

* refactor code to remove client-helpers hook

## Version 0.2.19

### Fixed

* settings button not working
* fixed delete dialog modal blocks page interaction (#149)
* disable submit button when frequency is invaid

## Version 0.2.18

### Improved

* nicer loading UI (#147)
* header and navigation code refactor

## Version 0.2.17

### Fixed

* fix emoji selector (#142)
* fix about modal (#145)

## Version 0.2.16

### Improved

* move delete user button to user form
* disable deleting user on demo instance

## Version 0.2.15

### Improved

* max coins set to 9999, to prevent js large number precision issue (#137)

## Version 0.2.14

### Added

* support deleting user (#93)

## Version 0.2.13

### Fixed

* fix responsive design on mobile (#134)
* fix translation (#132)
* fix latest docker tag auto build (#131)

## Version 0.2.12

### Added

* 🌍 Added multi-language support! Users can now select their preferred language in settings.
* Supported languages: English, Español (Spanish), Deutsch (German), Français (French), Русский (Russian), 简体中文 (Simplified Chinese) and 日本語 (Japanese).

## Version 0.2.11

### Added

* support searching and sorting in habit list

### Improved

* Show overdue tasks in daily overview
* Context menu option for tasks changed from "Move to Today" to "Move to Tomorrow"
* More context menu items in daily overview
* code refactor for context menu and daily overview item section


## Version 0.2.10

### Improved

* performance optimization: faster load time for large data set

## Version 0.2.9

### Added

* Auto backup feature: Automatically backs up data
* Backup rotation: Keeps the last 7 daily backups
* Setting to enable/disable auto backup.

## Version 0.2.8

### Added

* notification for admin users on shared habit / wishlist completion (#92)

## Version 0.2.7

### Added

* visual pin indicators for pinned habits/tasks
* pin/unpin options in context menus
* support click and right-click context menu in dailyoverview

## Version 0.2.6

### Added

* support weekly / monthly intervals for recurring frequency (#99)
* show error when frequency is unsupported (#56)
* add task / habit button in habit view

### Fixed

* make user select modal scrollable

## Version 0.2.5

### Changed

* bumped Nextjs version (cve-2025-29927)

## Version 0.2.4

### Added

* admin can select user to view coins for that user

### Fixed

* fix disable password in demo instance (#74)

## Version 0.2.3

### Fixed

* gracefully handle invalid rrule (#76)
* fix long habit name overflow in daily (#75)
* disable password in demo instance (#74)

## Version 0.2.2

### Changed

* persist "show all" settings in browser (#72)

### Fixed

* nav bar spacing
* completion count badge

## Version 0.2.1

### Changed

* Added bottom padding for nav bar on iOS devices (#63)

## Version 0.2.0

### Added

* Multi-user support with permissions system
* Sharing habits and wishlist items with other users
* show both tasks and habits in dashboard (#58)
* show tasks in completion streak (#57)

### BREAKING CHANGE

* PLEASE BACK UP `data/` DIRECTORY BEFORE UPGRADE.
* Requires AUTH_SECRET environment variable for user authentication. Generate a secure secret with: `openssl rand -base64 32`
* Previous coin balance will be hidden. If this is undesirable, consider using manual adjustment to adjust coin balance after upgrade.

## Version 0.1.30

### Fixed

- fix responsive layout on mobile for habits and wishlist when has archived items

## Version 0.1.29

### Fixed

- actually working redeem link for wishlist items (#52)

## Version 0.1.28

### Added

- redeem link for wishlist items (#52)
- sound effect for habit / task completion (#53)

### Fixed

- fail habit create or edit if frequency is not set (#54)
- archive task when completed (#50)

## Version 0.1.27

### Added

- dark mode toggle (#48)
- notification badge for tasks (#51)

## Version 0.1.26

### Added

- archiving habits and wishlists (#44)
- wishlist item now supports redeem count (#36)

### Fixed

- pomodoro skip should update label

## Version 0.1.25

### Added

- added support for tasks (#41)

## Version 0.1.24

### Fixed

- completed habits atom should not store partially completed habits (#46)

## Version 0.1.23

### Added

- settings to adjust week start day for calendar (#45)

## Version 0.1.22

### Added

- start pomodoro from habit view
- complete past habit in calendar view (#32)

## Version 0.1.21

### Added

- auto cut github release for new version

## Version 0.1.20

### Changed

- improved UI for habits and wishlist on mobile

### Fixed

- fix pomodoro break timer from triggering completions
- don't show progress on pomodoro for single completion habit

## Version 0.1.19

### Added

- PWA support to allow installing app to mobile (#39)
- right click context menu for habits
- Pomodoro clock

### Fixed

- disable today's earned SSR (#38)

## Version 0.1.18

### Added

- flexible recurrence rule using natural language (#1)

### Fixed

- add modal state not cleared after adding habit (#34)
- daily overview habit count should not show target completions

### Improved

- habits and wishlist presentation in daily overview

## Version 0.1.17

### Added

- transactions note

### Fixed

- coin statistics

## Version 0.1.16

### Fixed

- fix performance

## Version 0.1.15

### Fixed

- fix responsive layout for header and coins page in small viewport

## Version 0.1.14

### Added

- show today earned coins in balance and header

## Version 0.1.13

### Added

- habits now support daily completion target (e.g. 7 cups of water)
- Added emoji picker for habit and wishlist names

### Changed

- habit completion now stores as ISO format

## Version 0.1.12

### Added

- show total coins in header
- pagination for coin transactions history

## Version 0.1.11

### Added

- profile button
- settings to update profile image

### Changed

- Move settings and about to under profile button

## Version 0.1.10

### Fixed

- fix navigation

## Version 0.1.9

### Fixed

- fix timezone for "today's transactions"

## Version 0.1.8

### Changed

- use jotai for all state management

## Version 0.1.7

### Fixed

- fixed settings unable to change

## Version 0.1.6

### Added

- make links clickable in habit, wishlist and calendar

## Version 0.1.5

### Added

- docker-compose.yaml
- timezone settings
- use jotai for state management

### Fixed

- completing habits now respect timezone settings
- coin and settings display now respect timezone settings
- performance improvements by caching settings

## Version 0.1.4

### Changed

- new effect when redeeming wishlist

## Version 0.1.3

### Fixed

- updated Dockerfile to include CHANGELOG

## Version 0.1.2

### Added

- About modal
  - display changelog and version info

### Changed

- show number of redeemable wishlist items on dashboard

## Version 0.1.1

### Added

- Settings:
  - added button to show settings
  - coin display settings
- Features:
  - Enabled calendar in large viewport

### Fixed

- format big coin number

## Version 0.1.0

### Added

- Features:
  - dashboard
  - habits
  - coins
  - wishlist
- Demo
- README
- License
