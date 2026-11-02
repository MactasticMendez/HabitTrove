# Changelog

## Unreleased

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
