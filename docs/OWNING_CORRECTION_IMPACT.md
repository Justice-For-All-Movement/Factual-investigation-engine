# Owning planning correction-impact read — incomplete AM-05.08

`FactualRepository.loadCorrectionImpact(context, knowledgeJson, before, after,
signal?, timeoutMs?, admit?)` uses the accepted captured impact computation with
the actual planning history from this engine's own stable Evidence SQL database.
The checked `factual.correction_impact.read_checked` audit acquires the project lock
before the only planning-history read. Returned `planningStorage` is its actual
containing edition, or null when no history exists; no revision-zero record is
invented. No history, effect event, command acknowledgement or outbox write is added.

Knowledge JSON is separately authorized HOST input. This API does not load a
Knowledge database, authenticate a snapshot or establish current Identity,
Evidence or Consent rights. Fixed listed human host policy, purpose and existing
owning validators remain mandatory. It has no cache or retry. Current Identity
and authenticated upstream composition remain pending separate adapters.

One 1..30000 ms monotonic budget (default10s) and cancellation gates cover capture,
actual lock admission, stored read, computation, final detached copy and post-SQL
acknowledgement. Optional trusted synchronous VOID admission may inspect only
request deadline/cancellation state; do not perform external I/O, credentials,
policy lookups or writes under SQL. Native rejected promises are observed and all
nonvoid results denied; callback diagnostics are sanitized. Blocked JavaScript
cannot be preempted, and begun SQL is awaited. Cancellation/expiry/lost COMMIT
acknowledgement withholds data without asserting rollback; checked audit can have
committed. An explicit later read performs a new checked read, never a retry permit.

Input Knowledge JSON and combined capture each obey5MiB; the full wrapped output
obeys512KiB in addition to captured per-graph/aggregate budgets. All historical
plan editions and exact dependency graphs remain present. Invalid data, expiry,
corrupt stored history or exhausted budgets deny whole; no truncation, repair,
deletion, eviction, automatic reopening, findings or draft-output work is added.

Neutral restricted canonical-migration PGlite tests qualify owning storage refs,
empty history, retained plan editions, lost read acknowledgement, under-lock outer
expiry, nonvoid admission, cancellation, host scope/role/purpose refusal and
post-COMMIT cancellation. PGlite is not independent TCP contention or deployed
Identity/Source/Consent/driver/TLS/browser/AT/live acceptance. Original full
AM-05.08 and Editorial dependency gates remain unmet; PAM stays foundation-only.
No send, public release, payment, paid infrastructure or research import.

Qualification: all eight final focused local and eight packed compiled public-export groups pass with zero failures/skips; strict declarations and repository runtime bytes match. Packed consumer copies/hard-links prepared dependencies, not a fresh dependency installation. Lost actual read COMMIT then explicit read retains two checked audits and unchanged plans; under-lock outer and monotonic expiry roll back their checked audits. Source review clear for host-trusted source profile. Full final-head CI remains required. PR23: https://github.com/Justice-For-All-Movement/Factual-investigation-engine/pull/23.
