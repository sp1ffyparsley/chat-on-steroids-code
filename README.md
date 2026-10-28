# Chat On Steroids - code research mirror

This is the real custom Chat On Steroids application and browser companion source, exported for code review and research. It is a clean-history code export, not an upstream release or a backup of anyone's chats.

- Source commit: `4f3267c030413b1d5a5b6e4cf6f71f478362dcc2`.
- Source tree: `a5aa7f3eaf0a643ca91457ba0f508f7ea46fb409`.
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

Start a focused investigation at the existing owner:

- Native call scope and result attribution: `extension/fiber.js`, `extension/content.js`, `src/main/session/correlation.ts` and `src/main/bridge.ts`; compare their retained shell and Bridge tests.
- Goal decisions, saved continuation identity and settings transitions: `src/main/goal.ts`, `src/main/session/input.ts`, `src/main/ipc.ts` and `src/main/settings-control.ts`.
- Native Retry, interrupted streams and helper preservation: the existing recovery paths in `extension/content.js`, `extension/background.js`, `src/main/goal.ts` and `src/main/session/input.ts`.
- Build and activation evidence: `scripts/install-custom.ps1` and `scripts/dev-fast.mjs`, subject to the packaging boundary above.

Read production code and its tests before recommending a change. Cite the exact public commit and verified file/symbol, distinguish source findings from supplied runtime observations, and identify missing evidence rather than inventing native identities or results. Account logs and private release artifacts are not available from this mirror.

## Export validation

On Windows, the exported source passed `npm run typecheck` and `npm run build` using the existing lockfile-compatible local dependencies. The build produced the main, preload and renderer bundles; it reported ordinary shared-import and dependency annotation warnings. Dependencies and generated output are ignored and are not part of this repository. No development app or account was launched, no installer was produced, and the full retained test suite was not run for this export.

Focused export checks cover 121 distinct tests in `instance-profile`, `profile-work-state` and `renderer-i18n`. The first run found one expected-message mismatch introduced by anonymizing account wording. After correcting that test's expected wording, its entire 73-test file passed; the other 48 tests had passed in the first run. This is limited export validation, not the complete private release qualification.

The final source snapshot includes the reviewed exact-helper-expiry archive-only repair. It preserves late output without restoring a cancelled waiter or authorizing another executor Send. Historical unmarked cancellations remain ineligible.

The preceding logical source `41be6425` contains the narrow accepted-native-final identity correction, persisted Settings Save pause-transition hook and bounded storage/source explanations. Its export passed typechecking, four focused Goal/IPC cases and the complete 41-case diagnostic file. An earlier filtered diagnostic run reported asynchronous import teardown errors; the subsequent whole diagnostic-file run passed without suppressing them.

The preceding logical source `2aaea54f` adds truthful delivered-helper cancellation classification and separate, bounded current-observation identity-refusal diagnostics. Its source-owner checks passed 889 Input/Goal/error cases (two platform skips), 2614 browser/operator cases and a final 284 Bridge/operator selection, plus typechecking and JavaScript syntax checks. Those sets overlap and must not be added together as distinct tests.

The preceding source `2b7c8b90` adds narrowly matched finished-result request-ID capture, idempotent HTTP reconciliation of typed rejected helpers, post-await helper Pause checks, the saved-continuation status flag and exact keyed-incident retirement across delayed writes/restart. Original source, per-parent results, authorization, output hash, spent disposition and rollback guards remain binding. Source checks passed 756 installer/Input cases (two platform skips), 132 Fiber cases, 90 HTTP provisioning cases, 168 incident/Bridge/session/logger cases and 18 selected renderer cases. These sets overlap. Recorder/background source markers are synchronized at 92; running-browser generation is unverified. Its private qualification completed; the source export itself is not a qualified/installed public package or a claim of autonomous useful successors. Historical private installer pins describe reviewed private program artifacts only.

Current source `4f3267c0` preserves an explicit destination Goal switch during handoff, separates positive app-maintenance quiescence from continuation-busy presentation without clearing native-result debt, adapts [PR1900](https://github.com/totec448-spec/chat-on-steroids/pull/1900) typed model failures and private-safe fixed-enum Send logs, and shows unmatched broker custody as Unknown instead of Active. Recorder/background source markers are synchronized at 93. The source owner passed 4685 affected tests (two platform skips) and 82 renderer/i18n/layout cases, plus typechecking and JavaScript syntax checks. Its private canonical qualification completed: 96 preliminary checks and 12462 Main tests passed (61 platform skips), followed by 31 installer checks and exact-package readiness. The private receipt-only qualification pin is 61bb9581. These private results are supplied provenance, not a test run of this sanitized mirror. Installation and executing browser generation remain separate and are not claimed here. This public mirror is source only and supplies no binary or autonomy claim.
