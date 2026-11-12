import test from "node:test";
import assert from "node:assert/strict";
import { fixture, input, c } from "./disposition-identity-fixture.ts";
import { CurrentCorrectionImpactReader } from "../src/correction-impact-current.ts";
import { KNOWLEDGE_RESOURCE_ID } from "@accountability/knowledge-verification/identity-repository";
import { scoped } from "@accountability/evidence-sql/database";

export async function setup(t: test.TestContext, timeout = 10000) {
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
