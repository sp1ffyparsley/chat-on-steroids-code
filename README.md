# Chat On Steroids â€” code research mirror

This is the real custom Chat On Steroids application and browser companion source, exported for code review and research. It is a clean-history code export, not an upstream release or a backup of anyone's chats.

- Source commit: `41be642523fccfd607ae33d51bd21758dc12bb5d`.
- Source tree: `81ffc4df6e6155cfe7e8e78b62dd17e40f4add6b`.
- Export date: October 28, 2026.
- Upstream: https://github.com/totec448-spec/chat-on-steroids
- Intended code mirror: https://github.com/sp1ffyparsley/chat-on-steroids-code

The package retains the custom branch's `2.1.39` version. This does not mean the export includes upstream 2.1.46 wholesale. The original private repository, history, branches, tags and operational records are not included.

## Included application

`src/main` contains the actual Electron/Bridge, session persistence, Goal/Loop, evidence, tools and delivery implementation. `src/preload` and `src/renderer` contain the desktop interface. `extension` contains the browser companion. Native source, artwork, the package lockfile, build configuration and build/dev/packaging tools are retained, together with generic source tests.

The MIT license, original attribution and third-party notices remain in `LICENSE`, `THIRD-PARTY-NOTICES.txt` and `docs/licenses`. Names and contact addresses in third-party licenses remain as required attribution.

## Build and development

Use a supported Node.js runtime compatible with the lockfile (this source uses Node 24), npm and your platform's native build prerequisites. Start without copying another installation's settings or encrypted stores.

```sh
npm ci
npm run typecheck
npm run build
npm run dev
```

`npm run build` compiles the application. It does not install an update or prove that Chrome has loaded this companion. `npm run dev` uses the existing checkout-isolated development launcher and starts a real application. Configure folders, provider access and browser pairing deliberately in that instance. No credentials or account grants are supplied here.

`npm test` runs the retained tests. `npm run verify:ci` also checks prerequisites, notices, types and privacy conventions. Some checks require Git, PowerShell, native dependencies or a specific operating system. The complete mirror suite and packaged runtime have not been qualified as a public release. Compilation does not prove automatic useful work or native delivery.

macOS requires macOS 13 Ventura or newer and independent native permission and packaging checks. On Linux, the existing conditional `--no-sandbox` fallback applies only where unprivileged user namespaces are unavailable; it is not an instruction to change system security settings.

## Packaging boundary

Existing packaging and installer source remains available for review. The private custom installer pins describe historical exact artifacts; this sanitized export has a different source identity. Those pins do **not** qualify an installer built here. Do not use them to replace an existing account installation. This mirror supplies no prebuilt installer, signing credentials, account data, deployment qualification or rollback package. Upstream release/publishing workflows are omitted; publishing this source does not initiate an installer release.

## Privacy exclusions

No original Git history, account stores, browser profiles, logs, screenshots, transcripts, operational `AGENTS.md`, `AI_MASTER_PROMPT.md`, `PROGRESS.md`, cleanup ledger, research HTML, task prompt library or creative reference images are exported. Project-rule filenames remain in application code because reading a user's project instructions is a real feature.

The following operator-specific scripts are omitted rather than replaced with dummy prompts or accounts:

- `scripts/build-prompt-review.mjs`
- `scripts/migrate-prompt-library-reliability-20261005.mjs`
- `scripts/process_prompts.py` and its operator README
- `scripts/prompt-files.mjs`
- `scripts/prompt-library-text.mjs`
- `scripts/queue-chat.mjs`
- `scripts/reconcile-prompt-history.mjs`
- `scripts/stage-approved-rollout.mjs`
- `scripts/workflow-queue.mjs`
- `scripts/verify-macos-account-isolation.mjs`

Consequently `queue:chat` and `verify:mac:isolation` are not package commands here. Application Goal/Loop, workflow, input and delivery implementations remain present; the personal task-library dispatch layer is excluded.

These tests depend on omitted private tasks, operational documents or upstream release workflows and are not exported:

- `test/agent-plan.test.ts`
- `test/mcp-user-instructions.test.ts`
- `test/prompt-files.test.ts`
- `test/prompt-history-reconciliation.test.ts`
- `test/prompt-library-text.test.ts`
- `test/prompt-library.test.ts`
- `test/queue-chat.test.ts`
- `test/skills-integration.test.ts`
- `test/workflow.test.ts`
- `test/packaging.test.ts`

Retained tests use generic replacements for personal nicknames and example user paths. Production differences from the snapshot are limited to anonymized comments, example translation text and primary-account error wording. Runtime ownership, persistence, completion, native Send/ACK, recovery and security logic are unchanged. Package metadata points to this mirror and omits the two unavailable operator commands.

## Research scope

Review the actual implementation and retained tests when investigating result attribution, worker ownership, stale Goal decisions, stream interruptions and helper retirement. Distinguish available source, compilation, installed bytes, browser-loaded code, native receipts, useful output and an automatic following turn. A result in a newer scope does not resolve an older unresolved call. Missing private evidence is not permission to invent an ACK or replay an uncertain effect.

Changes still require affected tests, review, a separately qualified package and deliberate activation. This snapshot makes that review possible without publishing operational history.

## Export validation

On Windows, the exported source passed `npm run typecheck` and `npm run build` using the existing lockfile-compatible local dependencies. The build produced the main, preload and renderer bundles; it reported ordinary shared-import and dependency annotation warnings. Dependencies and generated output are ignored and are not part of this repository. No development app or account was launched, no installer was produced, and the full retained test suite was not run for this export.

Focused export checks cover 121 distinct tests in `instance-profile`, `profile-work-state` and `renderer-i18n`. The first run found one expected-message mismatch introduced by anonymizing account wording. After correcting that test's expected wording, its entire 73-test file passed; the other 48 tests had passed in the first run. This is limited export validation, not the complete private release qualification.

The final source snapshot includes the reviewed exact-helper-expiry archive-only repair. It preserves late output without restoring a cancelled waiter or authorizing another executor Send. Historical unmarked cancellations remain ineligible.
