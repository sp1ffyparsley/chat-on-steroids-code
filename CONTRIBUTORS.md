# Contributors

Chat On Steroids is maintained by [@totec448-spec](https://github.com/totec448-spec) and built with contributions from the community.

Some contributions were adapted into maintainer snapshot commits and their original PRs were closed without preserving GitHub commit attribution. That was our mistake. Reworking a patch does not erase its author's contribution. The record below restores explicit credit and links to the original work.

## Incorporated code and designs

- October24 ordinary event-read batching selectively adapts [@Maximapple](https://github.com/Maximapple)'s [PR1829](https://github.com/totec448-spec/chat-on-steroids/pull/1829), commits [6bcfce1d](https://github.com/totec448-spec/chat-on-steroids/commit/6bcfce1d958fcc1e04feeba8d86ae42b4ef1c9f1) and [aa71137b](https://github.com/totec448-spec/chat-on-steroids/commit/aa71137bdeaeb349c9796e023d0149906f5142d7). Five existing readers await their own journal queue while summary writes remain batched; this fork retains stronger witness/fsync/deletion/shutdown flushes. The regression reuses the existing real-filesystem suite and controls only the batch timer. Integration retains `Co-authored-by: Maxim <5410641+Maximapple@users.noreply.github.com>`.


- October24 real-child polling isolation selectively adapts [@Maximapple](https://github.com/Maximapple)'s [PR1828](https://github.com/totec448-spec/chat-on-steroids/pull/1828), [commit3fe2a0f0](https://github.com/totec448-spec/chat-on-steroids/commit/3fe2a0f0ddf080564b32d4c0001934f5666ad3d2). The existing unread-result capacity test permits ten seconds for real Node startup while retaining its exact output, exit-code, refusal and ownership assertions. This fork already bounds the corresponding result-delivery child wait; no duplicate upstream fixture or production timeout change is imported. Release integration retains `Co-authored-by: Maxim <5410641+Maximapple@users.noreply.github.com>`.

- October24 context-meter compaction-threshold correction selectively adapts [@Maximapple](https://github.com/Maximapple)'s [PR1809](https://github.com/totec448-spec/chat-on-steroids/pull/1809). A positive enabled automatic-compaction threshold becomes the estimate denominator; otherwise the existing large-chat warning remains the denominator. This reuses the local tooltip and does not import upstream dialog/model-order prerequisites or alter compaction policy. Release integration retains `Co-authored-by: Maxim <5410641+Maximapple@users.noreply.github.com>`.


- October24 deterministic integration-test clock isolation adapts [@Maximapple](https://github.com/Maximapple)'s [PR1822](https://github.com/totec448-spec/chat-on-steroids/pull/1822), [commit30d036a2](https://github.com/totec448-spec/chat-on-steroids/commit/30d036a2d95ece2c7ee3257c88de60e3e315cfe1). The test-only seam stops the incumbent recovery sweep before the manually controlled test clock advances; production recovery timing is unchanged. Release integration retains `Co-authored-by: Maxim <5410641+Maximapple@users.noreply.github.com>`.

- October20 replacement-chat guidance, bounded long-task titles and explicit plugin-uninstall confirmation selectively adapt [@Maximapple](https://github.com/Maximapple)'s upstream commits [e3e720fc](https://github.com/totec448-spec/chat-on-steroids/commit/e3e720fc4d6615ffce67e0b46e36de7ca688dcc8), [e58d8c47](https://github.com/totec448-spec/chat-on-steroids/commit/e58d8c47aa840f20354a4dca18cc1a66aa48eed1) and [d139dc90](https://github.com/totec448-spec/chat-on-steroids/commit/d139dc90aaccf68e8805486469decb5f5aeef95e). This fork requires exact or unique historical session ownership before naming a destination, preserves its authored task-label extraction, and reuses its existing plugin action styles. No historical tool/Send authority is restored. Future integration commits must retain the original public noreply co-authorship.

- October20 explicit unloaded-tab attach correction selectively adapts [@hisero-mais](https://github.com/hisero-mais)'s [PR1569](https://github.com/totec448-spec/chat-on-steroids/pull/1569), [commit70a193e7](https://github.com/totec448-spec/chat-on-steroids/commit/70a193e72faac8eea8e74dc5c7a050e9f2d247f5). Only an explicit attach with live browser write permission may restore the same unloaded tab; custom post-authorization target/protection and expiry rechecks remain. No background task revival or permission expansion is added. Release integration must retain the original PR/author co-authorship.

- October20 journal throughput correction selectively adapts [@Maximapple](https://github.com/Maximapple)'s [PR1666](https://github.com/totec448-spec/chat-on-steroids/pull/1666), [commit2aa6a753](https://github.com/totec448-spec/chat-on-steroids/commit/2aa6a7531ef852d89db78a99152b918b85a42822): observations arriving behind a slow extension journal write share one subsequent durable snapshot. The custom adaptation preserves custody/quota owners and adds explicit-barrier acknowledgment coverage. Release integration must retain `Co-authored-by: Maxim <5410641+Maximapple@users.noreply.github.com>`.

- October16 connector-enrollment correction adapts [@Maximapple](https://github.com/Maximapple)'s [PR1576](https://github.com/totec448-spec/chat-on-steroids/pull/1576), [commit b1a77190](https://github.com/totec448-spec/chat-on-steroids/commit/b1a7719086696229a75ae0bcfe7793e46af5364a): tool-only MCP surfaces advertise and answer empty resource/template/prompt catalogs rather than failing modern connector enrollment. The custom adaptation retains Windows' published-surface selection and adds real HTTP legacy/modern, capability, denied read/execution, and unchanged tool-discovery coverage. No approval, attribution or Loop-completion fence is relaxed. Release integration must retain `Co-authored-by: Maxim <5410641+Maximapple@users.noreply.github.com>`.

- October15 local follow-up selectively adapts [@Maximapple](https://github.com/Maximapple)'s unconfirmed-schema guard from [commit 8415b708](https://github.com/totec448-spec/chat-on-steroids/commit/8415b708cebbf3098cc29c642149c5d9d907ba7b). A confirmed schema A cannot suppress a fresh refresh after schema B was authorized without confirmation and A returns. The custom exact account/app, generation and stale-receipt fences are retained. [PR1549](https://github.com/totec448-spec/chat-on-steroids/pull/1549) prompted the review; its separate legacy refresh machinery was not transplanted.

- October 14 custom update selectively adapts [@Maximapple](https://github.com/Maximapple)'s [commit 737de925](https://github.com/totec448-spec/chat-on-steroids/commit/737de92573c6a8643605b4afab8a28ff59681b0e), retaining a manual running-turn correction when preparation times out before Send authorization. The custom adaptation keeps the same delivery UUID and its follower/attachment custody, and excludes helpers, openings, bundles and authorized or ambiguous sends. Other reviewed upstream recovery and helper-size changes were not blindly imported.

- October 10 custom 2.1.33 update selectively adapts [@Maximapple](https://github.com/Maximapple)'s [PR1295](https://github.com/totec448-spec/chat-on-steroids/pull/1295), commit `7c719fee`, so structured exec results retain advisory notes alongside delivery context. [@Haz4rdovisk](https://github.com/Haz4rdovisk)'s [PR1291](https://github.com/totec448-spec/chat-on-steroids/pull/1291), commit `16859e6e`, supplies provider Project-link discovery outside the retired header and exact empty failed-entry tab retirement. Existing custom bounded navigation retries are retained. Its post-dispatch resend heuristic and marker-only draft clearance were not incorporated; this fork retains exact ambiguous-Send and user-draft custody. New positive/negative regressions cover the selected changes.

- @xuan2261's [PR1027](https://github.com/totec448-spec/chat-on-steroids/pull/1027), commit `45426fac`, informed the bounded New Chat opening Retry-After adaptation. This fork retains its exponential/jitter floor and adds malformed-delay/cap coverage; the whole branch was not merged.

Listed alphabetically by GitHub handle. "Adapted" means the implementation changed during integration; it does not mean the entire original branch was merged.

| Contributor | Contribution and original work |
| --- | --- |
| [@absol89](https://github.com/absol89) | Escaped-Markdown and `&#x20;` Compact & Resume bootstrap evidence from ParadigmEve commit [`d9f7391`](https://github.com/absol89/ParadigmEve/commit/d9f7391985c20dbbd525c59cbe8ee251d11895be), selectively adapted into this fork's existing framed prompt and continuation owners. Active exact-duplicate preference for a newly elected durable input was adapted from ParadigmEve commit [`695e4bd`](https://github.com/absol89/ParadigmEve/commit/695e4bd34d0f42055f55c72f27e7f6ec825d1d6b). |
| [@becoolmin](https://github.com/becoolmin) | Preserving window size on reopen: [#122](https://github.com/totec448-spec/chat-on-steroids/pull/122), adapted into [#134](https://github.com/totec448-spec/chat-on-steroids/pull/134). |
| [@Bemirror99](https://github.com/Bemirror99) | Resume-shadow recovery and stale Fiber attribution fixes: merged [#19](https://github.com/totec448-spec/chat-on-steroids/pull/19) and [#20](https://github.com/totec448-spec/chat-on-steroids/pull/20). |
| [@devrajmahar](https://github.com/devrajmahar) | Conversation-scoped generation reset, extracted with an independent SPA recovery regression from [#163](https://github.com/totec448-spec/chat-on-steroids/pull/163). The renderer rewrite and other feature changes were not incorporated. |
| [@Firefulcar](https://github.com/Firefulcar) | Claimed Compact & Resume leases: merged [#33](https://github.com/totec448-spec/chat-on-steroids/pull/33). Selected-browser startup routing: [#100](https://github.com/totec448-spec/chat-on-steroids/pull/100), adapted into [#91](https://github.com/totec448-spec/chat-on-steroids/pull/91). |
| [@frytufrytu](https://github.com/frytufrytu) | Diagnosing and fixing blocked-handoff compaction recovery loops: [#127](https://github.com/totec448-spec/chat-on-steroids/pull/127), adapted with durable refusal and draft preservation into [#134](https://github.com/totec448-spec/chat-on-steroids/pull/134). |
| [@gnustella-lab](https://github.com/gnustella-lab) | Brave Browser support: merged [#106](https://github.com/totec448-spec/chat-on-steroids/pull/106). |
| [@Gokuencinar](https://github.com/Gokuencinar) | Recorder-lifetime ownership for native click, submit and Enter send observation, adapted through [#548](https://github.com/totec448-spec/chat-on-steroids/pull/548) from the reliability slice of [#392](https://github.com/totec448-spec/chat-on-steroids/pull/392). |
| [@Haz4rdovisk](https://github.com/Haz4rdovisk) | Durable exact managed-tab removal receipts across MV3 suspension and later manual-close precedence, adapted from mainstream commit [`d3ede45`](https://github.com/Haz4rdovisk/chat-on-steroids-mainstream/commit/d3ede4567b60ff5a4ff866d5478fe289e422603c) while retaining this fork's stricter selected-main and browser-exit safeguards. The complete request-owner ledger and pre-ack durability barrier were adapted from mainstream commit [`e6755d9`](https://github.com/Haz4rdovisk/chat-on-steroids-mainstream/commit/e6755d9) through official upstream commit [`89107d6`](https://github.com/totec448-spec/chat-on-steroids/commit/89107d66db85e3bcf2a0288ee9dfff2b50a58c99), while retaining this fork's existing first-proof/session-epoch owner. Setup draft persistence before Connect was adapted from [#345](https://github.com/totec448-spec/chat-on-steroids/pull/345) through its upstream completion in [#500](https://github.com/totec448-spec/chat-on-steroids/pull/500). The explicit plugin About/Setup disclosure chevron was adapted from official commit [`f9aef82`](https://github.com/totec448-spec/chat-on-steroids/commit/f9aef823c76a0b19dcab61068244c32567cad2fb). |
| [@hhh2210](https://github.com/hhh2210) | Native macOS Desktop backend and platform validation: merged [#28](https://github.com/totec448-spec/chat-on-steroids/pull/28). Desktop reply provenance, activity details, editable folder access and the bounded bridge RFC: merged [#74](https://github.com/totec448-spec/chat-on-steroids/pull/74), [#75](https://github.com/totec448-spec/chat-on-steroids/pull/75), [#77](https://github.com/totec448-spec/chat-on-steroids/pull/77), [#43](https://github.com/totec448-spec/chat-on-steroids/pull/43). Companion mismatch guidance: [#101](https://github.com/totec448-spec/chat-on-steroids/pull/101), adapted into [#91](https://github.com/totec448-spec/chat-on-steroids/pull/91). |
| [@Inmerson](https://github.com/Inmerson) | Fresh worker placement through the Prime's extension context, background tabs and a single fallback owner: [#72](https://github.com/totec448-spec/chat-on-steroids/pull/72), adapted for batch-safe placement. Independent screenshot coordinate assertions: [#201](https://github.com/totec448-spec/chat-on-steroids/pull/201). Preserving existing Goal/Loop recovery through provider access limits: [#227](https://github.com/totec448-spec/chat-on-steroids/pull/227), adapted to retain the original recovery deadline across repeated notices. |
| [@JeshuaCastro](https://github.com/JeshuaCastro) | Per-worker model and reasoning selection design: [#68](https://github.com/totec448-spec/chat-on-steroids/pull/68). The incorporated design was completed by the schema correction in [#87](https://github.com/totec448-spec/chat-on-steroids/pull/87) through [#91](https://github.com/totec448-spec/chat-on-steroids/pull/91). |
| [@K4viar](https://github.com/K4viar) | Keeping the recorder's Compact & Resume admission wait within the existing claim window: adapted from [#224](https://github.com/totec448-spec/chat-on-steroids/pull/224), with independent delayed-commit, cancellation and expiry regressions. The Project-click retries were not incorporated. |
| [@k-spit](https://github.com/k-spit) | Restart-safe stream request attribution, composer reacquisition after model selection, and exact early fresh-worker binding: [#464](https://github.com/totec448-spec/chat-on-steroids/pull/464), [#470](https://github.com/totec448-spec/chat-on-steroids/pull/470), and [#474](https://github.com/totec448-spec/chat-on-steroids/pull/474), adapted into this fork's stricter send/route fencing. |
| [@lookvincent](https://github.com/lookvincent) | Native ChatGPT artifact downloads and custom OpenAI-compatible Goal/Loop providers: [#94](https://github.com/totec448-spec/chat-on-steroids/pull/94) and [#95](https://github.com/totec448-spec/chat-on-steroids/pull/95), adapted into [#91](https://github.com/totec448-spec/chat-on-steroids/pull/91). |
| [@Maximapple](https://github.com/Maximapple) | Merged fixes for public-history scope, Project routes, swapped mouse buttons, tunnel readiness, access limits, RTL text, Linux packaging, complete session enumeration and continuation relays: [#37](https://github.com/totec448-spec/chat-on-steroids/pull/37), [#38](https://github.com/totec448-spec/chat-on-steroids/pull/38), [#79](https://github.com/totec448-spec/chat-on-steroids/pull/79), [#110](https://github.com/totec448-spec/chat-on-steroids/pull/110), [#116](https://github.com/totec448-spec/chat-on-steroids/pull/116), [#117](https://github.com/totec448-spec/chat-on-steroids/pull/117), [#131](https://github.com/totec448-spec/chat-on-steroids/pull/131), [#139](https://github.com/totec448-spec/chat-on-steroids/pull/139), [#141](https://github.com/totec448-spec/chat-on-steroids/pull/141), the whole-page conversation-load Retry watchdog [#429](https://github.com/totec448-spec/chat-on-steroids/pull/429) and persistent retry cadence [#450](https://github.com/totec448-spec/chat-on-steroids/pull/450), the extension-owned tab-departure distinction [#446](https://github.com/totec448-spec/chat-on-steroids/pull/446), later hardened and merged with durable exact-removal evidence in [#498](https://github.com/totec448-spec/chat-on-steroids/pull/498), Setup draft persistence before Connect in [#500](https://github.com/totec448-spec/chat-on-steroids/pull/500), truthful worker-report delivery wording in [#503](https://github.com/totec448-spec/chat-on-steroids/pull/503), account-catalog Goal/Loop helper fallback in [#521](https://github.com/totec448-spec/chat-on-steroids/pull/521), and the ended-turn automatic-compaction receipt from [#860](https://github.com/totec448-spec/chat-on-steroids/pull/860), adapted into this fork's stronger source/document and tool-drain fences. Exact-delivery retry over its own leftover composer text was selectively adapted from community commit [`68c106b`](https://github.com/Gokuencinar/chat-on-steroids/commit/68c106ba4fa7240d97e048eb759fba90f4eb4d2c). Adapted work on handoff lifetime, macOS sealing, Project successors, worker schemas, custom instructions and caller-evidence waits: [#39](https://github.com/totec448-spec/chat-on-steroids/pull/39), [#80](https://github.com/totec448-spec/chat-on-steroids/pull/80), [#86](https://github.com/totec448-spec/chat-on-steroids/pull/86), [#87](https://github.com/totec448-spec/chat-on-steroids/pull/87), [#88](https://github.com/totec448-spec/chat-on-steroids/pull/88), [#115](https://github.com/totec448-spec/chat-on-steroids/pull/115). Recent exact-tool activity as truthful Working-state evidence: [#409](https://github.com/totec448-spec/chat-on-steroids/pull/409), adapted without inventing turn or Stop authority. The profile-local browser custody, exact pre-authorization composer-remount rebind, and stale-final turn fence were selectively adapted from official commits [`10ecf80`](https://github.com/totec448-spec/chat-on-steroids/commit/10ecf80405040b6625ffc9232e8611ddbc2d5081), [`73f76ab`](https://github.com/totec448-spec/chat-on-steroids/commit/73f76ab88454b36b6f5764199b3397c18362bdd7), and [`4d25a82`](https://github.com/totec448-spec/chat-on-steroids/commit/4d25a82180dfb90a13bc566443f039454b7e4cc1), while retaining this fork's account-instance, Core-token, receipt, route, and authorization fences. Existing-chat browser custody, same-turn proven-chat exclusion from Unattributed recovery, and interface-language number/time formatting were adapted from official commits [`beb596b`](https://github.com/totec448-spec/chat-on-steroids/commit/beb596b0cd5012a338aa715b99f8803e7241c373), [`614583e`](https://github.com/totec448-spec/chat-on-steroids/commit/614583ed6f51afe321374dcd65f63762b383f93d), and [`7637654`](https://github.com/totec448-spec/chat-on-steroids/commit/76376545961f83fa78fed96963d306073096a02e). |
| [@nofihq](https://github.com/nofihq) | Waiting for late exact `session_finish` identity while sharing one bounded deadline with the finish hold: adapted from [#220](https://github.com/totec448-spec/chat-on-steroids/pull/220). Other response-branch and inbox changes were not incorporated. |
| [@PatrickSys](https://github.com/PatrickSys) | Windows installer sandbox folder permissions: [#62](https://github.com/totec448-spec/chat-on-steroids/pull/62), incorporated into the 2.0.6 snapshot and retained in [#91](https://github.com/totec448-spec/chat-on-steroids/pull/91). |
| [@pop15106](https://github.com/pop15106) | Correcting the unconditional Codex-quota claim in the README and hero: [#192](https://github.com/totec448-spec/chat-on-steroids/pull/192), adapted with current official usage documentation. |
| [@redzrush101](https://github.com/redzrush101) | Exact broker-state classification for the Sub-agents Active/History split, selectively adapted from the reliability portion of [#487](https://github.com/totec448-spec/chat-on-steroids/pull/487) without importing its unrelated workspace/timeline visual changes. |
| [@totec448-spec](https://github.com/totec448-spec) | Direct browser-control broker, extension lease handling, browser tools, and their focused regressions were selectively adapted from upstream workspace snapshot [#261](https://github.com/totec448-spec/chat-on-steroids/pull/261) / commit [`608d72f`](https://github.com/totec448-spec/chat-on-steroids/commit/608d72f16f4b3e246697563b326a24693b6b056f), while retaining this fork's queue, recovery, and Chrome-hygiene behavior. |
| [@TaeyanG4](https://github.com/TaeyanG4) | Handling plugin schemas when a Refresh control is unavailable: [#92](https://github.com/totec448-spec/chat-on-steroids/pull/92), adapted into [#91](https://github.com/totec448-spec/chat-on-steroids/pull/91). |
| [@ventianima-lab](https://github.com/ventianima-lab) | Preserving the exact message, conversation and page-epoch identity accepted by a desktop-send ACK when later canonical text differs, so the same send retains its turn-start boundary: adapted from the [code and regression tests in #185](https://github.com/totec448-spec/chat-on-steroids/issues/185#issuecomment-5647883368). This narrow repair does not reconstruct earlier missing history or resolve every symptom in the issue. |
| [@WanxTitanx](https://github.com/WanxTitanx) | Preserving an elected desktop-input tab when ChatGPT hydration strips its `cos-input` marker, plus current plugin-settings route recognition: [#410](https://github.com/totec448-spec/chat-on-steroids/pull/410), adapted to retain this fork's stricter Temporary Chat and exact-document proof. |
| [@xuan2261](https://github.com/xuan2261) | Versioned handoff provenance and exact continuation-transaction recovery binding from [#1024](https://github.com/totec448-spec/chat-on-steroids/pull/1024), selectively adapted in custom commit `5697ab00`. The adaptation retains committed session rebind authority, legacy handoff compatibility, and this fork's additional restore-validation regressions. This records source integration, not installed or live recovery proof. |
| [@yahiaal](https://github.com/yahiaal) | Publishing larger Plugins catalogs within the existing schema byte budget: [#216](https://github.com/totec448-spec/chat-on-steroids/pull/216), adapted to include the optional local code-mode tool in refresh observation and legacy enrollment. |

The September 28 live-turn/helper repair adapts [@Haz4rdovisk](https://github.com/Haz4rdovisk)'s
recorder-lifetime completion of [#548](https://github.com/totec448-spec/chat-on-steroids/pull/548)
and [@Maximapple](https://github.com/Maximapple)'s remounted-turn, helper-correlation and bounded
tool-count fixes from [#549](https://github.com/totec448-spec/chat-on-steroids/pull/549).

The September 12 repair snapshot also adapts [@Maximapple](https://github.com/Maximapple)'s
destination loading guard ([#164](https://github.com/totec448-spec/chat-on-steroids/pull/164)),
expired automatic resume claim release ([#165](https://github.com/totec448-spec/chat-on-steroids/pull/165)),
nested user-message text fix ([#179](https://github.com/totec448-spec/chat-on-steroids/pull/179)) and
disabled-permission guidance from [#146](https://github.com/totec448-spec/chat-on-steroids/pull/146).
The claim release was strengthened with durable command/document ownership; this does not
incorporate the rest of the native Desktop proposal.

The October 3 slow Compact & Resume destination ownership repair adapts
[@m1d0e1](https://github.com/m1d0e1)'s [#1011](https://github.com/totec448-spec/chat-on-steroids/pull/1011),
with an additional failed-persistence regression. This is source integration, not installed/live proof.

The October 6 recovery-diagnostics slice adapts [@Maximapple](https://github.com/Maximapple)'s
automatic Continue withdrawal reasons from [#1079](https://github.com/totec448-spec/chat-on-steroids/pull/1079)
and no-fleet recovery warning correction from [#1157](https://github.com/totec448-spec/chat-on-steroids/pull/1157).
The silence-wait reason projection follows the diagnostic approach discussed in
[#1086](https://github.com/totec448-spec/chat-on-steroids/issues/1086), while retaining this fork's
existing delivery and local-tool fences. This does not import #1151's bounded unknown-call bypass.

## Reports, review and proposed work

[@ferrarinobrakes](https://github.com/ferrarinobrakes) reported the replacement-session collision
in [#218](https://github.com/totec448-spec/chat-on-steroids/issues/218), which led to the delayed
resume-commit regression and recorder admission fix.

[@ventianima-lab](https://github.com/ventianima-lab)'s reproductions also led to the focused
resume-selection ([#155](https://github.com/totec448-spec/chat-on-steroids/issues/155)) and Windows
plugin-path ([#178](https://github.com/totec448-spec/chat-on-steroids/issues/178)) repairs.

The receipt-promotion and adopted-answer ownership fixes adapt
[@ventianima-lab](https://github.com/ventianima-lab)'s minimal reproductions and proposed repairs
in [#185](https://github.com/totec448-spec/chat-on-steroids/issues/185#issuecomment-5650663451)
and its [remounted-answer follow-up](https://github.com/totec448-spec/chat-on-steroids/issues/185#issuecomment-5651819276).
[@rcnir](https://github.com/rcnir) reported the unknown-model recovery gap in
[#172](https://github.com/totec448-spec/chat-on-steroids/issues/172), and
[@Gauthammaster2012Code](https://github.com/Gauthammaster2012Code) reported the plan-collapse
affordance issue in [#191](https://github.com/totec448-spec/chat-on-steroids/issues/191).

Contributions also include reproductions, independent testing, designs and patches that are still under review or were superseded. Thank you to:

- [@ventianima-lab](https://github.com/ventianima-lab) for detailed request-attribution and delivery investigations and controller, stream-observation and tab-reuse proposals, including [#108](https://github.com/totec448-spec/chat-on-steroids/issues/108), [#124](https://github.com/totec448-spec/chat-on-steroids/pull/124), [#159](https://github.com/totec448-spec/chat-on-steroids/pull/159) and [#170](https://github.com/totec448-spec/chat-on-steroids/pull/170).
- [@nofihq](https://github.com/nofihq) for independent Linux validation on [#159](https://github.com/totec448-spec/chat-on-steroids/pull/159) and [#170](https://github.com/totec448-spec/chat-on-steroids/pull/170), and the recovery investigations in [#175](https://github.com/totec448-spec/chat-on-steroids/pull/175) and [#183](https://github.com/totec448-spec/chat-on-steroids/pull/183).
- [@piotrczukwinski](https://github.com/piotrczukwinski) for the localized model-picker investigation and structural discovery proposal in [#102](https://github.com/totec448-spec/chat-on-steroids/pull/102).
- [@L4XB](https://github.com/L4XB) for pinned-tab protection work and the distinction between pinned-tab and active-conversation closure in [#158](https://github.com/totec448-spec/chat-on-steroids/pull/158).
- [@ahrorbeksoft](https://github.com/ahrorbeksoft) for the macOS tray/window lifecycle proposal in [#93](https://github.com/totec448-spec/chat-on-steroids/pull/93).
- [@Akilaydin](https://github.com/Akilaydin) for reviewing the fallback race and clarifying browser placement in [#72](https://github.com/totec448-spec/chat-on-steroids/pull/72).
- [@lavalava45](https://github.com/lavalava45) for regional artifact-host reproductions in [#111](https://github.com/totec448-spec/chat-on-steroids/issues/111).

This is a growing attribution record, not a complete list of everyone who has helped. The [PR history](https://github.com/totec448-spec/chat-on-steroids/pulls?q=is%3Apr) and [issue history](https://github.com/totec448-spec/chat-on-steroids/issues?q=is%3Aissue) retain other submissions and discussions. Acknowledging a proposal here does not claim it was merged.

## Preserving credit

The October 10 v2.1.32 selective integration retains this fork's custom receipt and permission
owners. It adapts [@Haz4rdovisk](https://github.com/Haz4rdovisk)'s route takeover (#1250,
`74fab3c6`) and exact late-work Stop (#1237, `0d3e8f4b`); [@Maximapple](https://github.com/Maximapple)'s
native running-turn steering (`9784619c`, `bc088ed3`, #1235 `eef582d1`), whole usage counts/partial-price
display (`fd06fb77`) and schema-confirmed refresh reminders (#1243, `9947abbb`, `a70575fa`);
[@Akilaydin](https://github.com/Akilaydin)'s nonfatal plugin JSON-RPC errors (#1229, `d58e9b5a`);
and [@m1d0e1](https://github.com/m1d0e1)'s read-only choice cards (#1246, `574e0b52`).
Choice rendering adds local privacy/hidden-content regressions rather than replaying provider controls.
No public release binary replaced this custom build. Future authorized integration commits must
retain appropriate public GitHub noreply co-author trailers; this source pass does not create a commit.

The October 6 Windows UTF-8 BOM settings repair adapts
[@Maximapple](https://github.com/Maximapple)'s [#1174](https://github.com/totec448-spec/chat-on-steroids/pull/1174),
commit `1665925c06bd3a1d5f14e5d9f80e7eb5c9bdcfb6`. The existing custom profile-validation
and fail-closed recovery backup owner are retained. Upstream #1175 was reviewed; the custom
60-second worker claim deadline and 55-second reconciliation already cover its 45-second change.

The October 5 fast-answer/late-turn-opening repair selectively adapts
[@Maximapple](https://github.com/Maximapple)'s [PR1101](https://github.com/totec448-spec/chat-on-steroids/pull/1101),
commit `1f0938321dc69d3dcd9979d96089cc91a300d1df`. It snapshots known final IDs at the existing native Send
boundary while preserving this fork's exact receipt, route and ambiguous-delivery protections.

The October 3 worker-wake and busy-page presence repairs selectively adapt
[@Maximapple](https://github.com/Maximapple)'s [PR1001](https://github.com/totec448-spec/chat-on-steroids/pull/1001)
and [PR1003](https://github.com/totec448-spec/chat-on-steroids/pull/1003), retaining exact admission,
document and receipt fences. Slow post-model composer readiness selectively adapts
[@m1d0e1](https://github.com/m1d0e1)'s [PR1010](https://github.com/totec448-spec/chat-on-steroids/pull/1010),
with the existing bridge deadline and late post-Send receipt custody preserved.

The October 2 plugin-refresh observation repair selectively adapts [@Maximapple](https://github.com/Maximapple)'s
empty model-description fallback from official commit
[`1d572731`](https://github.com/totec448-spec/chat-on-steroids/commit/1d5727319ea8134cd2ffd42342e876574985beaf).
The custom refresh/delivery fences remain unchanged; no wider upstream bundle was imported.

Keep original authorship when merging a contribution. When adapting or consolidating contributed work, name the original author and PR, and preserve appropriate `Co-authored-by` trailers using the contributor's public GitHub noreply identity. Reports and review deserve explicit acknowledgment without inventing code authorship. See [CONTRIBUTING.md](CONTRIBUTING.md#credit-and-attribution).

The September 2026 attribution correction adds a new public record and retroactive co-author credit for incorporated work. It does not rewrite released commits or imply that contributors authored the correction's prose. GitHub's automatic contributor displays are separate from this maintained record.

The October 3 bounded deep-React-root fix is adapted from [@Maximapple](https://github.com/Maximapple)'s
upstream [0903ed67](https://github.com/totec448-spec/chat-on-steroids/commit/0903ed679b4e015179b4f7d362926fd14a049281)
for [#969](https://github.com/totec448-spec/chat-on-steroids/issues/969). Local regressions cover
both committed-root/query discovery at 450 levels and refusal beyond the retained 2048-level bound.

The October 8 GPT-6 native-family grouping and exact self-referenced public DIL answer reader
are adapted from [@Haz4rdovisk](https://github.com/Haz4rdovisk)'s
[#1194](https://github.com/totec448-spec/chat-on-steroids/pull/1194) and
[#1205](https://github.com/totec448-spec/chat-on-steroids/pull/1205), respectively.
Only those narrow mechanisms were selected, preserving this fork's exact effort/availability,
answer ownership, size and completion checks; the wider timeline redesign was not imported.
