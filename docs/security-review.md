# Security review

The Codex Security deep source scan reviewed the whole repository at commit `98cd36e` and reported 38 findings (29 medium, 9 low). This branch was checked against those findings and adds server-side controls for authentication, account linking, resource permissions, shared input, coin rewards and redemption, demo behavior, backup permissions, and CI publishing. Production dependencies were also audited. The source scan itself did not exercise the live instance or Authentik; the sign-in flow was checked separately after deployment.

## Validation

- Unit and security tests, TypeScript, lint, and production build cover the changed code.
- A local browser check covers local sign-in and the mandatory-email screen. Pa11y/axe found no issues on those screens. On the dashboard, axe marks five SVG chart labels for manual contrast review because it cannot determine the background behind the chart. The rendered labels use the foreground color; this is a tool limitation, not a measured contrast failure.
- A live local account with a mandatory email was linked to the existing Authentik identity after the account owner entered their local password. The saved account record had one matching email and a linked identity. After deploying image `habittrove-fork:7923877`, a fresh Authentik sign-in reached that account's dashboard with its existing habits and coin balance. The Unraid container was healthy and returned HTTP 200 locally, and its saved template points to the deployed image. The prior image and account backup were retained for rollback.
- This live check covers one existing account and one Authentik sign-in. It does not establish behavior for every identity-provider failure or future multi-user migration.

## Remaining risks

- Use one application process per data directory. JSON writes and failed-login throttling are serialized only inside one process; multiple replicas can race or bypass the throttle. A transactional store and shared rate limiter are needed before scaling out.
- Habit completion is self-reported. An authorized member can still enter false past completions, one at a time, and receive rewards. Limiting edits to the past year reduces bulk abuse but cannot prove real-world activity.
- Files created by previous versions may have broad permissions. Restrict `data` and `backups` on the host before deployment. New files are owner-only.
- The initial email entered for a local account is not verified by email. Automatic Authentik linking requires a current local password and a matching Authentik email claim marked verified by the identity provider.
- Some new security UI strings use English fallback in non-English locales. Complete translations before treating those locales as fully localized.
- The development dependency audit still reports moderate advisories in old lint-tool dependencies. The production dependency audit reports none; a compatible lint-tool upgrade remains to be evaluated.
