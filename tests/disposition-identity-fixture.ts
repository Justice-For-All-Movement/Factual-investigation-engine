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
export const c: Context = {
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
export function input() {
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
export async function fixture(t: test.TestContext, upstream = false) {
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
    facade: new IdentityFactualRepository(repo, membership, fixed),
    fixed,
  };
}
