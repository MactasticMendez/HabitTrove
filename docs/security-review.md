# Security review

The Codex Security deep source scan reviewed the whole repository at commit `98cd36e` and reported 38 findings (29 medium, 9 low). This branch was checked against those findings and adds server-side controls for authentication, account linking, resource permissions, shared input, coin rewards and redemption, demo behavior, backup permissions, and CI publishing. Production dependencies were also audited. The static scan did not exercise the live instance or Authentik.

## Validation

- Unit and security tests, TypeScript, lint, and production build cover the changed code.
- A local browser check covers local sign-in and the mandatory-email screen. Pa11y/axe found no issues on those screens. On the dashboard, axe marks five SVG chart labels for manual contrast review because it cannot determine the background behind the chart. The rendered labels use the foreground color; this is a tool limitation, not a measured contrast failure.
- OAuth setup and live deployment require the operator's own Authentik provider and remain untested end to end.

## Remaining risks

- Use one application process per data directory. JSON writes and failed-login throttling are serialized only inside one process; multiple replicas can race or bypass the throttle. A transactional store and shared rate limiter are needed before scaling out.
- Habit completion is self-reported. An authorized member can still enter false past completions, one at a time, and receive rewards. Limiting edits to the past year reduces bulk abuse but cannot prove real-world activity.
- Files created by previous versions may have broad permissions. Restrict `data` and `backups` on the host before deployment. New files are owner-only.
- The initial email entered for a local account is not verified by email. Automatic Authentik linking requires a current local password and a matching Authentik email claim marked verified by the identity provider.
- Some new security UI strings use English fallback in non-English locales. Complete translations before treating those locales as fully localized.
- The development dependency audit still reports moderate advisories in old lint-tool dependencies. The production dependency audit reports none; a compatible lint-tool upgrade remains to be evaluated.
