# Chat On Steroids - code research mirror

This is the custom Electron application and Chrome companion source exported for code review. It has clean public history and excludes private account stores, saved prompts, credentials, runtime logs and deployment artifacts. This source mirror is separate from upstream releases and supplies no public installer.

## Current checkpoint — October 30, 2026

- Public URLs must use this mirror's OWN immutable commit SHA. Private qualification hashes below are provenance, not public Git refs. Source observer/background **109**, MAIN Fiber reply schema15 and bridge protocol16 are separate version spaces; the custom package label remains2.1.39.
- **Qualified private109, not installed:** logical source63038be0bd7ade89ed012b52f80d1b43857913cc, treed414fbb65fe7bf621274a0cd0503ba92c064e41e, receipt-only pinb6561d439adca9695ceb840d014f7d62dd57ff0e. Canonical qualification passed96preliminary and12,771Main checks/62existing skips (968.40s), followed by33post-pin checks and exact-package readiness. Its exact290-file payload and packaged source were independently checked. These supplied private results do not qualify a binary rebuilt from sanitized public code.
- **Actual accepted installation remains106:** logical sourcea3b668ff8c22f7c38e1b328b9478f4f5da5b86b1/treeb364a72c70d251b59761b37573af92d7c6ec5f76/receiptb7fd8892324c8083dba7f9a737ba79d536472b32. Normal canonical installation completed2026-10-30T08:02:34Z/NSIS0. All117,673protected originals and private backup copies/5,686,838,264bytes matched before seven normal successors; all291installed program files/571,522,856bytes matched. Fourteen configuration/encrypted-store files and six queues matched independently before AND after startup.
- **Activation109 is held before capture or NSIS:** all seven application processes closed normally with persisted maintenance pauses; an independent editor still holds installed program files. Computer Use failed input geometry and then capture during its normal save/exit recovery. No force-close, unknown-effect replay, backup overwrite, installer invocation or successor startup occurred. Browser-loaded109 and useful automatic successors remain unverified. Source tests, installed files, a fresh timestamp, a queued input or reload dispatch cannot prove them.

## Repairs present in109

1. A virtualized typed user widget may recover exactly ONE selected own-data native user identity through the existing mounted live-entry/current-branch/current-final/cache proof. It recovers no user text, Send receipt or terminal result. Cache-only identities, multiple users, unselected/foreign results, conflicting cache and accessor roles remain refused.
2. Selectively adapted upstreamv2.1.48 issue1905: bounded48-version/choice model menus, localized colon-bearing group IDs and unreadable UNSELECTED lanes retain native navigation order. Requested selected model/reasoning must still match exactly and be available.49entries/ambiguity remain refused; no fallback model or spent-circuit rearm is introduced.
3. Fixed per-helper diagnostic answer:route-reack-refused distinguishes route acknowledgment refusal from final output publication failure through the existing coalesced native-Sent-only owner. Exact captured output, archive/fsync, original native receipt, retry budget and source checks remain unchanged.
4. Finite Goal STOP cannot bypass an explicit external hold or opening generated-authorization rejection; leading whitespace/Markdown is normalized before the exact hold marker. Original objective, exact native delivery and output archive survive. Ordinary valid STOP and quoted authorization task data retain their semantics. This bounded opening check does not grant capability or replace actual root/security checks.
5. Ancestor scope failure uses existing priorToolScopeMismatch rather than blaming each descendant as an independent selected-call mismatch. Both original-parent associations remain withheld until exact proof exists; no acceptance predicate is relaxed.
6. Orphan progress returns false before cold outbox load/expiration when no live waiter exists. The existing waiter lookup still runs AFTER load to avoid a stale callback race. The8000-character partial-progress bound and separate final-response bound remain; actual queue admission still rejects the same corrupt source without replacing bytes.
7. Missing Windows PYTHONIOENCODING defaults to utf-8 to match captured stdout/stderr. Explicit inherited/per-command/empty values win; parent environment, Python filesystem/locale mode and POSIX behavior are unchanged.
8. Existing maximum-conversation-length recovery owns one durable emergency handoff retaining the Goal. No second replacement mechanism, generic Continue loop, harvester, scheduler or security autoapproval is added.

Four finite-Goal, two ancestor and one orphan-progress failures were reproduced against old code before repair. Full affected Goal/backend/Fiber/shell/error checks passed1,097 in EACH controlled/public tree; full controlled Input817PASS/2POSIXskip; native58PASS/16platformskips; collector/HTTP/conversation-limit12PASS and separate controlledHTTP7PASS. Earlier reader/model608 and Goal/backend/content2,220 checks overlap these sets and must not be added as unique checks. Typechecks passed. Failed qualification attempts remain failed: corrected108 had96preliminary/12,745MainPASS/one original-contract phrase failure; original wording was restored without weakening its assertion. First109 stopped before Main on a genuine stale-frame refusal when its test window moved. Two retained-frame/crop tests now use real screen frames while production geometry/focus/currentness enforcement stays intact. Corrected109 full qualification is reported above.

## Open runtime questions

- Retained original-parent/result joins still need exact native question/document/epoch and ordered-parent proof. A fresh zero-call or associated projection cannot erase an older unresolved fence. Historical native field values behind the remaining provider shape are unknown.
- A native-Sent helper may still fail answer extraction, route acknowledgment, archive or current-source admission. These phases are separate; a visible JSON STOP does not prove exact helper custody, accepted Goal completion or useful work.
- The supported companion reload owner retains bounded unfiltered committed/pending page inventories, command leases, pairing, pause and final currentness checks. Open/pending ChatGPT documents remain a veto. Disabled browser controls are not bypassed with another browser, chat, CDP, shell or native browser automation.
- Require one existing-chat pilot with verified useful original-scope output, exact helper archive/native delivery and useful automatic successor before increasing concurrency. A legitimate external hold is BLOCKED, not a successful cycle. Garry's requested helper remains GPT-6 Thinking/High; root-picker observations do not confirm helper selection.

The sections below retain earlier export history. Their then-current source/installation observations are historical; the checkpoint above controls.

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

Installer-source follow-up: the existing Windows activation transaction now uses a bounded, read-only Restart Manager census before the capture/installer runner. It reports external applications holding installed program files and refuses unknown or held ownership without stopping those applications. Native held/released-file checks and transaction refusal checks cover Windows PowerShell and PowerShell 7. This mechanism is retained; the currently exported source and the separately accepted private installation are distinguished above. The mirror is not private installation authority.

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

Preceding source `4f3267c0` preserves an explicit destination Goal switch during handoff, separates positive app-maintenance quiescence from continuation-busy presentation without clearing native-result debt, adapts [PR1900](https://github.com/totec448-spec/chat-on-steroids/pull/1900) typed model failures and private-safe fixed-enum Send logs, and shows unmatched broker custody as Unknown instead of Active. Recorder/background source markers are synchronized at 93. The source owner passed 4685 affected tests (two platform skips) and 82 renderer/i18n/layout cases, plus typechecking and JavaScript syntax checks. Its private canonical qualification completed: 96 preliminary checks and 12462 Main tests passed (61 platform skips), followed by 31 installer checks and exact-package readiness. The private receipt-only qualification pin is 61bb9581. These private results are supplied provenance, not a test run of this sanitized mirror. Installation and executing browser generation remain separate and are not claimed here. This public mirror is source only and supplies no binary or autonomy claim.

Preceding source `99fd074e` isolates two terminal status renderers from recorder restoration without swallowing authoritative startup failures; makes helper-custody inspection a serialized, detached read; distinguishes an owed Goal reply from an accepted helper; records bounded fence-birth provenance without granting completion authority; rechecks maintenance census after reversible store flushing and when converting a ready Drain into shutdown; and rejects a future timestamp as positive native quiescence. Recorder/background markers are synchronized at 94. The immutable original-question and per-parent result fences are unchanged: a cache-only identity rebinding proposal was withdrawn because durable storage correctly rejects that transition.

Source-owner checks passed 2543 companion tests, 1295 Main/UI tests (two platform skips), three focused birth-provenance HTTP cases and 311 lifecycle cases. These sets overlap and must not be added together. The corrected coherent private package passed canonical qualification:96preliminary and12480Main tests passed (61skips). Its exact payload/provenance and readiness were reviewed; receipt-only follow-ups preserve the exact ISO timestamp and independently accepted predecessor. These private results do not qualify a binary rebuilt from this mirror or prove installation, executing browser generation or useful autonomous work. A finished helper JSON visible in a page is not a native acceptance receipt. This source-only mirror contains no private runtime evidence or deployment claim.

Qualification follow-up: the first private canonical run passed 67/70 development-launcher checks and stopped on three stale Main-shell source fingerprints before the full Main suite. Both complete navigation-owner bodies were independently byte-identical to the preceding reviewed source. The corrected exact source fingerprint remains classified as blocked navigation, and all three affected cases passed without relaxing unknown-source or native-runtime guards. The second canonical run passed as stated above. The first run remains failed. The source owner subsequently completed the private store-preserving installation with NSIS exit0, independent program/configuration verification and protected-state verification before normal successors. This is supplied private deployment provenance, not a public installer release, permission to install a mirror rebuild or proof of browser-loaded code. Executing browser generation and sustained useful autonomy remain unverified.

A later upstream review reached main66820bd6 with releasev2.1.47 unchanged. PR1901 separates queued-only inputs from active browser claims during extension updates; PR1907 extends the unified model picker. Both were reviewed as follow-up candidates, not merged into this already qualified runtime. The custom one-use reload and retained-custody contracts require compatibility work; this mirror does not claim every later upstream feature.

Current source `6c2920d2` combines three bounded repairs. Strict quiet Temporary Chat JSON arms the incumbent stability recheck; asynchronous status/startup effects are fenced to the current recorder, route/epoch/marker and account intent using an applied-response watermark; exact source-superseded native-Sent null-route helpers may archive late output without reviving cancellation, a waiter, Goal debt or an outgoing instruction. Recorder/background96 are synchronized. Routine status checks remain independent of reader/Goal work. Existing Send/Retry/result/authorization guards remain unchanged.

The controlled private cut passed canonical qualification: 96 preliminary and 12,498 main checks passed, with61 platform skips; all33 receipt checks and bare activation readiness passed. Exact package/source/payload hashes were independently reviewed. The first full run remains failed:12,493 passed and five obsolete archive=false assertions failed. Corrected expectations preserve no-child/no-wake/unchanged-source-debt and different-byte refusal;13 affected cases passed before the second canonical run. The installed predecessor receipt advanced only after independent full291-file verification of the already accepted program. No production guard or full-run result was relabelled to hide that failure.

This sanitized export independently passed typechecking and25 focused real content/Bridge cases covering status ownership/startup, quiet helper collection and superseded archive/no-replay behavior. These are limited export checks, not a full public mirror suite or binary qualification. The new private package is qualified but NOT installed; the previous recovery94 remains the accepted installed runtime. Native shutdown capture and executing-browser verification remain unresolved boundaries. No public installer, private account data, runtime state or claim of all-profile useful autonomy is supplied.
