# Private correction-impact HTTP read — incomplete AM-05.08

`createCorrectionImpactReadHandler(reader,membership,provider,configuration,clock)`
on `./correction-impact-http` composes the actual CurrentCorrectionImpactReader
prototype, owning Membership session authentication and a separately host-proofed
human session provider. Fixed HTTPS origin, scope and purpose are required.

Only GET `/private/correction-impact/session` and POST
`/private/correction-impact/read` exist. Session response is actorId and CSRF only,
not correction authority. POST accepts exactly `{before,after}`: two positive
scoped consecutive editions of the same entity/event/relationship/claim. It
accepts no source snapshots, roles, plan capture, command or claimed permissions.

The complete strict UTF-8 JSON body is captured before fresh session proofing or
stored membership. Admission bounds1024bytes/4096chunks, copies each chunk and
checks any declared byte length. Origin/Fetch Metadata are checked and the fresh
session CSRF is compared in constant time. One overall1..30000ms monotonic budget
(default10s), cancellation and the outer synchronous VOID predicate reach the
actual reader's owning SQL locks/final copy. Every owned signal closes. Responses
are private no-store JSON, nosniff/no-referrer, complete512KiB maximum. Failures
are sanitized correction_impact_unavailable; no intermediate frame is returned.

Begun Identity/Knowledge/Factual SQL is awaited. Lost/late read acknowledgements
can leave checked audits committed;503 is UNKNOWN, not rollback or absence proof.
No automatic retry exists. An explicit later read creates a fresh checked
observation. No list/write/referral/export/publication/credential/grant/login or
listening server routes are added. No sends, payment, paid infrastructure or PAM.

The accepted reader's sequential current stored resource and complete basis
checks remain mandatory. This is not a distributed permission fence or current
Evidence/Consent use authorization, source/work truth, findings/draft-output/full
correction-impact or closure/Editorial acceptance. A copy cannot be revoked.
Hosts must supply actual proofing, unpredictable session-bound CSRF, TLS/proxy
and parser controls, current rights, driver/concurrency/time/CPUheap controls and
protected logout/reload/browser/AT/live qualification. Native Request/PGlite tests
do not establish independent network sessions, listening TLS or browser acceptance.

Seven focused neutral groups use three actual separate restricted canonical
Identity/Knowledge/Factual databases and synthetic host proofing: exact read/session,
HTTP admission, malformed UTF8/size/chunks/declared length/cancellation, policy
withdrawal while body stalls, blocked late proofing/null session, lost actual
owning read COMMIT and explicit fresh read, and actual owning-lock HTTP expiry
with checked-audit rollback. Source/packed/current-head CI evidence is separate.

All seven focused LOCAL and seven PACKED compiled public-export groups pass0fail0skip, strict declarations and correction-impact-http.js match. Consumer copied/hard-linked normally prepared dependencies, not a fresh dependency install. Source review clear for exact bounded private read-only native Fetch profile. Actual final-head CI remains required. PR26: https://github.com/Justice-For-All-Movement/Factual-investigation-engine/pull/26.
