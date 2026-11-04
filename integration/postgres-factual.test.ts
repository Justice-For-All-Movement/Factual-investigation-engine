import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  postgresDatabase,
  scoped,
  verifyAudit,
} from "@accountability/evidence-sql/database";
import type { Database } from "@accountability/evidence-sql/database";
import * as k from "@accountability/knowledge-verification";
import {
  FactualRepository,
  PLANNING_KIND,
  PLANNING_KEY,
} from "../src/repository.ts";
import type { PlanningCommand } from "../src/repository.ts";
import type { Context } from "@accountability/knowledge-verification/contracts";
// Intentionally refuses arbitrary or persistent database targets. CI owns this empty fixture only.
const supplied = process.env.FIE_TEST_ADMIN_URL;
assert.ok(
  process.env.FIE_TEST_DISPOSABLE_POSTGRES === "1" && supplied,
  "Explicit disposable PostgreSQL fixture configuration required",
);
const url = new URL(supplied);
assert.ok(
  ["postgres:", "postgresql:"].includes(url.protocol) &&
    ["localhost", "127.0.0.1"].includes(url.hostname) &&
    url.pathname === "/factual_ci" &&
    url.username === "postgres" &&
    !url.search &&
    !url.hash,
  "Only the designated empty loopback fixture is accepted",
);
const admin = postgresDatabase(url.toString());
before(async () => {
  await admin.transaction(async (q) => {
    assert.equal(
      (
        await q.query<{ fresh: boolean }>(
          "SELECT to_regclass('public.evidence_project') IS NULL AS fresh",
        )
      ).rows[0]!.fresh,
      true,
      "Fixture must be empty; never reset a database here",
    );
    const migration = await readFile(
      new URL(
        "../migrations/001_foundation.sql",
        import.meta.resolve("@accountability/evidence-sql/database"),
      ),
      "utf8",
    );
    assert.equal(migration.match(/^BEGIN;$/gm)?.length, 1);
    assert.equal(migration.match(/^COMMIT;$/gm)?.length, 1);
    // The SDK transaction owns BEGIN/COMMIT; every actual migration statement is unchanged.
    await q.query(migration.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, ""));
    await q.query(
      "CREATE ROLE factual_network_login LOGIN PASSWORD 'fixture-runtime-only' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT evidence_runtime TO factual_network_login",
    );
  });
});
after(() => admin.close());

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
async function fixture(t: test.TestContext, id: string) {
  const context: Context = {
    tenantId: "fiction",
    projectId: id,
    actor: { id: "owner", kind: "human", roles: ["owner"] },
    purpose: "review",
    requestId: "fixture",
    now: "2026-01-01T00:00:00Z",
  };
  const policy = {
    tenantId: context.tenantId,
    projectId: id,
    purpose: context.purpose,
    humanIds: ["owner"],
  };
  function connect(label: string) {
    const u = new URL(url);
    u.username = "factual_network_login";
    u.password = "fixture-runtime-only";
    u.searchParams.set("application_name", id + "-" + label);
    const raw = postgresDatabase(u.toString());
    let closed = false;
    const db: Database = {
      transaction: raw.transaction.bind(raw),
      close: async () => {
        if (!closed) {
          closed = true;
          await raw.close();
        }
      },
    };
    t.after(() => db.close());
    return db;
  }
  const a = connect("a"),
    b = connect("b");
  const sessions = await Promise.all(
    [a, b].map((db) =>
      db.transaction((q) =>
        q.query<{ pid: number; login: string }>(
          "SELECT pg_backend_pid() AS pid, session_user AS login",
        ),
      ),
    ),
  );
  assert.notEqual(sessions[0]!.rows[0]!.pid, sessions[1]!.rows[0]!.pid);
  assert.ok(
    sessions.every((s) => s.rows[0]!.login === "factual_network_login"),
  );
  return {
    context,
    policy,
    a,
    b,
    connect,
    sa: new FactualRepository(a, policy),
    sb: new FactualRepository(b, policy),
    id,
  };
}
const claim: k.KnowledgeValue = {
  type: "claim",
  text: "A fictional signal may have occurred",
  subjectRefs: [],
  time: { earliest: null, latest: null },
  accountType: "observation",
  limitations: ["Unverified fixture"],
  assessment: null,
  proceduralPosture: null,
  editorialApproval: null,
};
function input(c: Context) {
  const knowledge = k.reviseKnowledge(c, k.createKnowledgeState(c), {
    id: "claim",
    expectedRevision: 0,
    value: claim,
  });
  const command: PlanningCommand = {
    id: "plan",
    expectedRevision: 0,
    value: {
      title: "Fictional signal review",
      intakeCaseRef: null,
      basisClaimRefs: [knowledge.records[0]!.ref],
      questions: [
        {
          id: "time",
          parentId: null,
          text: "When was the signal observed?",
          whyMaterial: "Distinguishes sequences",
          material: true,
          hypotheses: [
            {
              id: "early",
              explanation: "Before the lamp",
              claimRefs: [knowledge.records[0]!.ref],
              contraryTest: "Seek an authorized record of the reverse order",
            },
          ],
          leads: [
            {
              id: "log",
              description: "Inspect a separately authorized fictional log",
            },
          ],
          stopCondition: "Pause if no source is authorized; remain unresolved",
        },
      ],
    },
  };
  return { knowledge, command };
}
async function observedWait(id: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const r = await admin.transaction((q) =>
      q.query<{ blocked: boolean }>(
        "SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0) AS blocked",
        [id + "-b"],
      ),
    );
    if (r.rows[0]!.blocked) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(
    "Independent observer must see actual PostgreSQL Lock and nonempty blocking PIDs before COMMIT",
  );
}
function held(
  db: Database,
  locked: ReturnType<typeof gate>,
  release: ReturnType<typeof gate>,
): Database {
  return {
    close: async () => {},
    transaction: (fn) =>
      db.transaction(async (q) => {
        const result = await fn(q);
        locked.resolve();
        await release.promise;
        return result;
      }),
  };
}

function effort(
  plan: Awaited<ReturnType<FactualRepository["append"]>>["record"],
) {
  return {
    id: "effort",
    expectedSequence: 0,
    plan,
    questionId: "time",
    leadId: "log",
    outcome: "attempted" as const,
    detail: "Fictional unresolved attempt",
    corrects: null,
  };
}
async function effects(
  db: Database,
  c: Context,
  auditType: string,
  topic: string,
  count: number,
) {
  await scoped(db, c, async (tx) => {
    const audit = await tx.audits();
    assert.ok(verifyAudit(audit));
    assert.equal(audit.filter((a) => a.type === auditType).length, count);
    const topics: string[] = [];
    for (;;) {
      const e = await tx.claim("fixture");
      if (!e) break;
      topics.push(e.topic);
      await tx.acknowledge(e);
    }
    assert.equal(topics.filter((t) => t === topic).length, count);
  });
}
test(
  "independent plan contenders preserve one storage edition and one effect",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, "factual-plans"),
      x = input(f.context);
    const results = await Promise.allSettled([
      f.sa.append(f.context, 0, x.knowledge, x.command, "one"),
      f.sb.append(
        f.context,
        0,
        x.knowledge,
        { ...x.command, id: "other" },
        "two",
      ),
    ]);
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    const loser = results.find(
      (x) => x.status === "rejected",
    ) as PromiseRejectedResult;
    assert.equal(loser.reason.code, "revision_conflict");
    assert.equal((await f.sb.load(f.context)).revision, 1);
    await effects(
      f.b,
      f.context,
      "factual.planning.appended",
      "factual.planning.revised",
      1,
    );
  },
);
test(
  "lost actual plan COMMIT acknowledgement replays original refs through a fresh pool",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, "factual-plan-lost"),
      x = input(f.context);
    const lost: Database = {
      close: async () => {},
      transaction: async (fn) => {
        await f.a.transaction(fn);
        throw Error("fixture lost COMMIT acknowledgement");
      },
    };
    await assert.rejects(
      new FactualRepository(lost, f.policy).append(
        f.context,
        0,
        x.knowledge,
        x.command,
        "plan",
      ),
      /lost COMMIT/,
    );
    await f.a.close();
    const fresh = f.connect("fresh"),
      repo = new FactualRepository(fresh, f.policy);
    // Historical replay does not turn a missing upstream snapshot into current claim attestation.
    const ack = await repo.append(
      f.context,
      0,
      k.createKnowledgeState(f.context),
      x.command,
      "plan",
    );
    assert.equal(ack.storage.revision, 1);
    assert.equal((await repo.load(f.context)).state.records.length, 1);
    await effects(
      fresh,
      f.context,
      "factual.planning.appended",
      "factual.planning.revised",
      1,
    );
  },
);
test(
  "new effort waits for actual public plan revision then rejects its stale edition",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, "factual-stale-plan"),
      x = input(f.context);
    const plan = await f.sa.append(
      f.context,
      0,
      x.knowledge,
      x.command,
      "plan",
    );
    const q = effort(plan.record),
      locked = gate(),
      release = gate();
    const writing = new FactualRepository(
      held(f.a, locked, release),
      f.policy,
    ).append(
      f.context,
      1,
      x.knowledge,
      { ...x.command, expectedRevision: 1 },
      "revise",
    );
    const result = writing.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let pending: Promise<unknown> | undefined;
    try {
      await Promise.race([locked.promise, writing]);
      pending = f.sb.recordEffort(f.context, 0, q, "effort");
      const denied = assert.rejects(pending, { code: "stale_plan" });
      await observedWait(f.id);
      release.resolve();
      const write = await result;
      assert.ok("value" in write);
      await denied;
      await f.b.close();
      const fresh = f.connect("fresh"),
        repo = new FactualRepository(fresh, f.policy);
      await assert.rejects(repo.recordEffort(f.context, 0, q, "effort"), {
        code: "stale_plan",
      });
      assert.equal((await repo.loadEfforts(f.context)).revision, 0);
      assert.equal((await repo.load(f.context)).revision, 2);
      await scoped(fresh, f.context, async (tx) => {
        const audit = await tx.audits();
        assert.ok(verifyAudit(audit));
        assert.equal(
          audit.filter((a) => a.type === "factual.effort.append_checked")
            .length,
          0,
          "Denied attempts roll back their checked audits",
        );
      });
    } finally {
      release.resolve();
      await result;
      await pending?.catch(() => {});
    }
  },
);
test(
  "effort CAS contender waits behind winning actual COMMIT with lost acknowledgement",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, "factual-efforts"),
      x = input(f.context);
    const plan = await f.sa.append(
        f.context,
        0,
        x.knowledge,
        x.command,
        "plan",
      ),
      q = effort(plan.record);
    const locked = gate(),
      release = gate(),
      holding = held(f.a, locked, release);
    const lost: Database = {
      close: async () => {},
      transaction: async (fn) => {
        await holding.transaction(fn);
        throw Error("fixture lost effort COMMIT acknowledgement");
      },
    };
    const winning = new FactualRepository(lost, f.policy).recordEffort(
      f.context,
      0,
      q,
      "winner",
    );
    const result = winning.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let pending: Promise<unknown> | undefined;
    try {
      await Promise.race([locked.promise, winning]);
      pending = f.sb.recordEffort(
        f.context,
        0,
        { ...q, id: "contender" },
        "contender",
      );
      const conflict = assert.rejects(pending, { code: "revision_conflict" });
      await observedWait(f.id);
      release.resolve();
      const won = await result;
      assert.ok("error" in won);
      assert.match(String(won.error), /lost effort COMMIT/);
      await conflict;
      await f.a.close();
      await f.b.close();
      const fresh = f.connect("fresh"),
        repo = new FactualRepository(fresh, f.policy);
      const ack = await repo.recordEffort(f.context, 0, q, "winner");
      assert.equal(ack.storage.revision, 1);
      const snapshot = await repo.loadEfforts(f.context);
      assert.equal(snapshot.revision, 1);
      assert.equal(snapshot.state.records.length, 1);
      assert.equal(snapshot.planningRevision, 1);
      await effects(
        fresh,
        f.context,
        "factual.effort.recorded",
        "factual.effort.revised",
        1,
      );
    } finally {
      release.resolve();
      await result;
      await pending?.catch(() => {});
    }
  },
);
test(
  "Factual network adapters reject admin and lowered-admin sessions and preserve actual RLS scope",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, "factual-isolation");
    const x = input(f.context);
    await f.sa.append(f.context, 0, x.knowledge, x.command, "one");
    const foreign = { ...f.context, projectId: "factual-other" },
      otherPolicy = { ...f.policy, projectId: foreign.projectId };
    const other = new FactualRepository(f.b, otherPolicy);
    const y = input(foreign);
    await other.append(
      foreign,
      0,
      y.knowledge,
      {
        ...y.command,
        value: { ...y.command.value, title: "Other fictional plan" },
      },
      "one",
    );
    await assert.rejects(
      new FactualRepository(admin, f.policy).load(f.context),
      { code: "unsafe_database_role" },
    );
    const lowered: Database = {
      close: async () => {},
      transaction: (fn) =>
        admin.transaction(async (q) => {
          await q.query("SET LOCAL ROLE evidence_runtime");
          return fn(q);
        }),
    };
    await assert.rejects(
      new FactualRepository(lowered, f.policy).load(f.context),
      { code: "unsafe_database_role" },
    );
    for (const sql of [
      "CREATE TABLE public.factual_forbidden(id integer)",
      "SET ROLE postgres",
    ])
      await assert.rejects(
        f.b.transaction((q) => q.query(sql)),
        { code: "42501" },
      );
    assert.equal(
      (
        await f.b.transaction(async (q) => {
          await q.query("SET LOCAL ROLE evidence_runtime");
          return q.query("SELECT * FROM public.evidence_record");
        })
      ).rows.length,
      0,
    );
    await scoped(f.a, f.context, async (tx) => {
      const own = await tx.get(PLANNING_KIND, PLANNING_KEY);
      assert.ok(own);
      assert.ok(verifyAudit(await tx.audits()));
    });
    await scoped(f.b, { ...f.context, projectId: "absent" }, async (tx) =>
      assert.equal(await tx.get(PLANNING_KIND, PLANNING_KEY), null),
    );
    assert.notDeepEqual(
      (await f.sb.load(f.context)).state,
      (await other.load(foreign)).state,
    );
  },
);

for (const mode of ["correction", "read"] as const)
  test(
    `${mode} observes actual committed history after independently observed lock wait`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t, "factual-" + mode),
        x = input(f.context);
      const plan = await f.sa.append(
          f.context,
          0,
          x.knowledge,
          x.command,
          "plan",
        ),
        q = effort(plan.record);
      const first = await f.sa.recordEffort(f.context, 0, q, "first");
      const correction = {
        ...q,
        id: "correction",
        expectedSequence: 1,
        corrects: first.record,
        detail: "Corrected unresolved account",
      };
      const locked = gate(),
        release = gate(),
        repo = new FactualRepository(held(f.a, locked, release), f.policy);
      const writing =
        mode === "correction"
          ? repo.recordEffort(f.context, 1, correction, "correction")
          : repo.append(
              f.context,
              1,
              x.knowledge,
              { ...x.command, expectedRevision: 1 },
              "revise",
            );
      const result = writing.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      let pending: Promise<unknown> | undefined;
      try {
        await Promise.race([locked.promise, writing]);
        pending =
          mode === "correction"
            ? // Intentionally expect the next storage/sequence so the owning domain must reject a fork after loading the winner.
              f.sb.recordEffort(
                f.context,
                2,
                { ...correction, id: "fork", expectedSequence: 2 },
                "fork",
              )
            : f.sb.loadEfforts(f.context);
        const outcome = pending.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await observedWait(f.id);
        release.resolve();
        assert.ok("value" in (await result));
        const r = await outcome;
        if (mode === "correction") {
          assert.ok("error" in r);
          assert.equal(
            (r.error as { code: string }).code,
            "invalid_correction",
          );
        } else {
          assert.ok("value" in r);
          const snapshot = r.value as Awaited<
            ReturnType<FactualRepository["loadEfforts"]>
          >;
          assert.equal(snapshot.planningRevision, 2);
          assert.equal(snapshot.revision, 1);
          assert.deepEqual(snapshot.state.records[0]!.plan, plan.record);
        }
        await f.b.close();
        const fresh = f.connect("fresh"),
          current = new FactualRepository(fresh, f.policy);
        const snapshot = await current.loadEfforts(f.context);
        assert.equal(snapshot.planningRevision, mode === "read" ? 2 : 1);
        assert.equal(snapshot.revision, mode === "correction" ? 2 : 1);
        if (mode === "correction") {
          assert.deepEqual(snapshot.state.records[1]!.corrects, first.record);
          await assert.rejects(
            current.recordEffort(
              f.context,
              2,
              { ...correction, id: "fork", expectedSequence: 2 },
              "fork",
            ),
            { code: "invalid_correction" },
          );
          await effects(
            fresh,
            f.context,
            "factual.effort.recorded",
            "factual.effort.revised",
            2,
          );
        }
        await scoped(fresh, f.context, async (tx) =>
          assert.ok(verifyAudit(await tx.audits())),
        );
      } finally {
        release.resolve();
        await result;
        await pending?.catch(() => {});
      }
    },
  );
