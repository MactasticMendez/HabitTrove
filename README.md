# <img align="left" width="50" height="50" src="https://github.com/user-attachments/assets/99dcf223-3680-4b3a-8050-d9788f051682" /> HabitTrove

![cover](https://github.com/user-attachments/assets/b63e98b4-64ae-49c7-ae7e-21ef76c04a5a)

HabitTrove is a gamified habit tracking application that helps you build and maintain positive habits by rewarding you with coins, which you can use to exchange for rewards.

Also, try [TaskTrove](https://github.com/dohsimpson/TaskTrove):

<a href="https://github.com/dohsimpson/TaskTrove"><img width="3400" height="920" alt="tasktrove-banner" src="https://github.com/user-attachments/assets/ec728fba-7645-4169-b383-f760967840b9" /></a>


## Try the Demo

Want to try HabitTrove before installing? Visit the public [demo instance](https://demo.habittrove.com) to experience all features without any setup required. (do not store personal info. Data on the demo instance is reset daily)

## Features

- 🎯 Create and track daily habits
- 🏆 Earn coins for completing habits
- 💰 Create a wishlist of rewards to redeem with earned coins
- 📊 View your habit completion streaks and statistics
- ✏️ Add freehand drawings to habits and wishlist items for visual reminders
- 📅 Calendar heatmap to visualize your progress (WIP)
- 🌍 Multi-language support (English, Español, Català, Deutsch, Français, Русский, 简体中文, 한국어, 日本語)
- 🌙 Dark mode support
- 📲 Progressive Web App (PWA) support
- 💾 Automatic daily backups with rotation

## Usage

1. **Creating Habits**: Click the "Add Habit" button to create a new habit. Set a name, description, and coin reward.

2. **Tracking Habits**: Mark habits as complete on your dashboard. Each completion earns you the specified coins.

3. **Wishlist**: Add rewards to your wishlist that you can redeem with earned coins.

4. **Statistics**: View your progress through the heatmap and streak counters.

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

Every new account needs an email and either a local password or an Authentik subject. Administrator accounts always need a local password for recovery. Existing accounts without email can sign in, but must add an email before using the app; this retains their account IDs and data and requires signing in again. Local email entry is not email verification. New and changed local passwords must be 12–128 characters. Existing shorter passwords still work until changed. Passwordless accounts cannot use local sign-in; assign a password or link an Authentik subject.

For an Authentik-only account, an administrator must set its first local password. Existing users can change their own local password after confirming the current one. Password, role, email, and identity-link changes invalidate existing sessions.

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

### Authentik sign-in

Create a confidential OAuth2/OIDC provider and application in Authentik. Use `https://YOUR-HABITTROVE-HOST/api/auth/callback/authentik` as the exact redirect URI and enable the `openid`, `profile`, and `email` scopes. Set these environment values in Compose or your container manager:

```text
AUTH_URL=https://YOUR-HABITTROVE-HOST
AUTHENTIK_ISSUER=https://YOUR-AUTHENTIK-HOST/application/o/YOUR-PROVIDER-SLUG/
AUTHENTIK_CLIENT_ID=YOUR_CLIENT_ID
AUTHENTIK_CLIENT_SECRET=YOUR_CLIENT_SECRET
```

The Authentik provider must return `email_verified: true` for account linking. Authentik 2025.10 and newer return `false` from the default email mapping; [configure a verified-email mapping](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/verify-email-address/) backed by an actual verification process. Include the email claim in the ID token. Do not set `email_verified: true` for addresses that have not been verified.

To link an existing local account, sign in locally, add its email if needed, sign in again, then choose **Link Authentik account** from the profile menu. Confirm the local password and sign in to the Authentik account with the same verified email. The link is saved against Authentik's stable subject; later Authentik sign-ins use that subject. Email alone never signs into or links an account. Administrators may also pre-link an Authentik subject in the user editor, while keeping a local password on administrator accounts.

Local sign-in throttling is process-local. Run one app instance against a data directory; the JSON store and throttle are not designed for multiple replicas. Retain a private backup and a local administrator recovery password.

The server accepts only HTTP(S) reward links, validates shared drawings and habit schedules, and checks reward limits and resource permissions during redemption. Interaction-only members may add or undo one completion at a time, dated within the past year. Habit completion remains self-reported; this app cannot independently prove that a real-world habit was performed.

New data files, avatar uploads, and backup archives use owner-only permissions. Check and restrict permissions on files created by older versions before exposing a shared host volume. Demo mode is enabled only with `DEMO=true`; account and password mutations and system-setting changes are blocked in that mode.

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
