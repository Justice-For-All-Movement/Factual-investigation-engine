# Current owning correction-impact reader — incomplete AM-05.08

`CurrentCorrectionImpactReader(repository, membership, knowledge, fixedPolicy,
timeoutMs?)` on `./correction-impact-current` composes actual configured owning
FactualRepository, MembershipRegistry and IdentityKnowledgeRepository public
prototype methods. `read(context,before,after,signal?,admit?)` accepts exact
positive scoped consecutive correction refs, never Knowledge or planning JSON.
Configuration and principal proofing remain host responsibilities. Incoming roles
are stripped before actual current stored resource authorization.

The bounded sequence is: current Factual authority; current-Identity Knowledge
history plus explicit same-human stored Knowledge policy after its SQL; actual checked-lock Factual impact; current Factual authority and a fresh
current-Identity Knowledge history and post-load current source policy; equality of the COMPLETE Knowledge revision
and state; fresh Factual authority; actual checked-lock impact again; equality of
the COMPLETE owning frame; final current Factual authority; complete detached copy.
This catches unselected planning or Knowledge changes too. Every read repeats all
observations; there is no historical cache, fallback or automatic retry. Exact
Knowledge and Factual containing storage references are returned. Empty owning
planning remains null; Knowledge must contain the actual correction pair.

One overall 1..30000ms monotonic budget/default10s and cancellation are checked
before and after asynchronous/copy/domain stages. Remaining time and synchronous
VOID gate reach both actual Factual checked locks. Optional outer admission may
inspect only request deadlines/cancellation, never external policy/I/O/credentials
under SQL. Native rejecting promises are observed; nonvoid results deny. Every
failure is sanitized impact_unavailable. Begun SQL is awaited; a lost or late read
COMMIT acknowledgement withholds data and is not rollback proof. Checked-read
audits may survive. Each explicit subsequent read begins a fresh observation.
The final wrapped private output obeys512KiB; existing input/graph budgets remain.

All authority and basis observations are sequential, NOT a distributed permission
fence or a globally atomic snapshot. Knowledge/source policy can change after its
last observation, including during the final owning read. A returned copy cannot
be recalled or used as a fresh permit. Knowledge permission does not establish
Evidence/Consent use rights, source truth, work, findings, draft-output impact or
closure. Those remain explicitly unloaded. No Source/Consent service, HTTP,
listener, credential transport, export or Visual route is added. No sends,
publication, payment, paid infrastructure, country fixtures or PAM changes.

Tests use three separate actual restricted canonical-migration PGlite databases,
real owning methods and synthetic host policy/proofed principal context. PGlite
is not independent TCP contention, production proofing/current SourceConsent,
TLS/driver/CPUheap/browser/AT/live qualification. Full original AM-05.08 and
Editorial dependencies remain unmet; this is only a partial current read path.

Ten final focused local and ten packed compiled public-export groups pass with zero failures/skips. Strict declarations and correction-impact-current.js match. Consumer copies/hard-links normally prepared dependencies; this is not a fresh dependency install. The two added groups require actual under-lock outer deadline rollback and blocked-JS late Knowledge result denial. Source review clear for sequential current owning-services profile. Full final-head CI remains required. PR24: https://github.com/Justice-For-All-Movement/Factual-investigation-engine/pull/24.
