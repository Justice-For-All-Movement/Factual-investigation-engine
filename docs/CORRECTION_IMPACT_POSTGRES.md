# Owning correction-impact PostgreSQL qualification — incomplete AM-05.08

Three added tests extend the existing sixteen restricted canonical PostgreSQL17
TCP scenarios. They exercise FactualRepository.loadCorrectionImpact from accepted
PR23, with HOST-trusted Context and Knowledge captures. They do not qualify the
current three-service reader, Identity/Knowledge/SourceConsent over TCP, or a
production permission fence. No runtime/API/dependency/schema changes are made.

Two cases start a real public plan revision writer held BEFORE COMMIT, then start
an owning impact reader using an independent restricted login session. The
independent admin observer MUST see pg_stat_activity Lock and nonempty
pg_blocking_pids before the writer is released. The normal read then retains both
actual plan editions and their exact containing revision/latest-plan references;
current and historical dependencies remain review-required. The expiry case
waits beyond its actual owning monotonic budget after the observed wait, then
requires impact_unavailable with zero committed checked-read audits. A fresh pool
reads the writer's committed complete history. Both cases release and await all
begun work in finally, even when assertions fail.

The third case deliberately loses an actual checked-read COMMIT acknowledgement,
closes that pool, and reads via a fresh pool. Both checked-read audits must remain
with a valid audit chain; the entire stored planning revision is unchanged and
there is only the original planning effect. A lost read is not rollback proof or
a replayed action. No retry, state deletion, repair or absence claim is introduced.

Fixture constraints remain unchanged: explicit disposable opt-in, empty loopback
factual_ci only, canonical stable Evidence SQL migration, restricted LOGIN and
distinct session PIDs, no reset, refusal of arbitrary/remote/query-bearing targets.
Local strict compile/build/registry/unsafe-fixture checks are separate from actual
PostgreSQL CI qualification. No local PostgreSQL/Docker, TLS/failover/driver/crash,
browser/AT/live/worktruth/closure claim. Actual final-head raw CI logs are required
before merge. Original full correction-impact/Editorial dependencies remain unmet.
