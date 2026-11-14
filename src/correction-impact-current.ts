import { MembershipRegistry } from "@accountability/identity-policy/membership";
import {
  IdentityKnowledgeRepository,
  KNOWLEDGE_RESOURCE_ID,
} from "@accountability/knowledge-verification/identity-repository";
import {
  KNOWLEDGE_KIND,
  KNOWLEDGE_KEY,
} from "@accountability/knowledge-verification/repository";
import {
  canonical,
  invariant,
  nonempty,
  requireScope,
  validateRef,
} from "@accountability/knowledge-verification/contracts";
import type {
  Context,
  Ref,
  Scope,
} from "@accountability/knowledge-verification/contracts";
import { FactualRepository } from "./repository.ts";
import { FACTUAL_RESOURCE_ID } from "./identity-repository.ts";

/** Current owning services, sequential observations: never a distributed permission fence. */
export class CurrentCorrectionImpactReader {
  readonly #load: FactualRepository["loadCorrectionImpact"];
  readonly #knowledge: IdentityKnowledgeRepository["load"];
  readonly #resolve: MembershipRegistry["resolveResource"];
  readonly #policy: Scope & Readonly<{ purpose: string }>;
  readonly #timeout: number;
  constructor(
    repository: FactualRepository,
    membership: MembershipRegistry,
    knowledge: IdentityKnowledgeRepository,
    policy: Scope & Readonly<{ purpose: string }>,
    timeoutMs = 10000,
  ) {
    this.#load =
      FactualRepository.prototype.loadCorrectionImpact.bind(repository);
    this.#knowledge =
      IdentityKnowledgeRepository.prototype.load.bind(knowledge);
    this.#resolve =
      MembershipRegistry.prototype.resolveResource.bind(membership);
    this.#policy = structuredClone(policy);
    this.#timeout = timeoutMs;
    for (const value of [
      this.#policy.tenantId,
      this.#policy.projectId,
      this.#policy.purpose,
    ])
      nonempty(value, "Fixed policy", 128);
    invariant(
      Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000,
      "invalid_policy",
      "Bounded deadline required",
    );
  }
  async read(
    context: Context,
    before: Ref,
    after: Ref,
    signal?: AbortSignal,
    admit?: () => void,
  ) {
    try {
      const started = performance.now(),
        c = structuredClone(context),
        prior = structuredClone(before),
        next = structuredClone(after);
      const check = () =>
        invariant(
          !signal?.aborted && performance.now() - started < this.#timeout,
          "impact_unavailable",
          "Current correction impact unavailable",
        );
      const gate = () => {
        check();
        const result: unknown = admit?.();
        if (result instanceof Promise) void result.catch(() => {});
        invariant(
          result === undefined,
          "impact_unavailable",
          "Synchronous void admission required",
        );
        check();
      };
      gate();
      requireScope(this.#policy, c);
      invariant(
        c.actor.kind === "human" && c.purpose === this.#policy.purpose,
        "impact_unavailable",
        "Human fixed-purpose read required",
      );
      for (const ref of [prior, next]) {
        validateRef(ref);
        requireScope(c, ref);
        invariant(
          Object.keys(ref).sort().join(",") ===
            "id,kind,projectId,revision,tenantId" &&
            Number.isSafeInteger(ref.revision) &&
            ref.revision > 0,
          "impact_unavailable",
          "Exact positive references required",
        );
      }
      invariant(
        prior.kind === next.kind &&
          prior.id === next.id &&
          next.revision === prior.revision + 1,
        "impact_unavailable",
        "Consecutive Knowledge editions required",
      );
      const current = async (resourceId = FACTUAL_RESOURCE_ID) => {
        gate();
        const principal = { ...c, actor: { ...c.actor, roles: [] } };
        const result = structuredClone(
          await this.#resolve(principal, resourceId, "investigate"),
        );
        gate();
        requireScope(this.#policy, result.context);
        invariant(
          result.resourceId === resourceId &&
            result.context.actor.kind === "human" &&
            result.context.actor.id === c.actor.id &&
            result.context.purpose === c.purpose &&
            result.context.requestId === c.requestId,
          "impact_unavailable",
          "Current Identity binding unavailable",
        );
        return result.context;
      };
      const source = async (actual: Context) => {
        gate();
        const result = structuredClone(
          await this.#knowledge(
            { ...actual, actor: { ...actual.actor, roles: [] } },
            signal,
          ),
        );
        gate();
        await current(KNOWLEDGE_RESOURCE_ID);
        gate();
        requireScope(c, result.state);
        invariant(
          Number.isSafeInteger(result.revision) &&
            result.revision > 0 &&
            result.revision === result.state.records.length,
          "impact_unavailable",
          "Current Knowledge edition unavailable",
        );
        const json = JSON.stringify(result.state);
        invariant(
          Buffer.byteLength(json) <= 5 * 1024 * 1024,
          "impact_unavailable",
          "Whole Knowledge exceeds budget",
        );
        gate();
        return { result, json };
      };
      const remaining = () =>
        Math.max(1, Math.ceil(this.#timeout - (performance.now() - started)));
      const initial = await current();
      const observed = await source(initial);
      gate();
      const first = await this.#load(
        initial,
        observed.json,
        prior,
        next,
        signal,
        remaining(),
        gate,
      );
      gate();
      const refreshed = await current();
      const fresh = await source(refreshed);
      gate();
      invariant(
        canonical(observed.result) === canonical(fresh.result),
        "impact_unavailable",
        "Whole Knowledge changed during observation",
      );
      const finalContext = await current();
      const final = await this.#load(
        finalContext,
        fresh.json,
        prior,
        next,
        signal,
        remaining(),
        gate,
      );
      gate();
      invariant(
        canonical(first) === canonical(final),
        "impact_unavailable",
        "Whole planning basis changed during observation",
      );
      await current();
      gate();
      const output = {
        profile: "current-plan-correction-impact-v1" as const,
        knowledgeStorage: {
          tenantId: c.tenantId,
          projectId: c.projectId,
          kind: KNOWLEDGE_KIND,
          id: KNOWLEDGE_KEY,
          revision: fresh.result.revision,
        },
        planningStorage: final.planningStorage,
        impact: final.impact,
      };
      invariant(
        Buffer.byteLength(canonical(output)) <= 512 * 1024,
        "impact_unavailable",
        "Complete current impact exceeds budget",
      );
      gate();
      const copy = structuredClone(output);
      gate();
      return copy;
    } catch {
      invariant(
        false,
        "impact_unavailable",
        "Current correction impact unavailable",
      );
    }
  }
}
