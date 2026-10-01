# Contributing

Thanks for helping. Cortextrace watches sensitive activity, so changes are judged in this order: **security → privacy → correctness → reliability → maintainability → performance → UX → breadth**.

## Setup

```bash
git clone https://github.com/manjunatha552355-rgb/cortextrace.git && cd cortextrace
npm ci                              # Node 24+
npx electron scripts/icons.cjs
npm run build && npm start
```

To iterate on the engine without Electron:

```bash
npm run engine -- --data-dir ./.data --no-collectors
npm run synthetic -- --data-dir ./.data --agents 10 --rate 1200
```

## Before opening a PR

```bash
npm run typecheck
npm test
npm run e2e          # builds and launches the desktop app; look at the screenshots it prints
```

- **Every bug fix adds a regression test** that fails without the fix.
- New detection rules need `examples.match` and `examples.no_match`.
- New data sources go in `docs/PRIVACY.md`. If they are on by default, also add them to the onboarding disclosure.
- New trust boundaries or listeners go in `docs/THREAT_MODEL.md`.
- Adapters: follow the checklist in `docs/ADAPTERS.md`.
- Never add code that hides the app, runs covertly, bypasses OS security controls, or executes real malicious payloads in tests. The synthetic generator only sends *strings* that describe risky actions.

## Code style

- TypeScript with erasable syntax only (no enums, namespaces or constructor parameter properties). Tests run on Node's native type stripping.
- Prefer the standard library and existing helpers to new dependencies. A new runtime dependency needs a justification in the PR and a permissive license (`npm run licenses` enforces this).
- Comments explain *why*, not *what*.
- UI: use the tokens in `styles.css`. Severity colours are only for severity and always sit next to a text label. Charts use the fixed categorical order in `lib.ts`.

## Commit messages

Use the imperative mood and reference issues where relevant, for example `Fix duplicate command events from process snapshots (#123)`.

## How issues are handled

New issues are triaged by Claude, using [`.github/workflows/claude.yml`](.github/workflows/claude.yml):

1. **Type label.** Claude applies one of `bug`, `feature`, `question` or `invalid`.
2. **Missing details.** If details are missing, Claude labels the issue `needs-info` and asks for exactly what is missing. Reply in a comment on the issue and it will be re-evaluated.
3. **Actionable bugs.** These are labelled `ready-for-fix`. A maintainer starts the fix by adding `claude-fix`. Claude then opens a pull request with a regression test, and the issue is labelled `fix-proposed`.
4. **Review.** Pull requests from Claude are never merged automatically. A maintainer reviews and merges every one.

Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in an issue.

## License

By contributing, you agree that your contributions are licensed under Apache-2.0.
