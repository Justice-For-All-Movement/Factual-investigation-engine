# Captured plan correction impact — incomplete AM-05.08

`inspectCapturedPlanCorrectionImpact(context, captureJson, before, after)` on
`./correction-impact` compares consecutive exact Knowledge editions in a bounded
host-authorized capture containing exactly `knowledge` and `plans`. Both editions
must exist, retain the actual predecessor relationship, and the successor must be
latest for that logical record in the capture. Positive exact scoped references,
human research roles and matching captured purposes are required. Context and
snapshots are trusted host inputs, not current authentication or use permission.

Every captured plan edition is retained, including historical editions and its
separately observed latest plan ref. The existing accepted dependency reviewer
follows exact original claim/subject/event/relationship editions, never latest
replacement children. Any reachable edition of the corrected logical record older
than the successor requires review. Exact affected refs and the complete graph
are retained. A missing dependency without an observed impact is indeterminate,
never silently unaffected. `no-captured-dependency` describes only the supplied
captured graph; missing outside records, permissions or output dependencies are
not proven absent. No semantic change is inferred from the revision operation;
even a text-identical successor requires explicit dependency review.

Limits fail the whole operation: 5 MiB UTF-8 JSON input, owning validators' history
limits, existing per-plan 256-node/512-edge limits, aggregate 4096 observed nodes
and 8192 edges (repeated graphs count each time), and 512 KiB complete canonical
output. No truncation, partial report, history eviction, mutation, callback,
network, SQL, audit event, permission certificate or automatic reopening occurs.
Host CPU/heap limits remain necessary; validation is not a sandbox.

This private table-shaped data is partial correction-impact plumbing. Findings,
draft outputs, current source permissions and raw audits are explicitly unloaded.
It does not satisfy the full original AM-05.08 dependency gate, report/export,
closure or Editorial prerequisites. No false audit actors, times or creation
editions are invented. No sends, publication, payment or PAM behavior is added.

Eight focused neutral tests exercise an actual captured date correction through a
claim/relationship/event graph, unrelated plans, historical editions, missing
roots, stale/wrong-scope/role/purpose/extra/zero references, malformed/oversize JSON
and aggregate work-budget rejection. Local typecheck/build/registry and packaged
export qualification are recorded separately from current-head CI. No real TCP,
browser/AT, host proofing, current Source/Consent, or deployed acceptance claim.

All eight focused groups also pass packed compiled public exports with strict declarations and runtime byte equality. Consumer uses copied/hard-linked prepared dependencies, not a fresh dependency install. Source review clear for captured-only profile; full final-head CI remains required. PR: https://github.com/Justice-For-All-Movement/Factual-investigation-engine/pull/22.
