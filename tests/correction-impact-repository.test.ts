import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { scoped, verifyAudit } from "@accountability/evidence-sql/database";
import type { Database } from "@accountability/evidence-sql/database";
import * as k from "@accountability/knowledge-verification";
import type { Context } from "@accountability/knowledge-verification/contracts";
import { FactualRepository } from "../src/repository.ts";
import type { PlanningCommand } from "../src/repository.ts";
const c: Context = {
  tenantId: "fiction",
  projectId: "factual",
  purpose: "private-review",
  actor: { id: "researcher", kind: "human", roles: ["researcher"] },
  now: "2026-01-01T00:00:00Z",
  requestId: "r",
};
const claim: Extract<k.KnowledgeValue, { type: "claim" }> = {
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
function input() {
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
async function fixture(t: test.TestContext) {
  const pg = new PGlite();
  await pg.exec(
    await readFile(
      new URL(
        "../migrations/001_foundation.sql",
        import.meta.resolve("@accountability/evidence-sql/database"),
      ),
      "utf8",
    ),
  );
  await pg.exec(
    "CREATE ROLE factual_login LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT evidence_runtime TO factual_login; SET SESSION AUTHORIZATION factual_login",
  );
  const hooks: { lost: boolean; rollback: boolean; read: (() => void) | null } =
    { lost: false, rollback: false, read: null };
  const db: Database = {
    transaction: (fn) =>
      pg
        .transaction(async (query) => {
          const value = await fn({
            query: async <T>(sql: string, values?: unknown[]) => {
              const result = await query.query(sql, values);
              if (values?.includes("factual.correction_impact.read_checked"))
                hooks.read?.();
              if (
                hooks.rollback &&
                sql.includes("INSERT INTO public.evidence_outbox")
              )
                throw Error("fixture rollback");
              return { rows: result.rows as T[] };
            },
          });
          return value;
        })
        .then((value) => {
          if (hooks.lost) {
            hooks.lost = false;
            throw Error("fixture lost COMMIT acknowledgement");
          }
          return value;
        }),
    close: () => pg.close(),
  };
  t.after(() => pg.close());
  const policy = {
    tenantId: c.tenantId,
    projectId: c.projectId,
    humanIds: [c.actor.id],
    purpose: c.purpose,
  };
  return { db, pg, policy, hooks, repo: new FactualRepository(db, policy) };
}

function change() {
  const x = input();
  const before = x.knowledge.records[0]!.ref;
  const knowledge = k.reviseKnowledge(c, x.knowledge, {
    id: "claim",
    expectedRevision: 1,
    value: { ...claim, text: "Revised unverified fixture" },
  });
  return {
    ...x,
    originalKnowledge: x.knowledge,
    knowledge,
    before,
    after: knowledge.records.at(-1)!.ref,
  };
}
test("actual owning history binds all editions and exact containing revision; checked read has no effect", async (t) => {
  const f = await fixture(t),
    x = change();
  const empty = await f.repo.loadCorrectionImpact(
    c,
    JSON.stringify(x.knowledge),
    x.before,
    x.after,
  );
  assert.equal(empty.planningStorage, null);
  assert.deepEqual(empty.impact.plans, []);
  const a = await f.repo.append(c, 0, x.originalKnowledge, x.command, "plan");
  const next = await f.repo.append(
    c,
    1,
    x.originalKnowledge,
    {
      ...x.command,
      expectedRevision: 1,
      value: { ...x.command.value, title: "Later planning edition" },
    },
    "plan2",
  );
  const auditBefore = await scoped(f.db, c, (tx) => tx.audits());
  const result = await f.repo.loadCorrectionImpact(
    c,
    JSON.stringify(x.knowledge),
    x.before,
    x.after,
  );
  const auditAfter = await scoped(f.db, c, (tx) => tx.audits());
  assert.equal(auditAfter.length, auditBefore.length + 1);
  assert.equal(
    auditAfter.at(-1)!.type,
    "factual.correction_impact.read_checked",
  );
  assert.equal(verifyAudit(auditAfter), true);
  assert.deepEqual(result.planningStorage, next.storage);
  assert.equal(result.impact.plans.length, 2);
  assert(result.impact.plans.every((p) => p.status === "review-required"));
  assert.deepEqual(result.impact.plans[0]!.latestPlan, next.record);
  Object.assign(result.impact.plans[0]!.plan, { id: "copy" });
  assert.deepEqual((await f.repo.load(c)).state.records[0]!.ref, a.record);
});
test("lost actual read COMMIT withholds copy; explicit fresh read retains same plans", async (t) => {
  const f = await fixture(t),
    x = change();
  await f.repo.append(c, 0, x.originalKnowledge, x.command, "plan");
  const beforeAudit=await scoped(f.db,c,tx=>tx.audits());
  f.hooks.lost = true;
  await assert.rejects(
    f.repo.loadCorrectionImpact(
      c,
      JSON.stringify(x.knowledge),
      x.before,
      x.after,
    ),
  );
  const result = await f.repo.loadCorrectionImpact(
    c,
    JSON.stringify(x.knowledge),
    x.before,
    x.after,
  );
  const afterAudit=await scoped(f.db,c,tx=>tx.audits());
  assert.equal(afterAudit.length,beforeAudit.length+2);
  assert(afterAudit.slice(-2).every(a=>a.type==="factual.correction_impact.read_checked"));
  assert.equal(verifyAudit(afterAudit),true);
  assert.equal(result.planningStorage!.revision, 1);
  assert.equal(result.impact.plans.length, 1);
});
test("outer request expiry under actual checked lock rolls back audit and cannot return report", async (t) => {
  const f = await fixture(t),
    x = change();
  await f.repo.append(c, 0, x.originalKnowledge, x.command, "plan");
  const initialAudit = await scoped(f.db, c, (tx) => tx.audits());
  let expired = false;
  f.hooks.read = () => {
    expired = true;
  };
  await assert.rejects(
    f.repo.loadCorrectionImpact(
      c,
      JSON.stringify(x.knowledge),
      x.before,
      x.after,
      undefined,
      10000,
      () => {
        if (expired) throw Error("host deadline diagnostic");
      },
    ),
    { code: "impact_unavailable", message: "Correction impact unavailable" },
  );
  f.hooks.read = null;
  assert.deepEqual(await scoped(f.db, c, (tx) => tx.audits()), initialAudit);
  assert.equal(
    (
      await f.repo.loadCorrectionImpact(
        c,
        JSON.stringify(x.knowledge),
        x.before,
        x.after,
      )
    ).planningStorage!.revision,
    1,
  );
});
test("nonvoid native rejected admission is observed before SQL; pre-cancelled read and bad sources deny", async (t) => {
  const f = await fixture(t),
    x = change();
  let reads = 0;
  f.hooks.read = () => {
    reads++;
  };
  await assert.rejects(
    f.repo.loadCorrectionImpact(
      c,
      JSON.stringify(x.knowledge),
      x.before,
      x.after,
      undefined,
      10000,
      () => Promise.reject(Error("private diagnostic")),
    ),
    { code: "impact_unavailable" },
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    f.repo.loadCorrectionImpact(
      c,
      JSON.stringify(x.knowledge),
      x.before,
      x.after,
      abort.signal,
    ),
    { code: "impact_unavailable" },
  );
  for (const source of [
    "{",
    "null",
    JSON.stringify({ ...x.knowledge, projectId: "foreign" }),
    " ".repeat(5 * 1024 * 1024 + 1),
  ])
    await assert.rejects(
      f.repo.loadCorrectionImpact(c, source, x.before, x.after),
    );
  assert.equal(reads, 2); // valid JSON null/foreign reach checked SQL then fail owning source validation.
});
test("current host admission denies unlisted humans roles purpose scope without changing stored histories", async (t) => {
  const f = await fixture(t),
    x = change();
  await f.repo.append(c, 0, x.originalKnowledge, x.command, "plan");
  for (const context of [
    { ...c, actor: { ...c.actor, id: "other" } },
    { ...c, actor: { ...c.actor, roles: ["viewer"] } },
    { ...c, purpose: "other" },
    { ...c, projectId: "other" },
  ])
    await assert.rejects(
      f.repo.loadCorrectionImpact(
        context,
        JSON.stringify(x.knowledge),
        x.before,
        x.after,
      ),
    );
  assert.equal((await f.repo.load(c)).revision, 1);
});
test("cancellation after committed owning read withholds result, without asserting rollback", async (t) => {
  const f = await fixture(t),
    x = change();
  await f.repo.append(c, 0, x.originalKnowledge, x.command, "plan");
  const controller = new AbortController();
  const db: Database = {
    ...f.db,
    transaction: async (fn) => {
      const value = await f.db.transaction(fn);
      controller.abort();
      return value;
    },
  };
  const repo = new FactualRepository(db, f.policy);
  await assert.rejects(
    repo.loadCorrectionImpact(
      c,
      JSON.stringify(x.knowledge),
      x.before,
      x.after,
      controller.signal,
    ),
    { code: "impact_unavailable" },
  );
  assert.equal((await f.repo.load(c)).revision, 1);
});

test("context and correction refs captured before actual own lock cannot be changed by caller", async (t) => {
  const f = await fixture(t),
    x = change();
  await f.repo.append(c, 0, x.originalKnowledge, x.command, "plan");
  const context = structuredClone(c),
    before = structuredClone(x.before),
    after = structuredClone(x.after);
  f.hooks.read = () => {
    Object.assign(context.actor, {id:"foreign"});
    Object.assign(before,{id:"foreign"});
    Object.assign(after,{revision:999});
  };
  const result = await f.repo.loadCorrectionImpact(
    context,
    JSON.stringify(x.knowledge),
    before,
    after,
  );
  assert.deepEqual(result.impact.before, x.before);
  assert.deepEqual(result.impact.after, x.after);
  assert.equal(result.impact.plans[0]!.status, "review-required");
});
test("blocked synchronous SQL admission cannot beat delayed deadline timer", async (t) => {
  const f = await fixture(t),
    x = change();
  await f.repo.append(c, 0, x.originalKnowledge, x.command, "plan");
  const audits = await scoped(f.db, c, (tx) => tx.audits());
  let seen = false;
  f.hooks.read = () => {
    seen = true;
    const until = performance.now() + 350;
    while (performance.now() < until) {}
  };
  await assert.rejects(
    f.repo.loadCorrectionImpact(
      c,
      JSON.stringify(x.knowledge),
      x.before,
      x.after,
      undefined,
      300,
    ),
    { code: "impact_unavailable" },
  );
  assert.equal(seen, true);
  f.hooks.read = null;
  assert.deepEqual(await scoped(f.db, c, (tx) => tx.audits()), audits);
});
