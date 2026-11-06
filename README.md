# <img align="left" width="50" height="50" src="https://github.com/user-attachments/assets/99dcf223-3680-4b3a-8050-d9788f051682" /> HabitTrove

![cover](https://github.com/user-attachments/assets/b63e98b4-64ae-49c7-ae7e-21ef76c04a5a)

HabitTrove is a gamified habit tracking application that helps you build and maintain positive habits by rewarding you with coins, which you can use to exchange for rewards.

Also, try [TaskTrove](https://github.com/dohsimpson/TaskTrove):

<a href="https://github.com/dohsimpson/TaskTrove"><img width="3400" height="920" alt="tasktrove-banner" src="https://github.com/user-attachments/assets/ec728fba-7645-4169-b383-f760967840b9" /></a>


## Features

- 🎯 Create and track daily habits
- 📅 Choose repeat schedules and task dates from controls, with text entry for advanced schedules
- ↕️ Arrange habits and tasks manually, switch to compact cards, and combine today's due items
- 🏆 Earn coins for completing habits
- 💰 Create a wishlist of rewards to redeem with earned coins
- 📊 View your current completion streak, dated chart, and 12-week activity calendar
- ✏️ Add freehand drawings to habits and wishlist items for visual reminders
- 📅 Filter your coin history to see reward redemptions and their dates
- 🔁 Repeat tasks until a chosen completion goal, catch up missed dates, and track checklists
- ✅ Require named approvers for tasks or habits, with optional private photo evidence
- 🔔 Choose time reminders for items, with a browser-local on/off switch and lead time
- 📈 See each habit's streak and week progress, rearrange dashboard cards, and filter to daily items
- 📁 Organize your own habits and tasks in personal folders
- 👪 Switch between named families, invite new or existing accounts, and assign owners, managers and members
- 💰 Keep one personal wallet across families while keeping each family’s items and history private
- 🚫 Track avoided days and slips for negative habits, with optional rewards and penalties
- ⏸️ Mark status dates to pause streaks without earning coins
- 🏅 Earn achievement badges and set temporary 2× or 3× coin boosts
- 🌍 Multi-language support (English, Español, Català, Deutsch, Français, Русский, 简体中文, 한국어, 日本語)
- 🌙 Dark mode support
- 📲 Progressive Web App (PWA) support
- 💾 Automatic daily backups with rotation

## Usage

1. **Creating Habits**: Click the "Add Habit" button to create a new habit. Set a name, description, and coin reward. Choose daily, every other day, weekdays, or specific weekdays in the repeat menu. Choose **Custom interval and dates** for every N days/weeks/months/years, monthly dates or nth weekdays, yearly dates, and optional start/end dates. Choose **After completion** to schedule the next occurrence from the last approved target-reaching completion; overdue cycles remain one obligation. The text field remains available for other supported schedules; open Schedule help for examples. Every-other-day schedules begin on the day they are created or changed. A task's due date can be chosen in the calendar or entered as text.

2. **Tracking Habits**: Mark habits as complete on your dashboard. When a daily target is reached, the member who records that completion earns the habit's coin reward, at most once per local day. Only the member who recorded the latest completion can undo it. **Any time** habits have no daily reward limit; each recorded action rewards their single assigned member, subject to any required approval.

3. **Wishlist**: Add rewards to your wishlist that you can redeem with earned coins. The Coins page shows dated transactions and can filter to reward redemptions.

4. **Statistics**: View the current completion streak, a dated seven-day chart, and a 12-week activity calendar. A day counts when at least one habit or task reaches its daily completion target. Today's unfinished day does not break the streak. The calendar uses the timezone selected in Settings, and the dashboard advances to the next day when that timezone reaches midnight.

5. **Organizing**: Choose Manual order on the Habits or Tasks page to drag items or move them with the arrow buttons. Pinned items stay ahead of unpinned items. Manual positions are saved with the items and are visible to everyone who shares them; your chosen sort mode and compact view stay in this browser. On the dashboard, switch Today's Overview between separate sections and a combined list of due habits, due tasks, and overdue tasks.

6. **Recurring tasks and checklists**: Set a task's start date, repeat interval, and optional total number of completions. A recurring task stays open until that goal is reached. Use **Catch up** to record its oldest missed date within the past year. Checklist steps can be marked separately by assigned members; recurring task steps reset after an awarded completion. The main task is completed manually.

7. **Approval and evidence**: Turn on **Require approval** while creating or editing a task or habit, then choose one or more approvers from username suggestions. New items record their creator; only that creator or an administrator can change approval settings. For older items without a recorded creator, an administrator must change those settings. Approvers, including the completer if listed, review submissions at **Approvals**. Coins are awarded only after approval: to the recorder for scheduled items, or the assigned member for an any-time action recorded by their manager. Rejection permits resubmission. Photo evidence is optional; JPEG, PNG, and WebP uploads up to 2 MB are converted to metadata-free WebP and can be viewed only by the completer, creator, or designated approvers. Delete the item or withdraw the submission to remove its evidence file.

8. **Reminders, progress, and boosts**: Choose a reminder time per item. Turn pop-up reminders on in **Settings → Preferences** and select a lead time. The site must be open to show reminders; they are stored per browser and account. Habit cards show the current occurrence streak and progress for the configured week, with one missed occurrence allowed as a grace day. A recurring task goal counts scheduled dates that reach their completion target, rather than individual check-ins. Use the dashboard arrows to reorder sections and **Daily only** to hide less frequent items and any-time actions. This filter checks repeat intervals, including completion-relative schedules, and keeps one-off tasks visible; Today's Overview still shows only due or overdue tasks. Achievement badges use your coin transaction history. A temporary 2× or 3× boost applies only to eligible future completions until its selected end date; an approval submission keeps the reward amount calculated when it was submitted.

9. **Folders and families**: Folders belong to your account within the selected family. Use the family selector to switch households; switching reloads the page so the previous family's items do not remain on screen. A stale or revoked selection asks you to choose an available family instead of silently showing another. Site administrators create named families; family owners rename them, invite members and manage membership. Owner, manager and member are family roles, separate from the site administrator role. Owners and managers oversee only explicitly assigned members; ownership alone does not grant access to everyone's habits. Owners can deliberately assign themselves or another eligible manager, so review those assignments before confirming role changes.

   **Invitations and membership**: Owners or site administrators invite a member/manager into one named family, with an optional directed manager assignment. Invitations are email-bound, one-use and expire after seven days. A new user creates local credentials; an existing user signs in with the matching account email and explicitly accepts. Acceptance never replaces an existing password or OIDC link. Removing membership shows an impact preview, preserves the global account and wallet, withdraws affected pending submissions and archives items left without an active assignee. The final active owner cannot be removed or demoted. Rejoining preserves history and preferences but does not silently restore old delegations or archived items.

   **Wallet and calendar**: You have one wallet across all families. Rewards in an authorized family may spend its combined balance; each transaction retains its family origin. Managers see an assigned member's combined available balance for redemption, without unrelated-family ledger details. Leaving a family retains coins and debt. Undo reverses the original award even if it was already spent; a negative balance blocks further redemption. The Coins page remains your own wallet, including for site administrators; use Family management for an authorized member’s rewards. Without family membership or a valid selected family, your own wallet/history and personal display/language settings remain available. Household folders and status dates require active family membership. Your signed-in identity, display preferences and language remain personal; timezone and week start belong to the selected family. A site administrator can manage the global account list even without membership in the selected family; ordinary member searches remain family-scoped. **Family** shows scoped progress and management; choosing a member does not sign you in as that account.

10. **Negative habits and status dates**: Create a negative habit for one assigned member. Mark a day **Avoided** for the optional reward, or **Log slip** for an optional penalty capped at that member's available coins; undoing a slip refunds its recorded penalty. A day can have one outcome. In **Settings → Preferences**, add sick, travel, rest, or other dates to pause streaks. Status dates do not record a completion or grant coins.

11. **Any-time actions**: On a new positive habit, select **Any time**, choose one assignee, and select **Member**, **Manager**, or **Both** for who can record actions. Each action earns a separate reward for that assignee. A manager can record it from **Family**, including optional evidence when approval is required. Recording permissions are controlled by the creator or an administrator. The recorder may undo their own action while they still have access; an administrator retains recovery access. Retried requests cannot grant a second reward, even after undo. Any-time actions create no daily streak obligation or timed reminder.

Schedule modes are fixed once an item has completion or slip history; create a new item to change its mode without reinterpreting old records. Resolve pending approvals before changing schedules, recording permissions or assignees. For completion-relative items, record cycles in date order and undo later cycles before correcting an earlier one. Monthly calendar dates that do not exist in a month are skipped; choose **Last day** when every month should have an occurrence.

Task-menu **Move to Today** and **Move to Tomorrow** shortcuts are unavailable for completion-relative tasks and while approval is pending. The menu explains the restriction; these shortcuts do not alter a completion-relative cycle or its history.

## Docker Deployment

Build this checkout; the upstream image does not contain this fork's changes. Version 1.0.0 requires PostgreSQL for production. Existing v0.9 installations retain their current access until an operator explicitly prepares, maps and activates families. PostgreSQL is authoritative for accounts, settings, habits, rewards, coins and attachment metadata; `/app/data` retains protected avatar/evidence files. Existing JSON is migration evidence, not a writable fallback.

1. Follow [database setup and migration](docs/database.md) to provision a dedicated database and restricted runtime login, then initialize a new installation or import and verify an existing one while the app is stopped. Follow the separate [explicit family activation](docs/database.md#explicit-family-activation) procedure; startup never guesses household membership.
2. Keep `AUTH_SECRET` stable and separately backed up. Configure the runtime `DATABASE_URL` and `AUTH_SECRET` through a private environment file or secret manager. Never put the migration/owner connection in the ordinary application container.
3. Prepare owner-only `data` and `backups` mounts, writable by container UID/GID `1001:1001`, then build and start:

```bash
mkdir -p data backups
chmod 700 data backups
# On the deployment host, assign these mounts to UID/GID 1001:1001.
docker compose build habittrove
docker compose up -d habittrove
```

Compose connects to the external database from `DATABASE_URL`; normal startup does not create or upgrade a PostgreSQL container, apply schema migrations, import JSON or create a default administrator. Missing/uninitialized storage fails startup. Preserve existing data, environment, container settings and the prior image before upgrading. After database writes begin, rollback requires a verified current snapshot. Prepared/enabled families need the complete version 2 format and a compatible application; old JSON or a selected-family export cannot recover the installation.

The optional `database-test` Compose profile starts an isolated PostgreSQL 17.11 service on loopback port 15432, with temporary storage. It is for development/tests only and requires an ephemeral `POSTGRES_TEST_PASSWORD`. See [isolated database tests](docs/database.md#isolated-database-tests).

## Security

Initialize a new production database explicitly with the offline CLI described in [database setup](docs/database.md). Startup never creates or replaces accounts. Set `AUTH_SECRET` to a random value of at least 32 characters and protect it as a credential.

Every new account needs an email and either a local password or an OIDC subject. Administrator accounts always need a local password for recovery. Existing accounts without email can sign in, but must add an email before using the app; this retains their account IDs and data and requires signing in again. Local email entry is not email verification. New and changed local passwords must be 12–128 characters. Existing shorter passwords still work until changed. Passwordless accounts cannot use local sign-in; assign a password or link an OIDC subject.

For an OIDC-only account, an administrator must set its first local password. Existing users can change their own local password after confirming the current one. Password, role, email, and identity-link changes invalidate existing sessions.

For a legacy passwordless administrator, stop the app and use the included recovery script. It saves a restricted snapshot of the prior database credential document in `backups` before changing the password and invalidating existing sessions:

```bash
docker compose stop habittrove
printf 'New password: '
read -rs RECOVERY_PASSWORD
printf '\n'
printf '%s\n' "$RECOVERY_PASSWORD" | docker compose run --rm --no-deps -T habittrove node scripts/set-local-password.mjs admin
unset RECOVERY_PASSWORD
docker compose up -d
```

Repeat for other passwordless accounts if needed. The script must run while the app is stopped to avoid concurrent writes. Back up a consistent database snapshot and the protected assets before a deployment or migration; see [recovery](docs/database.md#backup-restore-and-rollback).

### OIDC sign-in

Create a confidential OpenID Connect client with your identity provider. Register `https://YOUR-HABITTROVE-HOST/api/auth/callback/oidc` as the exact redirect URI and allow the `openid`, `profile`, and `email` scopes. Configure it in **Settings → Admin panel → OIDC setup**, or set these environment values:

```text
AUTH_URL=https://YOUR-HABITTROVE-HOST
OIDC_ISSUER=https://YOUR-IDENTITY-PROVIDER/ISSUER
OIDC_CLIENT_ID=YOUR_CLIENT_ID
OIDC_CLIENT_SECRET=YOUR_CLIENT_SECRET
```

The issuer must use HTTPS in production and support standard OIDC discovery. Self-linking requires an `email_verified: true` claim and a matching email. Providers that omit or cannot verify that claim require an administrator to pre-link the subject in the user editor. Include the verified email claim in the ID token and back it with an actual verification process; never label an unverified address as verified.

Upgrading from v1.0.2 or earlier: provider-specific environment variables and callback aliases are removed. Configure the `OIDC_*` values above (or retain the existing in-app configuration), register `/api/auth/callback/oidc` with the provider, and restart. Keep the issuer and client ID unchanged to preserve existing PostgreSQL identity links. Keep a working local administrator password and a complete backup before upgrading. In-flight account-link requests must be started again. Older JSON imports need their external identity subject field renamed to `oidcSubject`; convert a private copy, preserve the issuer, and regenerate any migration manifest before import. Raw PostgreSQL recovery backups retain their normalized identity rows.

The current local password is required to save OIDC changes. The page shows the OIDC callback URL. It never displays the saved client secret. Leaving the secret blank retains it only when the issuer and client ID stay the same; changing either requires a new secret. Existing linked accounts must be unlinked before changing the issuer, then linked again after the new provider is active. Some providers change pairwise subjects when the client ID changes, so those users may also need to relink. Before disabling OIDC, give every OIDC-only account a local password; the Admin panel blocks disabling while those accounts exist. OIDC changes take effect after restarting the container. Local sign-in remains available during this process.

The **Sign-in button name** field in OIDC setup changes the text on OIDC login buttons, such as “Continue with Meadow Login.” It applies immediately in the current session; other open sign-in pages pick it up when reloaded. It does not change the provider, client credentials, callback URL, or account links. Leave it blank to restore “OIDC.”

The first in-app OIDC save creates a database override; an explicit in-app disable also overrides the environment values. Until then, the complete `OIDC_*` set remains active. The client secret is encrypted using a key derived from the external `AUTH_SECRET`. Preserve that key separately from downloadable backups. A damaged provider configuration disables OIDC while retaining local administrator recovery; database outages fail startup. Restore a known-good database/configuration with the original key or repair it through the reviewed recovery procedure. Editing or removing the old `data/admin-config.json` no longer changes production settings.

The same Admin panel contains the existing system settings (timezone, week start, backups, and language) and an application log level (Debug, Info, Warn, or Error). Log level changes apply immediately to HabitTrove's server backup, scheduler, and data-action logs; framework and browser logs have their own settings. This setting does not change `NODE_ENV` or container logging controls.

### SMTP family invitations

In **Settings → Admin panel → SMTP email**, enable SMTP and enter your mail server host, port, sender address, and optional username and password. Port 587 with **Implicit TLS** off requires STARTTLS; enable **Implicit TLS** for servers that expect TLS on connection, typically port 465. Saving requires the administrator's current local password. The SMTP password is encrypted in the database using `AUTH_SECRET`, is never returned to the browser, and is retained when its field is left blank and the username stays the same. Preserve `AUTH_SECRET` with your backups.

Set `AUTH_URL` to your public HabitTrove HTTPS origin so emailed invitation links use the correct hostname. For activated families, owners and site administrators create named-family invitations on the Family page; before activation, existing administrator invitations remain in the Admin panel. When SMTP is unavailable or delivery fails, the panel displays the one-use link for manual sharing and reports that email was not sent. Creating an invitation does not verify delivery. Keep manual links private; a valid link permits the matching email account to join the named family until it expires or is revoked. Existing users must sign in and accept; no email-only account linking occurs.

To link an existing local account, sign in locally, add its email if needed, sign in again, then choose **Link OIDC account** from the profile menu. Confirm the local password and sign in to the OIDC account with the same verified email. The link is saved against the provider's stable subject and issuer; later OIDC sign-ins must match both. Email alone never signs into or links an account. Administrators may also pre-link an OIDC subject in the user editor after the provider is active, while keeping a local password on administrator accounts. External identity fields use the provider-neutral `oidcSubject` and `oidcIssuer` names.

PostgreSQL shares failed-login attempts, password-confirmation lockouts and password-verification leases between workers. Ten failures lock a known account's public sign-in for 15 minutes; password-confirmed account actions use a separate lockout. An attacker can still target an account for temporary lockout. Retain a private backup and local administrator recovery password. Database transactions serialize related completion, approval, undo and wallet writes across workers. Multiple-worker infrastructure still needs the same protected asset mount, stable secret and deployment validation; the database change alone does not establish end-to-end scaling support.

The server accepts only HTTP(S) reward links, validates shared drawings and habit schedules, and checks reward limits and resource permissions during redemption. Assigned members may add one completion at a time, dated within the past year. New completions record who added them and reward only the member who records the target-reaching completion. Only that member may undo the latest completion for its day. Undo reverses the original recipients, including any older completion that rewarded every assigned member. An administrator can recover a completion if its recorder is no longer assigned. Older shared completions without a recorded actor cannot be undone by members; an administrator can correct their history and reconcile any legacy coin entries. A day that began with legacy completions receives no automatic new award during migration, preventing duplicate credits. Habit completion remains self-reported; this app cannot independently prove that a real-world habit was performed.

New data files, avatar uploads, and backup archives use owner-only permissions. Check and restrict permissions on files created by older versions before exposing a shared host volume. Demo mode is enabled only with `DEMO=true`; account and password mutations and system-setting changes are blocked in that mode.

Backups capture a consistent database snapshot, protected assets and checksum manifest, with a 512 MiB asset-capture limit and shared scheduled-backup ownership. Once the family schema is prepared, scheduled backups use the complete version 2 raw format, including disabled/pending mappings, memberships, family settings and all global ledger history. Restore is an explicit offline operator action against an empty prepared target; preserve the external `AUTH_SECRET` separately. Backups are published only after archiving completes without warnings; failed attempts leave older archives in place. Generated avatar files are removed when their account is deleted. New habit recurrence rules may specify at most 256 times per day; older rules above that limit remain saved but are treated as not due until their schedule is updated.

See [Security review](docs/security-review.md) for scan scope, validation, and remaining operational risks.

The source Dockerfile uses Node.js 22.23.4 to address [CVE-2026-111497](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases). An existing upstream image does not change until its maintainer publishes a rebuilt image.

## Building the Project

To contribute to HabitTrove, you'll need to set up a development environment. Here's how to get started:

### Prerequisites

- Node.js 22 (the Docker/CI version is 22.23.4)
- npm package manager
- Git (for version control)
- bun (for running tests)

### Setting Up the Development Environment

1. Clone the repository and navigate to the project directory:

```bash
git clone https://github.com/dohsimpson/habittrove.git
cd habittrove
```

2. Install project dependencies:

```bash
npm install --force
```

3. Set up the development environment:

```bash
npm run setup:dev
```

4. Configure an initialized disposable PostgreSQL database as described in [database setup](docs/database.md), then start the development server. Legacy JSON remains available only for development/tests/demo with explicit `HABITTROVE_STORAGE=legacy-json`; it is not a production fallback:

```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000) in your browser to access the development version.

### Running Tests

Before contributing, make sure to run the test suite:

```bash
npm test
```

The default suite skips database integration without an explicit isolated fixture. Run [the real PostgreSQL suite](docs/database.md#isolated-database-tests) before changing storage, authentication, backups or asset authorization.

### Building for Production

To build the project for production:

```bash
npm run build
```

This will create an optimized production build in the `.next` directory.

### Code Quality Tools

The project uses several tools to maintain code quality:

- ESLint for linting: `npm run lint`
- TypeScript type checking: `npm run typecheck`

Run these commands regularly during development to catch issues early.

## Contributing

We welcome feature requests and bug reports! Please [open an issue](https://github.com/dohsimpson/habittrove/issues/new). We do not accept pull request at the moment.

## License

This project is licensed under the GNU Affero General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

## Support

If you encounter any issues or have questions, please file an issue on the GitHub repository.
