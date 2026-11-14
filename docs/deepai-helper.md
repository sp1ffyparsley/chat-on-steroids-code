# DeepAI helpers from Chat On Steroids

`scripts/deepai-helper.mjs` submits work to real DeepAI Code chats through the installed app's paired local HTTP/WebSocket interface. CoS or Codex can call the CLI, continue independent work, then collect the matching result. Helpers can implement changes, investigate, review or test; their role comes from the request.

The bridge owns native execution and its shared queue. The Core integration binds helpers to their actual parent and adds bounded result notices to later eligible Core tool responses. Existing CoS Goal, Loop, input and broker owners still decide when chats run. This integration does not wake an idle chat by itself, resume a stalled CoS turn, alter production prompts or replace the parent task's acceptance checks.

Verified native transport versions are 0.3.36 and 0.3.37, both with orchestration protocol 2. Other versions still fail before credential issuance; protocol equality alone does not admit a new release. A desktop upgrade can therefore require a reviewed bridge update. Source CLI readiness is separate from the CLI bundled in an already running CoS program.

Helper status and saved results include exact native context usage for the matching provider thread and run attempt: used/max tokens, percentage and observation time. Missing, stale, conflicting or malformed usage is `unknown`, never an estimated healthy budget. At 90% usage, the next authorized `continue` uses a fresh native chat in the same project/workspace/model and links the saved prior result as its checkpoint. The prior run must be terminal and its report saved first; an exhausted failed run may supply a partial checkpoint, but cancellation, an active run and an unsaved result cannot. The new request retains its own durable command/job identity, parent controls and capacity checks. No background compaction interrupts accepted work, no uncertain mutation is replayed, and unrelated manually created DeepAI chats are not adopted. This checkpoint handoff is not proof that unfinished product work passed acceptance.

## CoS integration and activation boundary

The source now registers a Core `deepai_helper` tool. Its actions are `submit`, `continue`, `status`, `result`, `inbox`, `cancel`, `recover`, `readiness` and `ack`. The model cannot supply an owner, target session or Chrome profile: the server derives parent custody from the exact admitted Core request, stable local session and account/profile identity. A missing identity proof refuses the request rather than guessing the chat. Submission and continuation recheck approved workspace access.

Example Core arguments:

```json
{
  "action": "submit",
  "requestKey": "clip-range-fix-001",
  "workspace": "C:\\Worktrees\\spiffy-deepai-media",
  "prompt": "Repair clip range validation in the assigned module. Run the relevant tests and report the actual changed files and results."
}
```

`deepai_helper action=readiness` accepts an optional native `model` without a job. The CLI equivalent is `node scripts/deepai-helper.mjs readiness --model deepai/deepseek-v4.1-flash --no-worker`. It checks that exact model and returns at most 16 eligible native IDs through the same free-model guard used at dispatch. It never silently selects an alternative, starts a worker or runs inference; eligibility is checked again when actual work dispatches. Default readiness still checks the configured default GLM model.

The durable parent registration is saved before CLI dispatch. Lost responses retain the same request key and native job identity. Later ordinary outer Core calls can receive a short, explicitly nonhuman helper notice with its job ID and report path. The full result remains accessible through `deepai_helper action=result`; notices do not mark requirements verified. Pending native approvals/questions are surfaced for inspection in DeepAI Code, with no approval/answer action exposed by this tool.

Passive notices respect account pause, parent Off state and command capability. They never start a bridge worker, send browser input, interrupt an answer or open another parent chat. Existing Goal/Loop activity must supply the next Core call. A parent that is idle or stuck keeps an unread result until a legitimate later call or explicit inbox inspection.

Passive `status`/`result`/`inbox` reads also expose a missing or stale bridge worker. On a later eligible response the exact parent can receive a recovery notice for that retained job, including native connection failures. `recover` requires an owned job and invokes the existing shared queue worker-start check through CLI status. It never creates a replacement job, clears Pause/Off, steals a live PID/lease, or answers native requests. A response with `recoveryRequested=true` acknowledges only that check; poll the same job for actual recovery. A stale live worker requires Codex process review through CLI health before any termination. No timer, general message pump or automatic idle-parent wake is added.

**Pause scope is explicit:** CoS Pause/Off blocks new Core submissions and passive notices, and holds registered Core jobs that have not been dispatched. The bridge reads the existing account config, durable chat switches and exact parent registration before admission and again after asynchronous native preparation. It uses the isolated account's `runtime/config.json` when applicable. Missing/corrupt/redirected control files refuse admission with `parent_control_unverified`; Pause, Off and command capability holds have separate `waitingFor` reasons. Manual CLI labels have no authenticated CoS control owner and keep their explicit CLI lifecycle.

Already-dispatched work remains observable and can finish/save while paused. Explicit `cancel` requests stop the exact native run; unsent cancellation settles even offline. Deliberate Resume releases the same queued job and native command IDs. Ambiguous submissions are inspected while held, but no launch is retransmitted until admission returns. This is a dispatch hold, not transactional interruption of active native execution. Native Stop/cancellation still needs a terminal receipt. Completed-task notices are withheld until the report is saved; failure outcomes without a report remain visible. Live multi-profile control acceptance is still required.

**These Core changes require a matching CoS build and activation.** Editing this checkout does not update the running desktop, extension or tool catalog. The CLI/native acceptance below does not establish that installed multi-profile delivery works. This fork lacks upstream's documented generic Local Control API; no guessed HTTP send route or operator-input impersonation is used.

## Requirements and shared state

- Keep **DeepAI Code 0.3.36 or 0.3.37** running and signed in. The client requires orchestration protocol **2**; an unreviewed version is refused before new native work. A closed app or unsupported build leaves pending work waiting for a usable connection.
- Run commands from the checkout containing the helper scripts, using its existing dependencies and Node 24; local validation used **Node 24.19.0 on Windows**. No desktop rebuild or installer is needed for these CLI scripts.
- Native discovery/credential-command defaults and installed acceptance currently target Windows. Portable Core declarations are not macOS native acceptance; a Mac runtime layout and activation need separate validation.
- The default state directory is `%USERPROFILE%\.cos-deepai-bridge`, containing `state.sqlite` and `worker.log`. All Chrome profiles and callers using the same Windows user share that directory and queue. Use the same checkout and state directory for the team.
- Every command accepts `--state-root PATH`. Reserve a separate root for isolated tests or deliberate separate instances: separate roots have separate queues and cannot enforce one shared two-helper budget.
- `owner` is a stable correlation label, such as a CoS workstream/task identifier. It prevents accidental access using the wrong label; it is **not authenticated ChatGPT identity or a security tenant boundary**. Local callers with access to the same state can supply labels themselves.

The transport issues a short-lived local client credential with `orchestration:read` and `orchestration:operate` scopes, and revokes it when the connection closes. It does not read the upstream DeepAI account key or use an inference gateway.

## Submit a task

Create a UTF-8 JSON file such as `helper-request.json`. The workspace must already exist. Use a separate worktree when a helper will edit files while CoS or another agent edits the main project.

```json
{
  "owner": "spiffy-editor/media-workstream",
  "requestKey": "clip-range-fix-001",
  "workspace": "C:\\Worktrees\\spiffy-deepai-media",
  "title": "Repair clip range validation",
  "prompt": "Read the workspace instructions. Repair clip range validation in the assigned module. Preserve existing behavior outside this task. Run the relevant tests and report changed files, actual command results and unresolved issues.",
  "model": "deepai/glm-5.3-flash",
  "maxRunMinutes": 20
}
```

| Field | Meaning |
| --- | --- |
| `owner` | Required stable label for the requesting workstream. Use it unchanged for reads, acknowledgement and continuation. |
| `requestKey` | Required key unique within that owner. Reusing the same key and normalized content returns the original job with `reused: true`; different content with the same key is rejected. |
| `workspace` | Required existing directory for a new helper. Supply an absolute path; it is resolved to its real path. |
| `prompt` | Required bounded assignment, including allowed edits and the checks needed. |
| `title` | Optional native chat title; defaults to `CoS DeepAI helper`. |
| `model` | Optional exact native catalog slug; defaults to `deepai/glm-5.3-flash`. |
| `maxRunMinutes` | Optional integer from 1 to 120; defaults to 20. The deadline requests native interruption; it is not proof the run has stopped. |

```powershell
$job = node scripts/deepai-helper.mjs submit --request helper-request.json | ConvertFrom-Json
$jobId = $job.id
$owner = 'spiffy-editor/media-workstream'
```

`submit` durably queues the request and returns its job, native thread and message identities. It does not wait for model completion. Save the job ID with the parent task, continue other useful work, and read status or the inbox at a later tool/turn boundary. Do not create a fresh request key simply because a response was delayed.

### Capacity, workspaces and model selection

The shared queue admits work within a **two-active-DeepAI-helper budget**, counting visible native DeepAI activity, including archived chats that still have work. Waiting requests retain their identity. This is a concurrency budget, not a two-chat history limit or a testing-only role restriction. Manual or unrelated native launches are outside the bridge's launch control and can consume the available capacity.

Only one bridge-managed DeepAI job runs in a given real workspace at a time. A completed native chat with continuing background activity keeps that workspace reserved until the activity settles. **That serialization does not lock out CoS, Codex, the editor or another process.** Use a dedicated worktree for concurrent writes, specify the expected revision and assigned files in the prompt, and let the integration owner review the actual diff.

Before dispatch, the free-only guard requires one enabled, installed, ready DeepAI provider and one exact noncustom catalog model with `theosPerRequest` equal to numeric `0` or string `"0"`, plus advertised `thinking=high`. It does not select a paid model or silently substitute another model. Another explicit DeepAI model slug is allowed only if it passes the same guard. Availability is checked against the app's catalog; this is not a promise of permanent free access or unlimited simultaneous runs.

## Read, collect and acknowledge

```powershell
node scripts/deepai-helper.mjs status --job $jobId --owner $owner
node scripts/deepai-helper.mjs inbox --owner $owner
node scripts/deepai-helper.mjs result --job $jobId --owner $owner
```

`status` reports queue/native state, IDs, progress time, waiting reason, worker health, recovery guidance, errors and whether workspace result files were saved. `inbox` returns up to 50 unacknowledged terminal outcomes plus jobs needing native attention or worker/native/control recovery for that owner. This includes `blocked` or `cancelled` jobs that have no assistant result. Ordinary healthy queued/active jobs remain accessible through their returned job ID.

`attention` contains bounded pending approval/question/authentication summaries with an exact-run identity and stable fingerprint. Raw command inputs, answers and credential values are not copied into these summaries. An incomplete projection preserves prior attention and reports `attentionUnavailableReason`; it never falsely clears a pending request. The installed app may still call a run `running` while an approval waits, so the bridge also checks graph completeness and native attention signals. It uses the full HTTP projection when the bounded WebSocket view cannot establish the answer.

When a collected response exists, `result` returns its assistant text in pages: **8,000 characters by default**, at most **16,000 per call**. Follow `nextOffset` until it is `null`; `totalCharacters` describes the complete retained assistant text. A terminal outcome without a collected response returns job status without inventing an answer or result files.

```powershell
node scripts/deepai-helper.mjs result --job $jobId --owner $owner --offset 8000 --limit 16000
```

Collected output is retained in the local state and written inside the submitted workspace:

```text
WORKSPACE/.cos-deepai/results/JOB_ID/result.json
WORKSPACE/.cos-deepai/results/JOB_ID/report.md
```

`result.json` retains the exact native run/message identities, assistant response and available tool evidence. `report.md` is the readable handoff. Native tool bodies may be omitted or truncated by DeepAI; these files are not a complete execution archive. A collection or file-save failure is reported explicitly. `status` and `result` attempt to save an already collected result if successful saving has not been confirmed.

After the parent has consumed the terminal outcome and any accompanying report:

```powershell
node scripts/deepai-helper.mjs ack --job $jobId --owner $owner
```

`ack` accepts any terminal outcome and removes it from the unread inbox, including a blocked or cancelled job without a result. It keeps any saved files and history, and **does not certify the work or mark the parent requirements accepted**. Active work cannot be acknowledged as finished. Core first validates the exact saved report directory and durably captures any confirmed publication witness, then requests native ACK. Local ACK requires native confirmation; failed final writes can reconcile the same job after restart. New admissions reserve receipt space. If disposable cached metadata is compacted near the limit, known jobs refresh passively by their retained IDs; an unavailable observation never authorizes replacement work.

| Job state | What it establishes |
| --- | --- |
| `queued` | Durable local intent; native work may not have started. `waitingFor` can identify capacity or workspace contention. |
| `submitting` | The stable native submission is being reconciled; acceptance may be uncertain. |
| `active` / `waiting` | An exact native run was observed. `waiting` can require attention in DeepAI. |
| `stopping` | Cancellation/interruption is pending; work may still be active. |
| `completed` | Native completion and an assistant response were collected. File saving is separately reported by `resultSaved`. |
| `incomplete` | Native completion had no final assistant response. |
| `failed` / `cancelled` / `blocked` | The request did not produce an ordinary successful completion; inspect `lastError`, native state and any collected result. |

**Task completion and verification are separate.** Collected results carry `independentVerification: "required"`; `result` exposes this as `verification`. The parent must inspect changed files and independently run the relevant checks before integration. An assistant's statement that tests passed is not itself a passing test receipt.

## Continue the same native chat

Create `helper-followup.json` with the same owner, a new request key and the next prompt:

```json
{
  "owner": "spiffy-editor/media-workstream",
  "requestKey": "clip-range-followup-002",
  "prompt": "Continue this same task. Add a regression test for the remaining edge case identified in the saved report, then run the focused suite.",
  "maxRunMinutes": 20
}
```

```powershell
node scripts/deepai-helper.mjs continue --job $jobId --request helper-followup.json
```

Continuation requires the previous job to be `completed`, with its collected result saved to the workspace and no pending continuation in that native thread. It creates a new local job/message for the **same native thread** and inherits its workspace and pinned model. An explicit different workspace or model is rejected; create a separate helper for a different model. Save the newly returned job ID for subsequent reads or continuation. The default run deadline is 20 minutes unless supplied again.

## Cancel, check health and recover

```powershell
node scripts/deepai-helper.mjs cancel --job $jobId --owner $owner
node scripts/deepai-helper.mjs health
node scripts/deepai-helper.mjs recover
```

`cancel` records cancellation intent. A job still in the local queue can be cancelled without a model call. An accepted native run requires native interruption/cancellation and later observation of its terminal state. Check `status`; a request acknowledgement or `cancelRequested: true` is not a stop receipt. Cancellation does not undo file changes already made.

CLI operations normally call the existing worker-start check. When pending work or unsaved results exist, they start a detached worker if its recorded process is no longer alive. `recover` explicitly invokes that same recovery path; it does not create replacement tasks. Add `--no-worker` to `status`, `result`, `inbox`, `health` or `ack` for passive inspection that never starts or recovers native execution. The Core delivery hook always uses this passive path. The worker exits when its queue and save obligations settle. `health` reports the saved worker snapshot before that start check, so another health call may be needed to observe a newly started worker. `submit`/`continue` also accept `--request -` for a private JSON request on stdin.

The durable queue preserves native command/thread/message IDs across reconnects. Recovery inspects accepted work and retains the existing receipt identities. Do not erase state or submit a replacement with new IDs to clear an ambiguous send. A stale heartbeat with a still-live PID is reported for inspection; `recover` does not kill a live process or steal its lease.

Keep DeepAI running during execution and collection. A rejected local credential (HTTP 401) triggers a connection rebuild using the same limited scopes, followed by inspection of the original job. A permission denial does not widen scopes. This is local-client recovery; it does not bypass an account login requirement. After a worker/process restart, a later explicit CLI operation can recover its queue; no Windows startup service or always-running CoS supervisor is installed. A completed helper remains available while the parent is idle; normal Core activity can deliver its notice after activation, but the helper does not resume CoS itself.

## Local validation boundary

Windows acceptance on **13 November 2026**, using DeepAI Code **0.3.36**, completed **12 native helper jobs**, with **12/12 owner markers matched** and **12/12 workspace result sets saved**. Observed peak native concurrency was **two**. The GLM implementation job took about **17.6 seconds**, the DeepSeek regression-test job about **60 seconds**, and ten bounded reasoning jobs about **9–12 seconds each**. These are observations from this workload, not throughput guarantees.

**The run used twelve owner labels from one CoS driver. It did not exercise six independent Chrome profiles or twelve simultaneous native executions.** The new parent-bound Core path requires installed two-profile acceptance before expansion. Automatic parent wake-up is intentionally still owned by existing Goal/Loop/recovery mechanisms.

Further live checks in `DeepAI-Integration-Validation/phase2` passed:

- `auth-recovery.json`: revoked only the probe's newly issued local client credential, observed HTTP 401, reissued the same limited scopes, re-read the same saved native thread/run and verified unchanged send attempts. No new model run was created; both local clients were retired.
- `attention/attention-live.json`: one new GLM/high fixture chat with stricter `approval-required` mode produced the actual `Allow write?` file-change card. The normalizer reported one pending request. Zero answers were sent; exact-run cancellation was observed as `interrupted`, pending attention cleared and the proposed file was never written. No account/default permission policy was changed.

The opt-in probes are `scripts/deepai-auth-live.mjs` and `scripts/deepai-attention-live.mjs`. They are manual acceptance tools, not automatic CI model calls. Focused offline checks are available through `npm run test:deepai:queue`, `npm run test:deepai:client` and `npm run test:deepai:core`. Packaging includes the helper modules plus `ws` outside the asar, and a resource smoke test runs those copied resources independently from the checkout. This is dependency validation, not installed desktop activation proof.

Separate live checks covered the following boundaries:

- **Continuation:** the same DeepSeek native chat and pinned model returned the exact earlier session marker, corrected the code and expanded the regression suite. An independent run passed all **9/9 tests**.
- **Worker recovery:** the verified bridge-worker process was terminated while a native run was in progress. `recover` started a replacement bridge worker and collected completion from the same native thread, message and run ordinal. No new native chat was created; the local job retained one recorded send attempt. This tests a bridge-worker interruption, not termination of DeepAI or a full Windows restart.
- **Cancellation:** an automated request was issued about 0.2 seconds after the test child process started. DeepAI reported the native run interrupted about 1.8 seconds after that request, the cancelled result was saved, the child process was gone, and its delayed `late.txt` output remained absent after the 45-second observation window. An earlier attempt missed the cancellation window and honestly returned `completed`; it is not counted as a successful cancellation. These timings describe this test, not a general stop-time guarantee.

Implementation and regression owners: [helper CLI](../scripts/deepai-helper.mjs), [durable helper state](../scripts/deepai-helper-state.mjs), [native client](../scripts/deepai-native.mjs), [helper queue/lifecycle tests](../scripts/deepai-helper.test.mjs), and [native transport tests](../test/deepai-native.test.ts).


## Readiness, blockers and linked receipts

Core `deepai_helper action=readiness` verifies the exact caller and current account/chat controls, packaged CLI/Node availability, supported native version/protocol, sign-in/local-client connectivity and exact zero-cost default model. CLI `node scripts/deepai-helper.mjs readiness --no-worker` checks only the native side. Neither creates a task, starts the queue process or performs inference. A preflight is a point-in-time observation; existing queue admission still rechecks parent controls and model eligibility immediately before dispatch. A successful native check does not prove loaded browser generations or end-to-end parent routing. Those remain deployment acceptance gates.

Status/result/inbox expose a bounded `blocker` with `code` and an actionable next step. Distinguish deliberate parent Pause/Off, disabled commands, unverified parent custody, two-slot capacity, occupied workspace, native attention, native availability, missing/stale queue process and report-save failure. Never turn an approval/sign-in request into an automatic permission change. Unknown native waits retain an exact job and diagnostic rather than inventing completion. Existing SQLite events and queue logs retain transitions; no new log service or polling conversation is installed.

Core responses include a `receipt` joining the original parent session/conversation/request, hashed request key, current/previous job, native thread/run/command, saved report path/time, witnessed notice publication and explicit acknowledgment. `noticePublishedAt` is recorded only after the existing publication witness confirms delivery and a subsequent eligible Core call observes it; a pending/failed publication stays unconfirmed. Completion notices require saved reports. Acknowledging a completed unsaved report is refused. Native outcomes and delivered notices do not replace independent patch/test verification. All receipt fields are restricted to the registered parent; no cross-account task census is exposed.

## Versioned isolated-profile deployment while the personal account stays open

The ordinary NSIS updater requires the installed program to exit and must not run while the operator protects an old personal-account process. The existing `scripts/install-custom.ps1` owner now exposes `Invoke-QualifiedProfileDeployment` for this case. It takes the final pinned candidate, exact selected isolated profile IDs and the protected personal PID/creation generation. It independently verifies installer/unpacked payload identity, copies the immutable program to a sibling `Programs/Chat On Steroids Qualified/<source-commit>` directory, verifies the complete tree and embedded program integrity, and atomically publishes each selected profile's `runtime/state/qualified-program.json`. It never invokes NSIS, changes uninstall registry records, stops a process, or launches/resumes work.

The canonical personal-account installation remains untouched. Only registered isolated profiles can be bound; an active target profile, changed protected process, redirected directory or altered existing program refuses deployment. A repeated identical completed deployment is idempotent. A different prior binding requires an explicit per-profile ExpectedBindingSha256 baseline and a closed target profile. The owner rechecks that baseline immediately before atomic replacement and preserves its exact previous receipt under a content-addressed filename. No live profile or mismatched baseline is overwritten. Failed unpublished staging remains identified in the diagnostic; no computed recursive removal occurs.

Both `queue-chat.mjs` and `workflow-queue.mjs` use `installed-app.mjs`. For a bound profile it verifies exact profile/root, strict provenance and EXE/ASAR/provenance hashes, then checks the incumbent native process inventory. A differently rooted or ambiguous warm owner refuses before request publication; each launch rechecks routing. Invalid/missing program bytes do not silently fall back to old code. An absent binding retains the ordinary installer path; the personal legacy account always retains that path. Old personal-app UI or third-party shortcuts do not understand these new bindings: if they cold-start old code for an isolated profile, the updated operator client refuses it. Use the bound client or the already-running qualified instance for the trial. Process preflight is not an atomic provider-delivery proof; retain native input/result receipts and reconcile any later crash/race.

Activation is explicit after full program verification. Launch only the selected executable/profile with preserved global Pause, verify actual PID/path/source and capabilities, then qualify browser worker/content/MAIN separately. A disk install, identical version label, launch PID or connected Core endpoint is insufficient evidence of loaded Chrome bytes or successful helper delivery. The integration chat owns the two NEW parent test sends. Keep old scope switches and uncertain inputs intact; do not Resume a profile blindly because the package is current. The existing one-hour Goal readiness fallback and two-hour bounded Codex review have different owners and are not duplicate unconditional Continue timers.

## CoS-led planning workflow

CoS can remain the primary implementer while selected helpers provide bounded read-only planning or review. A shared planning workspace keeps these helpers in one native project without moving production repositories. Pass its path as `workspace`, put the exact target scope and bounded source excerpts in the request, and keep production edits with the parent. The parent continues useful independent work when a helper is waiting or unavailable, then reads the saved terminal result and acknowledges only what it handled. Do not require helpers for every task or launch another Codex/OpenCode coordinator.

Native project grouping is distinct from workspace access. The native `thread.metadata.update` move uses `expectedProjectId` and preserves the effective working directory; active work cannot be moved. Retired completed validation chats can be grouped after checking their terminal runs and retaining exact migration receipts. Remove only empty project entries after checking both active and archived chats; retain source folders and unrelated projects. A grouped historical job must not be continued using its superseded project binding.

A missing Refresh control during page hydration is not proof that an app needs recreation. The source reader now waits within its existing eight-second hydration budget before reporting that condition; one native claim still owns one click, exact schema comparison still owns completion, and navigation/generation cancels the attempt. Three failure-first controls and both refresh suites pass (98 checks). This follow-up is source-tested and separate from the previously qualified running package; do not restart useful work merely to activate it.
