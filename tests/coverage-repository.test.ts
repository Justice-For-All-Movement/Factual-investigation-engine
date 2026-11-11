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
  const hooks = { lost: false, rollback: false };
  const db: Database = {
    transaction: (fn) =>
      pg
        .transaction(async (query) => {
          const value = await fn({
            query: async <T>(sql: string, values?: unknown[]) => {
              const result = await query.query(sql, values);
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

test("owning coverage preserves exact storage editions, empty effort null, and checked audit only", async t=>{
 const f=await fixture(t),x=input(),ack=await f.repo.append(c,0,x.knowledge,x.command,"plan");
 const d=await f.repo.loadCoverage(c,ack.record);assert.deepEqual(d.planningStorage,ack.storage);assert.equal(d.effortStorage,null);assert.equal(d.coverage.questions[0]!.status,"unresolved");
 const e=await f.repo.recordEffort(c,0,{id:"attempt",expectedSequence:0,plan:ack.record,questionId:"time",leadId:"log",outcome:"unavailable",detail:"Synthetic assertion only",corrects:null},"effort");
 const after=await f.repo.loadCoverage(c,ack.record);assert.deepEqual(after.effortStorage,e.storage);assert.equal(after.coverage.effortHistory.length,1);
});
test("owning coverage denies cancellation, stale selection and lost read COMMIT without changing stored histories", async t=>{
 const f=await fixture(t),x=input(),ack=await f.repo.append(c,0,x.knowledge,x.command,"plan");
 const abort=new AbortController();abort.abort();await assert.rejects(f.repo.loadCoverage(c,ack.record,abort.signal),{code:"coverage_unavailable"});
 f.hooks.lost=true;await assert.rejects(f.repo.loadCoverage(c,ack.record));assert.equal((await f.repo.loadCoverage(c,ack.record)).planningStorage.revision,1);
 await f.repo.append(c,1,x.knowledge,{...x.command,expectedRevision:1},"next");await assert.rejects(f.repo.loadCoverage(c,ack.record),{code:"stale_plan"});
});
