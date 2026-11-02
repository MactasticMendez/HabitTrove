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
- 🏅 Earn achievement badges and set temporary 2× or 3× coin boosts
- 🌍 Multi-language support (English, Español, Català, Deutsch, Français, Русский, 简体中文, 한국어, 日本語)
- 🌙 Dark mode support
- 📲 Progressive Web App (PWA) support
- 💾 Automatic daily backups with rotation

## Usage

1. **Creating Habits**: Click the "Add Habit" button to create a new habit. Set a name, description, and coin reward. Choose daily, every other day, weekdays, or specific weekdays in the repeat menu. The text field remains available for other supported schedules; open Schedule help for examples. Every-other-day schedules begin on the day they are created or changed. A task's due date can be chosen in the calendar or entered as text.

2. **Tracking Habits**: Mark habits as complete on your dashboard. When a daily target is reached, the member who records that completion earns the habit's coin reward, at most once per local day. Only the member who recorded the latest completion can undo it.

3. **Wishlist**: Add rewards to your wishlist that you can redeem with earned coins. The Coins page shows dated transactions and can filter to reward redemptions.

4. **Statistics**: View the current completion streak, a dated seven-day chart, and a 12-week activity calendar. A day counts when at least one habit or task reaches its daily completion target. Today's unfinished day does not break the streak. The calendar uses the timezone selected in Settings, and the dashboard advances to the next day when that timezone reaches midnight.

5. **Organizing**: Choose Manual order on the Habits or Tasks page to drag items or move them with the arrow buttons. Pinned items stay ahead of unpinned items. Manual positions are saved with the items and are visible to everyone who shares them; your chosen sort mode and compact view stay in this browser. On the dashboard, switch Today's Overview between separate sections and a combined list of due habits, due tasks, and overdue tasks.

6. **Recurring tasks and checklists**: Set a task's start date, repeat interval, and optional total number of completions. A recurring task stays open until that goal is reached. Use **Catch up** to record its oldest missed date within the past year. Checklist steps can be marked separately by assigned members; recurring task steps reset after an awarded completion. The main task is completed manually.

7. **Approval and evidence**: Turn on **Require approval** while creating or editing a task or habit, then choose one or more approvers from username suggestions. New items record their creator; only that creator or an administrator can change approval settings. For older items without a recorded creator, an administrator must change those settings. Approvers, including the completer if listed, review submissions at **Approvals**. Coins are awarded to the completing account only after approval. Rejection permits resubmission. Photo evidence is optional; JPEG, PNG, and WebP uploads up to 2 MB are converted to metadata-free WebP and can be viewed only by the completer, creator, or designated approvers. Delete the item or withdraw the submission to remove its evidence file.

8. **Reminders, progress, and boosts**: Choose a reminder time per item. Turn pop-up reminders on in **Settings → Preferences** and select a lead time. The site must be open to show reminders; they are stored per browser and account. Habit cards show the current occurrence streak and progress for the configured week, with one missed occurrence allowed as a grace day. Use the dashboard arrows to reorder sections and **Daily only** to hide less frequent items. Achievement badges use your coin transaction history. A temporary 2× or 3× boost applies only to eligible future completions until its selected end date; an approval submission keeps the reward amount calculated when it was submitted.

## Docker Deployment

HabitTrove can be run using Docker in several ways, depending on your needs:

### Build this fork

The upstream `dohsimpson/habittrove` image does not contain this fork's security changes. Build this checkout before deployment. Back up the `data` and `backups` directories before upgrading an existing installation.

1. Prepare the data directory:

```bash
mkdir -p data backups
chown -R 1001:1001 data backups # Required for the nextjs user in container
```

2. Set the startup credentials and build:

```bash
# Generate a secure authentication secret
export AUTH_SECRET=$(openssl rand -base64 32)
# Required when the data directory has no auth.json yet
printf 'Initial admin password (12-128 characters): '
read -rs INITIAL_ADMIN_PASSWORD
printf '\n'
export INITIAL_ADMIN_PASSWORD
printf 'Initial admin email: '
read -r INITIAL_ADMIN_EMAIL
export INITIAL_ADMIN_EMAIL

docker compose up -d --build
```

The app stores data in `/app/data` and backups in `/app/backups`. The Compose file mounts both directories and builds a local image. Keep `AUTH_SECRET` stable across restarts so existing sessions remain valid.

### Building Locally

If you want to build the image locally (useful for development):

```bash
# Build the Docker image
npm run docker-build

# Run the Compose service with the configured credentials and volumes
npm run docker-run
```

The application data will be persisted in the `data` directory in both cases.

## Security

For a new installation, set `INITIAL_ADMIN_PASSWORD` (12–128 characters) and `INITIAL_ADMIN_EMAIL` before first start. The app stores the password hash and email in `data/auth.json`. These variables do not overwrite existing accounts. Set `AUTH_SECRET` to a random value of at least 32 characters and protect it as a credential.

Every new account needs an email and either a local password or an OIDC subject. Administrator accounts always need a local password for recovery. Existing accounts without email can sign in, but must add an email before using the app; this retains their account IDs and data and requires signing in again. Local email entry is not email verification. New and changed local passwords must be 12–128 characters. Existing shorter passwords still work until changed. Passwordless accounts cannot use local sign-in; assign a password or link an OIDC subject.

For an OIDC-only account, an administrator must set its first local password. Existing users can change their own local password after confirming the current one. Password, role, email, and identity-link changes invalidate existing sessions.

For a legacy passwordless administrator, stop the app and use the included recovery script. It makes a restricted backup of `auth.json` before changing a password:

```bash
docker compose stop habittrove
printf 'New password: '
read -rs RECOVERY_PASSWORD
printf '\n'
printf '%s\n' "$RECOVERY_PASSWORD" | docker compose run --rm --no-deps -T habittrove node scripts/set-local-password.mjs admin
unset RECOVERY_PASSWORD
docker compose up -d
```

Repeat for other passwordless accounts if needed. The script must run while the app is stopped to avoid concurrent writes. Back up the full data directory separately before a deployment or migration.

### OIDC sign-in

Create a confidential OpenID Connect client with your identity provider. Register `https://YOUR-HABITTROVE-HOST/api/auth/callback/oidc` as the exact redirect URI and allow the `openid`, `profile`, and `email` scopes. Configure it in **Settings → Admin panel → OIDC setup**, or set these environment values:

```text
AUTH_URL=https://YOUR-HABITTROVE-HOST
OIDC_ISSUER=https://YOUR-IDENTITY-PROVIDER/ISSUER
OIDC_CLIENT_ID=YOUR_CLIENT_ID
OIDC_CLIENT_SECRET=YOUR_CLIENT_SECRET
```

The issuer must use HTTPS in production and support standard OIDC discovery. Self-linking requires an `email_verified: true` claim and a matching email. Providers that omit or cannot verify that claim require an administrator to pre-link the subject in the user editor. Do not mark unverified addresses as verified. For Authentik 2025.10 and newer, [configure a verified-email mapping](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/verify-email-address/) backed by an actual verification process and include the email claim in the ID token.

The previous `AUTHENTIK_ISSUER`, `AUTHENTIK_CLIENT_ID`, and `AUTHENTIK_CLIENT_SECRET` variables remain supported when no `OIDC_*` values or in-app override are present. They keep the existing `/api/auth/callback/authentik` redirect, so upgrading the app does not interrupt the current Authentik sign-in. Generic `OIDC_*` values take precedence when both complete sets are present. To move an existing Authentik connection to the generic setup, register the new `/api/auth/callback/oidc` URI in Authentik, save the same issuer and client in the Admin panel, then restart and verify sign-in. Existing linked subjects remain valid when the issuer stays the same. The first in-app save records the legacy issuer, so existing links remain bound to it even if the old environment variables are later removed.

The current local password is required to save OIDC changes. The page shows the new callback URL and, during a legacy setup, the currently active callback. It never displays the saved client secret. Leaving the secret blank retains it only when the issuer and client ID stay the same; changing either requires a new secret. Existing linked accounts must be unlinked before changing the issuer, then linked again after the new provider is active. Some providers change pairwise subjects when the client ID changes, so those users may also need to relink. Before disabling OIDC, give every OIDC-only account a local password; the Admin panel blocks disabling while those accounts exist. OIDC changes take effect after restarting the container. Local sign-in remains available during this process.

The first in-app OIDC save creates an override in `data/admin-config.json`; an explicit in-app disable also overrides the environment values. Until then, the complete `OIDC_*` set or legacy `AUTHENTIK_*` set remains active. The client secret is encrypted in that owner-only file using a key derived from `AUTH_SECRET`, so preserve `AUTH_SECRET` along with backups. If this file is damaged, OIDC sign-in stays disabled until it is repaired; local sign-in remains available. To discard the in-app override and return to the environment configuration, stop the app, back up and remove `data/admin-config.json`, then restart. This also resets the app log level to Info.

The same Admin panel contains the existing system settings (timezone, week start, backups, and language) and an application log level (Debug, Info, Warn, or Error). Log level changes apply immediately to HabitTrove's server backup, scheduler, and data-action logs; framework and browser logs have their own settings. This setting does not change `NODE_ENV` or container logging controls.

To link an existing local account, sign in locally, add its email if needed, sign in again, then choose **Link OIDC account** from the profile menu. Confirm the local password and sign in to the OIDC account with the same verified email. The link is saved against the provider's stable subject and issuer; later OIDC sign-ins must match both. Email alone never signs into or links an account. Administrators may also pre-link an OIDC subject in the user editor after the provider is active, while keeping a local password on administrator accounts. The stored `authentikSubject` key is retained for compatibility with existing account data.

Local sign-in throttling is process-local. Password checks run asynchronously with a shared four-verification process limit; ten failures lock a known account's public sign-in for 15 minutes. Password-confirmed account actions have a separate 10-failure lockout. Run one app instance against a data directory; the JSON store and throttle are not designed for multiple replicas. Retain a private backup and a local administrator recovery password.

The server accepts only HTTP(S) reward links, validates shared drawings and habit schedules, and checks reward limits and resource permissions during redemption. Assigned members may add one completion at a time, dated within the past year. New completions record who added them and reward only the member who records the target-reaching completion. Only that member may undo the latest completion for its day. Undo reverses the original recipients, including any older completion that rewarded every assigned member. An administrator can recover a completion if its recorder is no longer assigned. Older shared completions without a recorded actor cannot be undone by members; an administrator can correct their history and reconcile any legacy coin entries. A day that began with legacy completions receives no automatic new award during migration, preventing duplicate credits. Habit completion remains self-reported; this app cannot independently prove that a real-world habit was performed.

New data files, avatar uploads, and backup archives use owner-only permissions. Check and restrict permissions on files created by older versions before exposing a shared host volume. Demo mode is enabled only with `DEMO=true`; account and password mutations and system-setting changes are blocked in that mode.

Backups are published only after archiving completes without warnings; failed attempts leave older archives in place. Generated avatar files are removed when their account is deleted. New habit recurrence rules may specify at most 256 times per day; older rules above that limit remain saved but are treated as not due until their schedule is updated.

See [Security review](docs/security-review.md) for scan scope, validation, and remaining operational risks.

The source Dockerfile uses Node.js 22.23.4 to address [CVE-2026-111497](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases). An existing upstream image does not change until its maintainer publishes a rebuilt image.

## Building the Project

To contribute to HabitTrove, you'll need to set up a development environment. Here's how to get started:

### Prerequisites

- Node.js 20 or later
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

4. Start the development server:

```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000) in your browser to access the development version.

### Running Tests

Before contributing, make sure to run the test suite:

```bash
npm test
```

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
