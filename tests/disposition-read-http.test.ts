import { QuestionDispositionRepository } from "../src/disposition-repository.ts";
import { IdentityQuestionDispositionRepository } from "../src/disposition-identity.ts";
import { createDispositionReadHandler } from "../src/disposition-read-http.ts";
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
    factual: (() => void | Promise<void>) | null;
  } = { identity: null, knowledge: null, lostFactual: false, factual: null };
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
            if (name === "factual_login") await hooks.factual?.();
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
    store: new QuestionDispositionRepository(factual, {
      ...fixed,
      humanIds: ["owner"],
    }),
    facade: new IdentityQuestionDispositionRepository(
      new QuestionDispositionRepository(factual, {
        ...fixed,
        humanIds: ["owner"],
      }),
      membership,
      fixed,
    ),
    fixed,
  };
}
const origin = "https://dispositions.invalid",
  base = origin + "/private/dispositions";
function post(selected: unknown, headers: Record<string, string> = {}) {
  return new Request(base + "/read", {
    method: "POST",
    headers: {
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "x-csrf-token": "fixture-csrf-token-0000000000000000000000",
      ...headers,
    },
    body: JSON.stringify({ selected }),
  });
}
async function ready(t: test.TestContext) {
  const f = await fixture(t),
    x = input();
  await f.membership.setResourcePolicy(c, 0, f.policy, "policy");
  const ack = await f.repo.append(c, 0, x.knowledge, x.command, "plan");
  await f.store.record(
    c,
    0,
    {
      planningStorage: ack.storage,
      effortStorage: null,
      review: {
        id: "review",
        expectedSequence: 0,
        supersedes: null,
        selected: ack.record,
        questions: [
          {
            questionId: "time",
            status: "deferred",
            reason: "Fixture unavailable",
            assigneeId: null,
            reviewAt: "2026-02-01T00:00:00.000Z",
          },
        ],
        reopeningTriggers: ["Authorized new records"],
      },
    },
    "review",
  );
  let calls = 0;
  const handler = createDispositionReadHandler(
    f.facade,
    f.membership,
    {
      authenticate: async () => {
        calls++;
        return {
          actorId: c.actor.id,
          requestId: c.requestId,
          csrfToken: "fixture-csrf-token-0000000000000000000000",
        };
      },
    },
    {
      tenantId: c.tenantId,
      projectId: c.projectId,
      purpose: c.purpose,
      origin,
    },
    () => c.now,
  );
  return { ...f, ack, handler, calls: () => calls };
}
test("actual dispositions HTTP returns only private current owning dispositions and fresh human session", async (t) => {
  const f = await ready(t);
  const session = await f.handler(new Request(base + "/session"));
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), {
    actorId: c.actor.id,
    csrfToken: "fixture-csrf-token-0000000000000000000000",
  });
  const response = await f.handler(post(f.ack.record));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body.planningStorage, f.ack.storage);
  assert.equal(body.effortStorage, null);
  assert.equal(body.table.questions[0].disposition.status, "deferred");
  assert.equal(body.table.history.length, 1);
  assert.equal(body.table.coverage.questions[0].status, "unresolved");
  assert.equal(Object.hasOwn(body, "command"), false);
});
test("HTTP admission rejects foreign routes origins fields and plan scope before session proofing", async (t) => {
  const f = await ready(t);
  for (const request of [
    post(f.ack.record, { origin: "https://other.invalid" }),
    post({ ...f.ack.record, kind: "claim" }),
    post({ ...f.ack.record, projectId: "foreign" }),
    new Request(base + "/write", { method: "POST" }),
    new Request(base + "/read", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: '{"selected":null,"allowed":true}',
    }),
  ])
    assert.notEqual((await f.handler(request)).status, 200);
  assert.equal(f.calls(), 0);
  assert.equal(
    (await f.handler(post(f.ack.record, { "x-csrf-token": "wrong" }))).status,
    403,
  );
});
test("current resource withdrawal and lost actual read acknowledgement withhold HTTP dispositions", async (t) => {
  const f = await ready(t);
  f.hooks.lostFactual = true;
  const uncertain = await f.handler(post(f.ack.record));
  assert.equal(uncertain.status, 503);
  assert.deepEqual(await uncertain.json(), {
    error: "dispositions_unavailable",
  });
  assert.equal((await f.handler(post(f.ack.record))).status, 200);
  await f.membership.setResourcePolicy(
    c,
    1,
    { ...f.policy, memberIds: [] },
    "revoke",
  );
  assert.equal((await f.handler(post(f.ack.record))).status, 503);
});

test("strict UTF8 byte/chunk and cancelled-body admission never reaches session proofing", async (t) => {
  const f = await ready(t),
    headers = {
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "x-csrf-token": "fixture-csrf-token-0000000000000000000000",
    };
  const chunks = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 4097; i++) controller.enqueue(new Uint8Array());
      controller.close();
    },
  });
  for (const body of [new Uint8Array([255]), "x".repeat(1025), chunks]) {
    const req = new Request(base + "/read", {
      method: "POST",
      headers,
      body,
      duplex: "half",
    } as RequestInit);
    assert.notEqual((await f.handler(req)).status, 200);
  }
  const cancel = new AbortController();
  cancel.abort();
  assert.equal(
    (
      await f.handler(
        new Request(base + "/read", {
          method: "POST",
          headers,
          body: JSON.stringify({ selected: f.ack.record }),
          signal: cancel.signal,
        }),
      )
    ).status,
    503,
  );
  assert.equal(f.calls(), 0);
});

test("policy withdrawn during a stalled body is freshly observed only after body admission", async (t) => {
  const f = await ready(t);
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      body = controller;
      controller.enqueue(new TextEncoder().encode('{"selected":'));
    },
  });
  const request = new Request(base + "/read", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "x-csrf-token": "fixture-csrf-token-0000000000000000000000",
    },
    body: stream,
    duplex: "half",
  } as RequestInit);
  const result = f.handler(request);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.calls(), 0);
  await f.membership.setResourcePolicy(
    c,
    1,
    { ...f.policy, memberIds: [] },
    "withdraw-during-body",
  );
  body.enqueue(new TextEncoder().encode(JSON.stringify(f.ack.record) + "}"));
  body.close();
  assert.equal((await result).status, 503);
  assert.equal(f.calls(), 1);
});

test("blocked late proofing cannot return a session and every proofing signal closes", async (t) => {
  const f = await ready(t);
  let seen: AbortSignal | undefined;
  const handler = createDispositionReadHandler(
    f.facade,
    f.membership,
    {
      authenticate: async (_meta, signal) => {
        seen = signal;
        const until = performance.now() + 40;
        while (performance.now() < until) {}
        return {
          actorId: c.actor.id,
          requestId: c.requestId,
          csrfToken: "fixture-csrf-token-0000000000000000000000",
        };
      },
    },
    {
      tenantId: c.tenantId,
      projectId: c.projectId,
      purpose: c.purpose,
      origin,
      timeoutMs: 10,
    },
    () => c.now,
  );
  const response = await handler(new Request(base + "/session"));
  assert.equal(response.status, 503);
  assert.equal(seen?.aborted, true);
  assert.deepEqual(await response.json(), {
    error: "dispositions_unavailable",
  });
});

test("HTTP outer deadline reaches actual owning checked lock and rolls back late checked read audit", async (t) => {
  const f = await ready(t);
  let observed = false;
  const before = await scoped(f.factual, c, (tx) => tx.audits());
  const db: Database = {
    transaction: (fn) =>
      f.factual.transaction((q) =>
        fn({
          query: async <T>(sql: string, values?: unknown[]) => {
            const r = await q.query<T>(sql, values);
            if (values?.includes("factual.question_review.read_checked")) {
              observed = true;
              const end = performance.now() + 150;
              while (performance.now() < end) {}
            }
            return r;
          },
        }),
      ),
    close: () => f.factual.close(),
  };
  const actual = new IdentityQuestionDispositionRepository(
    new QuestionDispositionRepository(db, { ...f.fixed, humanIds: ["owner"] }),
    f.membership,
    f.fixed,
  );
  const handler = createDispositionReadHandler(
    actual,
    f.membership,
    {
      authenticate: async () => ({
        actorId: c.actor.id,
        requestId: c.requestId,
        csrfToken: "fixture-csrf-token-0000000000000000000000",
      }),
    },
    { ...f.fixed, origin, timeoutMs: 100 },
    () => c.now,
  );
  const response = await handler(post(f.ack.record));
  assert.equal(response.status, 503);
  assert(observed);
  const after = await scoped(f.factual, c, (tx) => tx.audits());
  assert.equal(after.length, before.length);
});
