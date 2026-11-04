# Research mirror engineering map

This repository is a sanitized code mirror. Read README.md for the exact source and acceptance boundary before proposing work. Public commit hashes and private release-provenance hashes have different meanings.

- Browser production owners: extension/fiber.js, content.js, background.js and chatgpt-dom.js. Keep original question/document/epoch/ordered-parent/result proofs, current policy and native Send ownership intact.
- Main owners: src/main/core-browser-evidence.ts, session/correlation.ts, session/recorder.ts, session/input.ts, session/continuation.ts, goal.ts and bridge.ts. Reuse their existing serialized custody; no duplicate queues, generic Continue watchdog or fabricated terminal receipts.
- Nearest test owners: test/shell-compat.test.ts, fiber.test.ts, content-script.test.ts, extension.test.ts, bridge.test.ts, continuation.test.ts and goal.test.ts.
- shellScan.reader is bounded self-reported diagnostic shape only. Missing stages are unknown. It cannot certify executing generation, native result completion or authorization.
- Preserve immutable source/delivery hashes, unknown Send effects, drafts, approvals, pauses, exact requested models and per-profile isolation. Archive custody is not replay authority.
- Do not copy personal prompts, stores, credentials, browser state, private logs, backups or deployment paths into this mirror. Keep fixture identities synthetic.
- Run typecheck and the relevant existing regressions. A mirror check or package build does not prove installation or sustained useful next turns.
- Keep this map and README current when the source or acceptance boundary changes. If retrieval fails, continue from supplied excerpts and label evidence; never invent symbols or return an access-only research report.
