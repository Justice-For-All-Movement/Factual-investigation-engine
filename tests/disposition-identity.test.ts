import test from "node:test";
import assert from "node:assert/strict";
import { fixture, input, c } from "./disposition-identity-fixture.ts";
import { QuestionDispositionRepository } from "../src/disposition-repository.ts";
import type { DispositionCommand } from "../src/disposition-repository.ts";
import { IdentityQuestionDispositionRepository } from "../src/disposition-identity.ts";
async function setup(t: test.TestContext, timeout = 10000) {
  const f = await fixture(t),
    x = input();
  await f.membership.setResourcePolicy(c, 0, f.policy, "policy");
  const plan = await f.repo.append(c, 0, x.knowledge, x.command, "plan");
  const store = new QuestionDispositionRepository(f.factual, {
    ...f.fixed,
    humanIds: ["owner"],
  });
  const facade = new IdentityQuestionDispositionRepository(
    store,
    f.membership,
    f.fixed,
    timeout,
  );
  const command: DispositionCommand = {
    planningStorage: plan.storage,
    effortStorage: null,
    review: {
      id: "review",
      expectedSequence: 0,
      supersedes: null,
      selected: plan.record,
      questions: [
        {
          questionId: "time",
          status: "deferred",
          reason: "Fixture records unavailable",
          assigneeId: null,
          reviewAt: "2026-02-01T00:00:00.000Z",
        },
      ],
      reopeningTriggers: ["New authorized fixture records"],
    },
  };
  return { ...f, store, facade, command, plan };
}
test("actual separate Identity/Factual stores authorize empty incoming roles and deny revoked resource policy before cached replay", async (t) => {
  const f = await setup(t),
    ctx = { ...c, actor: { ...c.actor, roles: [] } };
  const ack = await f.facade.record(ctx, 0, f.command, "record");
  assert.equal(
    (await f.facade.load(ctx, f.plan.record)).table.reviewRequired,
    null,
  );
  await f.membership.setResourcePolicy(
    c,
    1,
    { ...f.policy, memberIds: [] },
    "revoke",
  );
  await assert.rejects(f.facade.record(c, 0, f.command, "record"), {
    code: "disposition_unavailable",
  });
  await assert.rejects(f.facade.load(c, f.plan.record), {
    code: "disposition_unavailable",
  });
  assert.deepEqual(await f.store.record(c, 0, f.command, "record"), ack); // Direct HOST-trusted legacy path is explicitly separate.
});
test("fresh current Identity after owning read withholds data revoked during that actual read", async (t) => {
  const f = await setup(t);
  await f.facade.record(c, 0, f.command, "record");
  f.hooks.factual = async () => {
    f.hooks.factual = null;
    await f.membership.setResourcePolicy(
      c,
      1,
      { ...f.policy, memberIds: [] },
      "revoke",
    );
  };
  await assert.rejects(f.facade.load(c, f.plan.record), {
    code: "disposition_unavailable",
  });
  assert.equal((await f.store.load(c, f.plan.record)).table.history.length, 1);
});
test("lost owning COMMIT is unknown and explicit identical replay commits no second review; cancellation after ACK retains ACK", async (t) => {
  const f = await setup(t);
  f.hooks.lostFactual = true;
  await assert.rejects(f.facade.record(c, 0, f.command, "lost"), {
    code: "disposition_write_unknown",
  });
  const ack = await f.facade.record(c, 0, f.command, "lost");
  assert.equal(ack.storage.revision, 1);
  const aborted = new AbortController();
  f.hooks.factual = () => {
    f.hooks.factual = null;
    aborted.abort();
  };
  const cached = await f.facade.record(c, 0, f.command, "lost", aborted.signal);
  assert.deepEqual(cached, ack);
  assert.equal((await f.store.load(c, f.plan.record)).table.history.length, 1);
});
test("late Identity SQL denies before owning writes and forged instance methods cannot replace prototype-bound authority", async (t) => {
  const f = await setup(t, 20);
  f.hooks.identity = () => {
    const end = performance.now() + 40;
    while (performance.now() < end) {}
  };
  await assert.rejects(f.facade.record(c, 0, f.command, "late"), {
    code: "disposition_unavailable",
  });
  f.hooks.identity = null;
  assert.equal((await f.store.load(c, f.plan.record)).storage, null);
  // Instance overrides are ignored by the new facade; actual private-branded methods remain in use.
  Object.assign(f.membership, {
    resolveResource: async () => {
      throw Error("untrusted override");
    },
  });
  Object.assign(f.store, {
    record: async () => {
      throw Error("untrusted override");
    },
    load: async () => {
      throw Error("untrusted override");
    },
  });
  const facade = new IdentityQuestionDispositionRepository(
    f.store,
    f.membership,
    f.fixed,
  );
  const ack = await facade.record(c, 0, f.command, "valid");
  assert.equal(ack.storage.revision, 1);
  assert.equal((await facade.load(c, f.plan.record)).table.history.length, 1);
});

test("cancelled, foreign selection and oversized command deny before Identity SQL", async (t) => {
  const f = await setup(t);
  let calls = 0;
  f.hooks.identity = () => {
    calls++;
  };
  const a = new AbortController();
  a.abort();
  await assert.rejects(f.facade.record(c, 0, f.command, "abort", a.signal), {
    code: "disposition_unavailable",
  });
  await assert.rejects(
    f.facade.load(c, { ...f.plan.record, projectId: "other" }),
    { code: "disposition_unavailable" },
  );
  const huge = {
    ...f.command,
    review: {
      ...f.command.review,
      questions: [
        { ...f.command.review.questions[0]!, reason: "x".repeat(128 * 1024) },
      ],
    },
  };
  await assert.rejects(f.facade.record(c, 0, huge, "huge"), {
    code: "disposition_unavailable",
  });
  assert.equal(calls, 0);
  assert.equal((await f.store.load(c, f.plan.record)).storage, null);
});

test("owning synchronous admission rejects nonvoid or rejecting native promises without new review or unhandled rejection", async (t) => {
  const f = await setup(t);
  for (const admit of [
    () => true,
    () => Promise.reject(Error("private callback diagnostic")),
  ]) {
    await assert.rejects(
      f.store.record(
        c,
        0,
        f.command,
        "bad",
        undefined,
        10000,
        admit as unknown as () => void,
      ),
      { code: "disposition_unavailable" },
    );
  }
  assert.equal((await f.store.load(c, f.plan.record)).storage, null);
});

test("outer monotonic budget reaches actual owning checked lock and denies new write after blocked SQL callback", async (t) => {
  const f = await setup(t);
  let hit = false;
  const db = {
    transaction: <T>(fn: Parameters<typeof f.factual.transaction<T>>[0]) =>
      f.factual.transaction((q) =>
        fn({
          query: async <R>(sql: string, values?: unknown[]) => {
            const result = await q.query<R>(sql, values);
            if (values?.includes("factual.question_review.record_checked")) {
              hit = true;
              const end = performance.now() + 150;
              while (performance.now() < end) {}
            }
            return result;
          },
        }),
      ),
    close: () => f.factual.close(),
  };
  const store = new QuestionDispositionRepository(db, {
    ...f.fixed,
    humanIds: ["owner"],
  });
  const facade = new IdentityQuestionDispositionRepository(
    store,
    f.membership,
    f.fixed,
    100,
  );
  await assert.rejects(facade.record(c, 0, f.command, "late-owning"), {
    code: "disposition_write_unknown",
  });
  assert(hit);
  assert.equal((await f.store.load(c, f.plan.record)).storage, null);
});
