import test from "node:test";
import assert from "node:assert/strict";
import { fixture, input, c } from "./disposition-identity-fixture.ts";
import { CurrentCorrectionImpactReader } from "../src/correction-impact-current.ts";
import { KNOWLEDGE_RESOURCE_ID } from "@accountability/knowledge-verification/identity-repository";
import { scoped } from "@accountability/evidence-sql/database";

async function setup(t: test.TestContext, timeout = 10000) {
  const f = await fixture(t, true),
    x = input();
  await f.membership.setResourcePolicy(c, 0, f.policy, "factual-policy");
  const sourcePolicy = {
    resourceId: KNOWLEDGE_RESOURCE_ID,
    memberIds: [c.actor.id],
    purposes: [c.purpose],
    actions: ["investigate" as const],
  };
  await f.membership.setResourcePolicy(c, 1, sourcePolicy, "knowledge-policy");
  const first = await f.kRepo!.append(
    c,
    0,
    { id: "claim", expectedRevision: 0, value: x.knowledge.records[0]!.value },
    "claim",
  );
  const plan = await f.repo.append(c, 0, x.knowledge, x.command, "plan");
  const second = await f.kRepo!.append(
    c,
    1,
    {
      id: "claim",
      expectedRevision: 1,
      value: { ...x.knowledge.records[0]!.value },
    },
    "corrected",
  );
  const reader = new CurrentCorrectionImpactReader(
    f.repo,
    f.membership,
    f.kFacade!,
    f.fixed,
    timeout,
  );
  return { ...f, x, first, second, plan, reader, sourcePolicy };
}
test("actual three owning DBs bind current stored human and complete exact Knowledge/planning editions", async (t) => {
  const f = await setup(t);
  const result = await f.reader.read(
    { ...c, actor: { ...c.actor, roles: [] } },
    f.first.record,
    f.second.record,
  );
  assert.deepEqual(result.planningStorage, f.plan.storage);
  assert.deepEqual(result.knowledgeStorage, f.second.storage);
  assert.equal(result.impact.plans[0]!.status, "review-required");
  assert.equal(
    result.impact.plans[0]!.review.nodes[0]!.status,
    "changed-edition",
  );
  assert.deepEqual(result.impact.plans[0]!.affectedRefs, [f.first.record]);
  const audits = await scoped(f.factual, c, (tx) => tx.audits());
  assert.equal(
    audits.filter((a) => a.type === "factual.correction_impact.read_checked")
      .length,
    2,
  );
  Object.assign(result.impact.plans[0]!.plan, { id: "copy" });
  assert.equal((await f.repo.load(c)).revision, 1);
});
test("current default-deny source policy and actual Factual policy withdrawal deny every read", async (t) => {
  const f = await setup(t);
  await f.membership.setResourcePolicy(
    c,
    2,
    { ...f.sourcePolicy, memberIds: [] },
    "deny-source",
  );
  await assert.rejects(f.reader.read(c, f.first.record, f.second.record), {
    code: "impact_unavailable",
  });
  await f.membership.setResourcePolicy(c, 3, f.sourcePolicy, "restore-source");
  await f.membership.setResourcePolicy(
    c,
    4,
    { ...f.policy, memberIds: [] },
    "deny-factual",
  );
  await assert.rejects(f.reader.read(c, f.first.record, f.second.record), {
    code: "impact_unavailable",
  });
});
test("whole Knowledge revision changes during source observation deny without source fallback", async (t) => {
  const f = await setup(t);
  f.hooks.knowledge = async () => {
    f.hooks.knowledge = null;
    await f.kRepo!.append(
      c,
      2,
      {
        id: "unrelated",
        expectedRevision: 0,
        value: f.x.knowledge.records[0]!.value,
      },
      "new-source",
    );
  };
  await assert.rejects(f.reader.read(c, f.first.record, f.second.record), {
    code: "impact_unavailable",
  });
  assert.equal((await f.repo.load(c)).revision, 1);
});
test("whole owning planning change after first read denies even when all selected claim refs unchanged", async (t) => {
  const f = await setup(t);
  f.hooks.factual = async () => {
    f.hooks.factual = null;
    await f.repo.append(
      c,
      1,
      f.x.knowledge,
      {
        ...f.x.command,
        expectedRevision: 1,
        value: { ...f.x.command.value, title: "Changed plan basis" },
      },
      "change",
    );
  };
  await assert.rejects(f.reader.read(c, f.first.record, f.second.record), {
    code: "impact_unavailable",
  });
  assert.equal((await f.repo.load(c)).revision, 2);
});
test("actual lost owning read COMMIT and cancellation withhold copy; explicit later read starts fresh", async (t) => {
  const f = await setup(t);
  f.hooks.lostFactual = true;
  await assert.rejects(f.reader.read(c, f.first.record, f.second.record), {
    code: "impact_unavailable",
  });
  assert.deepEqual(
    (await f.reader.read(c, f.first.record, f.second.record)).planningStorage,
    f.plan.storage,
  );
  const controller = new AbortController();
  f.hooks.factual = () => {
    f.hooks.factual = null;
    controller.abort();
  };
  await assert.rejects(
    f.reader.read(c, f.first.record, f.second.record, controller.signal),
    { code: "impact_unavailable" },
  );
});
test("foreign and nonconsecutive refs, nonvoid admission and prototype forgeries cannot bypass current authority", async (t) => {
  const f = await setup(t);
  let calls = 0;
  f.hooks.identity = () => {
    calls++;
  };
  await assert.rejects(
    f.reader.read(
      c,
      { ...f.first.record, projectId: "foreign" },
      f.second.record,
    ),
    { code: "impact_unavailable" },
  );
  await assert.rejects(
    f.reader.read(c, f.first.record, { ...f.second.record, revision: 3 }),
    { code: "impact_unavailable" },
  );
  await assert.rejects(
    f.reader.read(c, f.first.record, f.second.record, undefined, () =>
      Promise.reject(Error("secret")),
    ),
    { code: "impact_unavailable" },
  );
  assert.equal(calls, 0);
  f.hooks.identity = null;
  Object.assign(f.kFacade!, {
    load: () => {
      throw Error("forged source");
    },
  });
  Object.assign(f.repo, {
    loadCorrectionImpact: () => {
      throw Error("forged own");
    },
  });
  Object.assign(f.membership, {
    resolveResource: () => {
      throw Error("forged Identity");
    },
  });
  const reader = new CurrentCorrectionImpactReader(
    f.repo,
    f.membership,
    f.kFacade!,
    f.fixed,
  );
  assert.deepEqual(
    (await reader.read(c, f.first.record, f.second.record)).knowledgeStorage,
    f.second.storage,
  );
});

test("source policy withdrawn during actual Knowledge read denies before any owning impact copy", async (t) => {
  const f = await setup(t);
  f.hooks.knowledge = async () => {
    f.hooks.knowledge = null;
    await f.membership.setResourcePolicy(
      c,
      2,
      { ...f.sourcePolicy, memberIds: [] },
      "withdraw-during-read",
    );
  };
  await assert.rejects(f.reader.read(c, f.first.record, f.second.record), {
    code: "impact_unavailable",
  });
  const audits = await scoped(f.factual, c, (tx) => tx.audits());
  assert.equal(
    audits.filter((a) => a.type === "factual.correction_impact.read_checked")
      .length,
    0,
  );
});
test("actual source lost COMMIT diagnostic and final Factual withdrawal are sanitized and withheld", async (t) => {
  const f = await setup(t);
  f.hooks.knowledge = () => {
    f.hooks.knowledge = null;
    throw Error("private source diagnostic");
  };
  await assert.rejects(f.reader.read(c, f.first.record, f.second.record), {
    code: "impact_unavailable",
    message: "Current correction impact unavailable",
  });
  f.hooks.factual = async () => {
    f.hooks.factual = null;
    await f.membership.setResourcePolicy(
      c,
      2,
      { ...f.policy, memberIds: [] },
      "withdraw-after-own",
    );
  };
  await assert.rejects(f.reader.read(c, f.first.record, f.second.record), {
    code: "impact_unavailable",
  });
});

test("overall outer request gate reaches actual owning SQL lock and rolls back only its checked audit", async (t) => {
  const f = await setup(t);
  const audits = await scoped(f.factual, c, (tx) => tx.audits());
  let expired = false,
    seen = false;
  const { FactualRepository } = await import("../src/repository.ts");
  const db: import("@accountability/evidence-sql/database").Database = {
    ...f.factual,
    transaction: (fn) =>
      f.factual.transaction((q) =>
        fn({
          query: async <T>(sql: string, values?: unknown[]) => {
            const result = await q.query<T>(sql, values);
            if (values?.includes("factual.correction_impact.read_checked")) {
              seen = true;
              expired = true;
            }
            return result;
          },
        }),
      ),
  };
  const repo = new FactualRepository(db, {
    ...f.fixed,
    humanIds: [c.actor.id],
  });
  const reader = new CurrentCorrectionImpactReader(
    repo,
    f.membership,
    f.kFacade!,
    f.fixed,
  );
  await assert.rejects(
    reader.read(c, f.first.record, f.second.record, undefined, () => {
      if (expired) throw Error("private request clock diagnostic");
    }),
    {
      code: "impact_unavailable",
      message: "Current correction impact unavailable",
    },
  );
  assert.equal(seen, true);
  assert.deepEqual(await scoped(f.factual, c, (tx) => tx.audits()), audits);
});
test("blocked late Knowledge acknowledgement cannot beat delayed timeout timer or reach owning read", async (t) => {
  const f = await setup(t, 500);
  let seen = false;
  f.hooks.knowledge = () => {
    f.hooks.knowledge = null;
    seen = true;
    const until = performance.now() + 600;
    while (performance.now() < until) {}
  };
  await assert.rejects(f.reader.read(c, f.first.record, f.second.record), {
    code: "impact_unavailable",
  });
  assert.equal(seen, true);
  assert.equal(
    (await scoped(f.factual, c, (tx) => tx.audits())).filter(
      (a) => a.type === "factual.correction_impact.read_checked",
    ).length,
    0,
  );
});
