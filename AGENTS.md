# QuickPilot Server Rules

This repository serves the live QuickPilot Firebase project. Preserve unrelated dirty and untracked files.

## Order-cost safety

- Treat server cost and every user's mobile data as release-blocking correctness requirements.
- `rules/data-cost-policy.json` is the machine-readable authority for data retention, raw-upload
  limits, read scope, per-order write budgets, canary byte ceilings, and automatic stop signals.
  `node scripts/verify-data-cost-policy.js` must pass before any Functions, rules, Hosting, or
  QuickPilot client release. A release may not weaken this policy by changing only prose.
- Preserve user truth: licenses, profile/status/version, representative orders, earnings/expenses,
  manual/order edits and history, agencies, reports, social/board/update content. Never delete,
  merge, hide, or rewrite this data to reduce cost or disguise a duplicate/display defect.
- Prefer compact product summaries: `daily_drive`, `data_live`, `data_maps`, and `data_cache`.
  Read exact UID/date summaries first. Raw GPS fallback is allowed only for a missing summary and
  must repair that summary. A scheduled function may not scan all users' full history.
- Raw diagnostics are not product truth. New `window_dumps`, `order_logs`, and `diag` writes stay
  blocked. `user_actions` and `system_events` stay default-off and may be enabled only for one
  incident-scoped UID/date with a bounded record and time budget. Existing raw data is cleaned only
  after allow-listed dry run, SHA-256 backup, explicit approval, deletion readback, and restore sample.
- One semantic order change has a hard budget of one client transaction, one `orderLive`
  invocation, and at most eleven downstream committed writes. A semantic no-op, permission denial,
  or historical blocked backlog has a budget of zero writes/retries/releases.
- Deploy `orderLive` only from the isolated `functions-order-live-release` package with
  `scripts/deploy-order-live-only.ps1`. Never substitute a broad Functions, Hosting, or database deploy.
- A transport-only echo must return before every downstream database write and log. The 10,000-echo
  regression in `functions-order-live-release/test/order-live-guard.test.js` must keep downstream side
  effects at zero.
- Before an order function change, run `node scripts/verify-order-live-cost-gate.js
  functions-order-live-release`. Keep the isolated package's exact file allow-list and bounded write budget.
- Change order write rules only through `scripts/build-order-sync-rules-candidate.js`,
  `scripts/verify-order-sync-rules-candidate.js`, and the rules-only deploy path. Preserve a verified
  fail-closed rollback rules artifact.

## Fail-closed rollout

- Client distribution and order-write admission are separate. The only order is: exact paired protected
  client distribution while writes remain `BLOCKED` -> install the protected client -> one exact
  UID/KST-date `CANARY` -> measured CAN-F01 pass -> `VERSION`.
- `scripts/publish-order-sync-control.ps1` is the only control writer. It must enforce the transition
  graph; a direct `BLOCKED -> VERSION`, a stale/mismatched public APK pair, or a VERSION without the
  executable CAN-F01 stamp must fail before mutation. Emergency return to a newer-generation `BLOCKED`
  must remain possible without release evidence.
- Source tests, compile success, urgency, screenshots, estimates, or a currently blocked server do not
  replace the measured two-minute idle plus ten-minute active canary.
- A noisy old client may be replaced publicly before CAN-F01 only when
  `verify-qp-public-release-gate.ps1 -ProtectedClientRollout` proves exact paired APK metadata, signer,
  hashes, markers, isolated server package, rules/rollback, and exact live `BLOCKED` control for the new
  version. This mode must emit `QP_ORDER_WRITE_ENABLE_STATUS=BLOCKED`. Do not disable unrelated
  login/read/social/Hosting/update paths.
- After public release, keep the required REL-F01 monitoring window. If denied writes, repeated semantic
  echoes, invocations, or bytes exceed the locked budget, return order sync control to `BLOCKED` before
  diagnosis.
- A blocked quiet window passes only with zero client order transactions/updates. CAN-F01 requires zero
  denied order writes in both windows, zero idle order writes/invocations, active writes and `orderLive`
  invocations equal to the exact semantic change count, at most 1 MiB outbound in the two-minute idle
  window, and at most 5 MiB in the ten-minute active window.
- VERSION must not release historical permission-blocked outbox rows. As of vc459, VERSION is forbidden:
  that client can release all old blocked rows for a UID. Only exact current-date CANARY is eligible after
  the protected client is installed and the rules-only candidate is separately verified and deployed
  while control remains BLOCKED. A later client must prove that old blocked rows stay dormant and only a
  post-permit real fact change queues one revision.
- The first sixty minutes after any future VERSION admission require consecutive one-minute traffic
  checks. Any denied order request, repeated same-meaning order write, unexplained `orderLive` invocation,
  or byte budget breach returns control to BLOCKED first; diagnosis comes afterward.
- The machine watchdog is isolated in `functions-order-sync-watchdog-release`. It reads only the compact
  control/current-metrics nodes, writes only a newer-generation `BLOCKED` control on a breach, and leaves
  login, reads, social, Hosting, and updates untouched. Deploy it only through its isolated dry-run-first
  script; collector loss or stale metrics is a fail-closed order-sync condition.
- Rules candidates take the minimum client version from the app repository's `.version_lock`; never copy a
  previous release number into a new rules or release gate.

## Live-state discipline

- Never infer the current deployed hash or control mode from a handoff. Read the live function list,
  live rules hash, and `/v1/app/order_sync_control` before making a release claim.
- Do not edit or deploy the broad dirty `functions/index.js` or `database.rules.json` as a shortcut for
  the isolated order-cost workflow.
