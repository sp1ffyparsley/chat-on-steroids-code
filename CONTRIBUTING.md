# Contributing

Chat On Steroids is a Windows/macOS/Linux beta maintained by one person. Bug reports, focused fixes and concrete improvements are welcome.

## Before a pull request

For anything non-trivial, open an issue first so the intended behavior is clear. Security problems must be reported privately through [`SECURITY.md`](SECURITY.md), not as an issue or PR.

Keep changes narrow. Preserve existing permission, identity and recovery behavior unless the issue specifically requires changing it. Avoid unrelated formatting, generated output, local debugging material and private data. In screenshots, logs and examples, replace real usernames, local paths, chat text, IDs and credentials with obvious placeholders such as `C:\Users\you\project` or `/home/you/project`.

## Development setup

Development requires Node 22+ and is supported on Windows, macOS and Linux. Desktop/computer-use has platform-native Windows and macOS helpers behind one protocol; Core, extension, sessions, agents and tunnel behavior must stay portable. macOS helper changes require Xcode/Swift and a packaged arm64 or x64 smoke check.

```sh
npm ci
npm run verify     # the same gate CI runs
npm run dev        # Electron development build
```

A behavior change should include a deterministic regression test where practical. Run the nearest focused tests while working and `npm run verify` before submitting.

## Development to qualification boundary

Passing local development checks proves source workflow readiness only. It does not prove that the
installed application, packaged bytes, update path, extension pairing or native runtime behavior
match the checked-out source.

Use the existing ownership path for the next stage:

1. Use `npm run dev -- --check` and focused tests for source-edit feedback.
2. Use the existing packaging/release owner for candidate generation when packaged proof is needed.
3. Use `scripts/install-custom.ps1 -ProposeQualification` only for review of an exact candidate
   package; do not treat a generic `dist` output or a successful dev run as a qualified build.
4. Activate only through the existing receipt-bound install flow after the candidate bytes have
   been deliberately reviewed.

If a step belongs to packaging, installation, extension, or native runtime ownership, leave that
boundary with its owner instead of adding a developer-side workaround.

## Packaging

Release packages are platform/architecture-specific:

```sh
npm run dist:x64
npm run dist:arm64
npm run dist:mac:x64
npm run dist:mac:arm64
npm run dist:linux:x64
npm run dist:linux:arm64
```

These commands create package output only and may replace files under `release/`; they do not qualify or activate the private custom Windows installation. In the private custom checkout, build a candidate through `scripts/install-custom.ps1`, derive its review-only exact-installer receipt with `scripts/install-custom.ps1 -ProposeQualification`, deliberately pin only reviewed bytes, and use the receipt-bound activation path rather than manually running a generated Setup EXE.

Release CI builds and smoke-tests every platform/architecture on a native runner. Packaging downloads/stages pinned external assets and verifies their checksums, so the first packaging run needs network access. Do not claim a cross-OS package is validated merely because electron-builder can sometimes emit it from another host.

## Pull requests

Explain the root cause, the smallest behavior change that fixes it, and exactly how you validated it. Packaging/runtime changes should include a packaged-runtime smoke check where relevant.

## Credit and attribution

Contributors retain credit when their patches are adapted, rewritten or consolidated into release snapshots. Merge the original PR when appropriate and preserve its author. For adapted work, link the original PR, explain what was incorporated, and include the original contributor in the integration commit's `Co-authored-by` trailers using their public GitHub noreply identity. Verify the resulting commit resolves to the intended GitHub account.

Record incorporated work in [CONTRIBUTORS.md](CONTRIBUTORS.md). Credit bug reports, designs and review explicitly, distinguishing them from incorporated code. Closing a PR as incorporated or superseded must explain that distinction and link the integration; it must not erase attribution. AI-assisted integration does not transfer the original contributor's credit to the maintainer or the model.

Contributions are accepted under the MIT licence in [`LICENSE`](LICENSE).
