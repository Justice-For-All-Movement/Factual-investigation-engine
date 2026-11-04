import {
  KnowledgeRepository,
  KNOWLEDGE_KIND,
  KNOWLEDGE_KEY,
} from "@accountability/knowledge-verification/repository";
import {
  IdentityKnowledgeRepository,
  KNOWLEDGE_RESOURCE_ID,
} from "@accountability/knowledge-verification/identity-repository";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { scoped } from "@accountability/evidence-sql/database";
import type { Database } from "@accountability/evidence-sql/database";
import * as k from "@accountability/knowledge-verification";
import type { Context } from "@accountability/knowledge-verification/contracts";
import { MembershipRegistry } from "@accountability/identity-policy/membership";
import {
  FactualRepository,
  PLANNING_KIND,
  PLANNING_KEY,
  EFFORT_KIND,
  EFFORT_KEY,
} from "../src/repository.ts";
import type { PlanningCommand } from "../src/repository.ts";
import {
  IdentityFactualRepository,
  FACTUAL_RESOURCE_ID,
} from "../src/identity-repository.ts";
const c: Context = {
  tenantId: "fiction",
  projectId: "factual",
  actor: { id: "owner", kind: "human", roles: ["owner"] },
  purpose: "review",
  requestId: "r",
  now: "2026-01-01T00:00:00Z",
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
async function fixture(t: test.TestContext, upstream = false) {
  const hooks: {
    identity: (() => void) | null;
    knowledge: (() => void | Promise<void>) | null;
    lostFactual: boolean;
  } = { identity: null, knowledge: null, lostFactual: false };
  async function database(name: string): Promise<Database> {
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
      `CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT evidence_runtime TO ${name}; SET SESSION AUTHORIZATION ${name}`,
    );
    t.after(() => pg.close());
    return {
      transaction: (fn) =>
        pg
          .transaction((query) =>
            fn({
              query: async <T>(s: string, v?: unknown[]) => ({
                rows: (await query.query(s, v)).rows as T[],
              }),
            }),
          )
          .then(async (x) => {
            if (name === "identity_login") hooks.identity?.();
            if (name === "knowledge_login") await hooks.knowledge?.();
            if (name === "factual_login" && hooks.lostFactual) {
              hooks.lostFactual = false;
              throw Error("Lost real Factual COMMIT acknowledgement");
            }
            return x;
          }),
      close: () => pg.close(),
    };
  }
  const identity = await database("identity_login"),
    factual = await database("factual_login");
  const membership = new MembershipRegistry(
    identity,
    {
      tenantId: c.tenantId,
      projectId: c.projectId,
      bootstrapOwnerIds: ["owner"],
    },
    () => c.now,
  );
  await membership.initialize(c, "init");
  const policy = {
    resourceId: FACTUAL_RESOURCE_ID,
    memberIds: ["owner"],
    purposes: [c.purpose],
    actions: ["investigate" as const],
  };
  const repo = new FactualRepository(factual, {
    tenantId: c.tenantId,
    projectId: c.projectId,
    humanIds: ["owner"],
    purpose: c.purpose,
  });
  const fixed = {
    tenantId: c.tenantId,
    projectId: c.projectId,
    purpose: c.purpose,
  };
  const knowledge = upstream ? await database("knowledge_login") : null;
  const kRepo = knowledge
    ? new KnowledgeRepository(knowledge, { ...fixed, humanIds: ["owner"] })
    : null;
  const kFacade = kRepo
    ? new IdentityKnowledgeRepository(kRepo, membership, fixed)
    : null;
  return {
    knowledge,
    kRepo,
    kFacade,
    identity,
    factual,
    membership,
    policy,
    repo,
    hooks,
    facade: new IdentityFactualRepository(repo, membership, fixed),
    fixed,
  };
}
test("actual separate Identity/Factual DBs and default-deny policy guard plans and effort methods including replay", async (t) => {
  const f = await fixture(t),
    x = input();
  await assert.rejects(f.facade.load(c), { code: "identity_unavailable" });
  await assert.rejects(f.facade.loadEfforts(c), {
    code: "identity_unavailable",
  });
  await assert.rejects(f.facade.append(c, 0, x.knowledge, x.command, "plan"), {
    code: "identity_unavailable",
  });
  await f.membership.setResourcePolicy(c, 0, f.policy, "allow");
  const empty = { ...c, actor: { ...c.actor, roles: [] } },
    plan = (await f.facade.append(empty, 0, x.knowledge, x.command, "plan"))
      .record;
  const effort = {
    id: "attempt",
    expectedSequence: 0,
    plan,
    questionId: "time",
    leadId: "log",
    outcome: "attempted" as const,
    detail: "Unresolved fictional attempt",
    corrects: null,
  };
  const ack = await f.facade.recordEffort(empty, 0, effort, "attempt");
  assert.equal((await f.facade.loadEfforts(empty)).revision, 1);
  assert.equal((await f.facade.load(empty)).revision, 1);
  await scoped(f.identity, c, async (tx) => {
    assert.equal(await tx.get(PLANNING_KIND, PLANNING_KEY), null);
    assert.equal(await tx.get(EFFORT_KIND, EFFORT_KEY), null);
  });
  await scoped(f.factual, c, async (tx) =>
    assert.equal((await tx.list("identity-membership")).length, 0),
  );
  await f.membership.setResourcePolicy(
    c,
    1,
    { ...f.policy, actions: [] },
    "revoke",
  );
  for (const op of [
    () => f.facade.load(c),
    () => f.facade.loadEfforts(c),
    () => f.facade.append(c, 0, x.knowledge, x.command, "plan"),
    () => f.facade.recordEffort(c, 0, effort, "attempt"),
  ])
    await assert.rejects(op(), { code: "identity_unavailable" });
  assert.equal(ack.storage.revision, 1);
  assert.equal((await f.repo.loadEfforts(c)).revision, 1);
});
test("stored demotion rejects forged host owner roles on cached planning replay", async (t) => {
  const f = await fixture(t),
    x = input();
  await f.membership.setResourcePolicy(c, 0, f.policy, "allow");
  await f.facade.append(c, 0, x.knowledge, x.command, "plan");
  await f.membership.apply(
    c,
    1,
    { type: "set-member", id: "second", kind: "human", roles: ["owner"] },
    "second",
  );
  await f.membership.apply(
    { ...c, actor: { ...c.actor, id: "second" } },
    2,
    { type: "set-member", id: "owner", kind: "human", roles: ["viewer"] },
    "demote",
  );
  await assert.rejects(f.facade.append(c, 0, x.knowledge, x.command, "plan"), {
    code: "identity_unavailable",
  });
  assert.equal((await f.repo.load(c)).revision, 1);
});
test("late cancelled and lost real Identity SQL acknowledgement cannot start Factual writes", async (t) => {
  const f = await fixture(t),
    x = input();
  await f.membership.setResourcePolicy(c, 0, f.policy, "allow");
  const controller = new AbortController();
  f.hooks.identity = () => controller.abort();
  await assert.rejects(
    f.facade.append(c, 0, x.knowledge, x.command, "cancel", controller.signal),
    { code: "identity_unavailable" },
  );
  f.hooks.identity = () => {
    throw Error("private driver detail");
  };
  await assert.rejects(f.facade.append(c, 0, x.knowledge, x.command, "lost"), {
    code: "identity_unavailable",
    message: "Current Identity observation unavailable",
  });
  f.hooks.identity = () => {
    const until = performance.now() + 30;
    while (performance.now() < until) {}
  };
  const bounded = new IdentityFactualRepository(
    f.repo,
    f.membership,
    f.fixed,
    10,
  );
  await assert.rejects(bounded.append(c, 0, x.knowledge, x.command, "late"), {
    code: "identity_unavailable",
  });
  assert.equal((await f.repo.load(c)).revision, 0);
  assert.equal((await f.repo.loadEfforts(c)).revision, 0);
});
test("captured upstream commands receiver and fixed context binding reject caller mutation or foreign profiles", async (t) => {
  const f = await fixture(t),
    x = input();
  await f.membership.setResourcePolicy(c, 0, f.policy, "allow");
  const cmd = structuredClone(x.command),
    source = structuredClone(x.knowledge),
    ctx = structuredClone(c);
  const pending = f.facade.append(ctx, 0, source, cmd, "plan");
  Object.assign(cmd, { id: "mutated" });
  Object.assign(source.records[0]!.ref, { revision: 99 });
  Object.assign(ctx.actor, { id: "other" });
  assert.equal((await pending).record.id, "plan");
  for (const bad of [
    { ...c, purpose: "other" },
    { ...c, projectId: "foreign" },
    { ...c, actor: { ...c.actor, kind: "agent" as const } },
  ])
    await assert.rejects(f.facade.load(bad));
  const fixed = structuredClone(f.fixed),
    facade = new IdentityFactualRepository(f.repo, f.membership, fixed);
  fixed.purpose = "other";
  assert.equal((await facade.load(c)).revision, 1);
});

test("current Knowledge path uses three separate owning DBs, denies missing source policy and rejects stale claim editions", async (t) => {
  const f = await fixture(t, true),
    x = input();
  await f.membership.setResourcePolicy(c, 0, f.policy, "factual-allow");
  const facade = new IdentityFactualRepository(
    f.repo,
    f.membership,
    f.fixed,
    10000,
    f.kFacade!,
  );
  await f.kRepo!.append(
    c,
    0,
    { id: "claim", expectedRevision: 0, value: claim },
    "claim",
  );
  await assert.rejects(facade.appendFromKnowledge(c, 0, x.command, "plan"), {
    code: "knowledge_unavailable",
  });
  assert.equal((await f.repo.load(c)).revision, 0);
  await f.membership.setResourcePolicy(
    c,
    1,
    { ...f.policy, resourceId: KNOWLEDGE_RESOURCE_ID },
    "knowledge-allow",
  );
  const ack = await facade.appendFromKnowledge(c, 0, x.command, "plan");
  assert.equal(ack.record.id, "plan");
  await f.kRepo!.append(
    c,
    1,
    { id: "claim", expectedRevision: 1, value: claim },
    "revise-claim",
  );
  await assert.rejects(
    facade.appendFromKnowledge(c, 1, { ...x.command, id: "other" }, "stale"),
    { code: "stale_claim" },
  );
  await scoped(f.factual, c, async (tx) =>
    assert.equal(await tx.get(KNOWLEDGE_KIND, KNOWLEDGE_KEY), null),
  );
  await scoped(f.knowledge!, c, async (tx) =>
    assert.equal(await tx.get(PLANNING_KIND, PLANNING_KEY), null),
  );
  await f.membership.setResourcePolicy(
    c,
    2,
    { ...f.policy, resourceId: KNOWLEDGE_RESOURCE_ID, actions: [] },
    "source-revoke",
  );
  await assert.rejects(facade.appendFromKnowledge(c, 0, x.command, "plan"), {
    code: "knowledge_unavailable",
  });
  assert.equal((await f.repo.load(c)).revision, 1);
});

test("upstream lost late or cancelled acknowledgement prevents Factual writes and current Factual policy is rechecked after Knowledge", async (t) => {
  const f = await fixture(t, true),
    x = input();
  await f.membership.setResourcePolicy(c, 0, f.policy, "factual-allow");
  await f.membership.setResourcePolicy(
    c,
    1,
    { ...f.policy, resourceId: KNOWLEDGE_RESOURCE_ID },
    "knowledge-allow",
  );
  await f.kRepo!.append(
    c,
    0,
    { id: "claim", expectedRevision: 0, value: claim },
    "claim",
  );
  const facade = new IdentityFactualRepository(
    f.repo,
    f.membership,
    f.fixed,
    10000,
    f.kFacade!,
  );
  f.hooks.knowledge = () => {
    throw Error("private upstream detail");
  };
  await assert.rejects(facade.appendFromKnowledge(c, 0, x.command, "lost"), {
    code: "knowledge_unavailable",
    message: "Current Knowledge observation unavailable",
  });
  const control = new AbortController();
  f.hooks.knowledge = () => control.abort();
  await assert.rejects(
    facade.appendFromKnowledge(c, 0, x.command, "cancel", control.signal),
    { code: "knowledge_unavailable" },
  );
  f.hooks.knowledge = () => {
    const until = performance.now() + 600;
    while (performance.now() < until) {}
  };
  await assert.rejects(
    new IdentityFactualRepository(
      f.repo,
      f.membership,
      f.fixed,
      50,
      f.kFacade!,
    ).appendFromKnowledge(c, 0, x.command, "late"),
    { code: "knowledge_unavailable" },
  );
  f.hooks.knowledge = async () => {
    f.hooks.knowledge = null;
    await f.membership.setResourcePolicy(
      c,
      2,
      { ...f.policy, actions: [] },
      "factual-revoke",
    );
  };
  await assert.rejects(
    facade.appendFromKnowledge(c, 0, x.command, "revoked-after-source"),
    { code: "identity_unavailable" },
  );
  assert.equal((await f.repo.load(c)).revision, 0);
});

test("current Knowledge path captures inputs, preserves lost Factual commit history and requires both gates before replay", async (t) => {
  const f = await fixture(t, true),
    x = input();
  await f.membership.setResourcePolicy(c, 0, f.policy, "factual-allow");
  await f.membership.setResourcePolicy(
    c,
    1,
    { ...f.policy, resourceId: KNOWLEDGE_RESOURCE_ID },
    "knowledge-allow",
  );
  await f.kRepo!.append(
    c,
    0,
    { id: "claim", expectedRevision: 0, value: claim },
    "claim",
  );
  const facade = new IdentityFactualRepository(
      f.repo,
      f.membership,
      f.fixed,
      10000,
      f.kFacade!,
    ),
    cmd = structuredClone(x.command);
  const pending = facade.appendFromKnowledge(c, 0, cmd, "plan");
  Object.assign(cmd, { id: "mutated" });
  f.hooks.lostFactual = true;
  await assert.rejects(pending);
  assert.equal((await f.repo.load(c)).revision, 1);
  const ack = await facade.appendFromKnowledge(c, 0, x.command, "plan");
  assert.equal(ack.record.id, "plan");
  await assert.rejects(f.facade.appendFromKnowledge(c, 0, x.command, "plan"), {
    code: "knowledge_unavailable",
  });
  assert.equal((await f.repo.load(c)).revision, 1);
});

async function reviewFixture(t: test.TestContext) {
  const f = await fixture(t, true),
    x = input();
  await f.membership.setResourcePolicy(c, 0, f.policy, "allow-factual");
  await f.membership.setResourcePolicy(
    c,
    1,
    { ...f.policy, resourceId: KNOWLEDGE_RESOURCE_ID },
    "allow-source",
  );
  await f.kRepo!.append(
    c,
    0,
    { id: "claim", expectedRevision: 0, value: claim },
    "claim",
  );
  const facade = new IdentityFactualRepository(
    f.repo,
    f.membership,
    f.fixed,
    10000,
    f.kFacade!,
  );
  const plan = (await facade.appendFromKnowledge(c, 0, x.command, "plan"))
    .record;
  return { ...f, x, facade, plan };
}
test("owning dependency review reports exact stored editions and current changed claims without mutating plans", async (t) => {
  const f = await reviewFixture(t);
  const first = await f.facade.reviewKnowledge(c, f.plan);
  assert.equal(first.planningRevision, 1);
  assert.equal(first.knowledgeRevision, 1);
  assert.equal(first.review.nodes[0]!.status, "current-edition");
  await f.kRepo!.append(
    c,
    1,
    { id: "claim", expectedRevision: 1, value: claim },
    "changed",
  );
  const result = await f.facade.reviewKnowledge(
    { ...c, actor: { ...c.actor, roles: [] } },
    f.plan,
  );
  assert.equal(result.knowledgeRevision, 2);
  assert.equal(result.review.nodes[0]!.status, "changed-edition");
  assert.equal(result.review.nodes[0]!.ref.revision, 1);
  assert.equal(result.review.nodes[0]!.latestRef!.revision, 2);
  (result.review.nodes as unknown[]).length = 0;
  assert.equal(
    (await f.facade.reviewKnowledge(c, f.plan)).review.nodes.length,
    1,
  );
  assert.equal((await f.repo.load(c)).revision, 1);
  await assert.rejects(
    f.facade.reviewKnowledge(c, { ...f.plan, projectId: "foreign" }),
    { code: "scope_denied" },
  );
  await assert.rejects(
    new IdentityFactualRepository(
      f.repo,
      f.membership,
      f.fixed,
    ).reviewKnowledge(c, f.plan),
    { code: "knowledge_unavailable" },
  );
});
test("owning review denies source revocation unknown acknowledgement cancellation and changed planning basis", async (t) => {
  const f = await reviewFixture(t);
  f.hooks.knowledge = () => {
    throw Error("private SQL detail");
  };
  await assert.rejects(f.facade.reviewKnowledge(c, f.plan), {
    code: "knowledge_unavailable",
    message: "Current Knowledge observation unavailable",
  });
  const control = new AbortController();
  f.hooks.knowledge = () => control.abort();
  await assert.rejects(f.facade.reviewKnowledge(c, f.plan, control.signal), {
    code: "knowledge_unavailable",
  });
  f.hooks.knowledge = async () => {
    f.hooks.knowledge = null;
    await f.repo.append(
      c,
      1,
      f.x.knowledge,
      { ...f.x.command, id: "another" },
      "another",
    );
  };
  await assert.rejects(f.facade.reviewKnowledge(c, f.plan), {
    code: "planning_changed",
  });
  assert.equal((await f.repo.load(c)).revision, 2);
  await f.membership.setResourcePolicy(
    c,
    2,
    { ...f.policy, resourceId: KNOWLEDGE_RESOURCE_ID, actions: [] },
    "revoke-source",
  );
  await assert.rejects(f.facade.reviewKnowledge(c, f.plan), {
    code: "knowledge_unavailable",
  });
});
test("owning review reauthorizes Factual after Knowledge and fences late acknowledged reads", async (t) => {
  const f = await reviewFixture(t);
  f.hooks.knowledge = () => {
    const end = performance.now() + 100;
    while (performance.now() < end) {}
  };
  const bounded = new IdentityFactualRepository(
    f.repo,
    f.membership,
    f.fixed,
    50,
    f.kFacade!,
  );
  await assert.rejects(bounded.reviewKnowledge(c, f.plan), {
    code: "knowledge_unavailable",
  });
  f.hooks.knowledge = async () => {
    f.hooks.knowledge = null;
    await f.membership.setResourcePolicy(
      c,
      2,
      { ...f.policy, actions: [] },
      "revoke-factual",
    );
  };
  await assert.rejects(f.facade.reviewKnowledge(c, f.plan), {
    code: "identity_unavailable",
  });
  assert.equal((await f.repo.load(c)).revision, 1);
});
