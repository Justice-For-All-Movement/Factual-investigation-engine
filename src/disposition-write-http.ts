import { timingSafeEqual } from "node:crypto";
import { MembershipRegistry } from "@accountability/identity-policy/membership";
import { createMembershipSessionAuthentication } from "@accountability/identity-policy/membership-session";
import type { HumanSessionProvider } from "@accountability/identity-policy/membership-session";
import { IdentityQuestionDispositionRepository } from "./disposition-identity.ts";
import {
  invariant,
  nonempty,
  canonical,
  requireScope,
  validateRef,
} from "@accountability/knowledge-verification/contracts";
import type { Scope } from "@accountability/knowledge-verification/contracts";

import type { DispositionCommand } from "./disposition-repository.ts";
import {
  PLANNING_KIND,
  PLANNING_KEY,
  EFFORT_KIND,
  EFFORT_KEY,
} from "./repository.ts";
type DispositionWriteRequest = {
  expectedStorageRevision: number;
  command: DispositionCommand;
  commandId: string;
};
function exact(
  v: unknown,
  fields: readonly string[],
): asserts v is Record<string, any> {
  invariant(
    v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.keys(v).length === fields.length &&
      fields.every((k) => Object.hasOwn(v, k)),
    "invalid_request",
    "Exact fields required",
  );
}
function ref(
  scope: Scope,
  value: unknown,
  kind: string,
  id?: string,
  immutable = false,
) {
  exact(value, ["tenantId", "projectId", "kind", "id", "revision"]);
  const r = validateRef(value);
  requireScope(scope, r);
  invariant(
    r.kind === kind &&
      Number.isSafeInteger(r.revision) &&
      r.revision > 0 &&
      (!id || r.id === id) &&
      (!immutable || r.revision === 1),
    "invalid_request",
    "Exact typed positive edition required",
  );
  nonempty(r.id, "Reference", 128);
  return r;
}
function validateRequest(
  scope: Scope,
  value: unknown,
): DispositionWriteRequest {
  exact(value, ["expectedStorageRevision", "command", "commandId"]);
  invariant(
    Number.isSafeInteger(value.expectedStorageRevision) &&
      value.expectedStorageRevision >= 0,
    "invalid_request",
    "Exact storage revision required",
  );
  nonempty(value.commandId, "Command", 128);
  const command = value.command;
  exact(command, ["planningStorage", "effortStorage", "review"]);
  invariant(
    Buffer.byteLength(canonical(command)) <= 128 * 1024,
    "invalid_request",
    "Command exceeds budget",
  );
  ref(scope, command.planningStorage, PLANNING_KIND, PLANNING_KEY);
  if (command.effortStorage !== null)
    ref(scope, command.effortStorage, EFFORT_KIND, EFFORT_KEY);
  const q = command.review;
  exact(q, [
    "id",
    "expectedSequence",
    "supersedes",
    "selected",
    "questions",
    "reopeningTriggers",
  ]);
  nonempty(q.id, "Review", 128);
  invariant(
    Number.isSafeInteger(q.expectedSequence) && q.expectedSequence >= 0,
    "invalid_request",
    "Exact review sequence required",
  );
  ref(scope, q.selected, "investigation-plan");
  if (q.supersedes !== null)
    ref(scope, q.supersedes, "investigation-question-review", undefined, true);
  invariant(
    Array.isArray(q.questions) &&
      q.questions.length >= 1 &&
      q.questions.length <= 64,
    "invalid_request",
    "Bounded complete question list required",
  );
  const ids = new Set<string>();
  for (const row of q.questions) {
    exact(row, ["questionId", "status", "reason", "assigneeId", "reviewAt"]);
    nonempty(row.questionId, "Question", 128);
    nonempty(row.reason, "Reason", 4000);
    invariant(
      !ids.has(row.questionId) &&
        ["unresolved", "deferred", "assigned"].includes(row.status),
      "invalid_request",
      "Unique unanswered dispositions required",
    );
    ids.add(row.questionId);
    if (row.status === "assigned")
      nonempty(row.assigneeId, "Host assignee label", 128);
    else
      invariant(
        row.assigneeId === null,
        "invalid_request",
        "Unexpected assignee",
      );
    if (row.status === "unresolved")
      invariant(
        row.reviewAt === null,
        "invalid_request",
        "Unexpected review time",
      );
    else
      invariant(
        typeof row.reviewAt === "string" &&
          row.reviewAt.length === 24 &&
          Number.isFinite(Date.parse(row.reviewAt)) &&
          new Date(row.reviewAt).toISOString() === row.reviewAt,
        "invalid_request",
        "Canonical review time required",
      );
  }
  invariant(
    Array.isArray(q.reopeningTriggers) &&
      q.reopeningTriggers.length >= 1 &&
      q.reopeningTriggers.length <= 16 &&
      new Set(q.reopeningTriggers).size === q.reopeningTriggers.length,
    "invalid_request",
    "Bounded distinct triggers required",
  );
  for (const trigger of q.reopeningTriggers) nonempty(trigger, "Trigger", 2000);
  return value as DispositionWriteRequest;
}

/** Private write-only native Fetch adapter. Host provides independently authenticated human sessions and TLS. */
export function createDispositionWriteHandler(
  writer: IdentityQuestionDispositionRepository,
  membership: MembershipRegistry,
  provider: HumanSessionProvider,
  configuration: Scope & {
    origin: string;
    purpose: string;
    timeoutMs?: number;
  },
  clock: () => string,
) {
  invariant(
    writer instanceof IdentityQuestionDispositionRepository &&
      membership instanceof MembershipRegistry,
    "invalid_policy",
    "Current owning dispositions writer and membership registry required",
  );
  const policy = structuredClone(configuration),
    origin = new URL(policy.origin);
  invariant(
    origin.protocol === "https:" && origin.origin === policy.origin,
    "invalid_policy",
    "Exact HTTPS origin required",
  );
  const timeout = policy.timeoutMs ?? 10000;
  invariant(
    Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= 30000,
    "invalid_policy",
    "Bounded dispositions HTTP deadline required",
  );
  const auth = createMembershipSessionAuthentication(
    membership,
    provider,
    { ...policy, action: "investigate", timeoutMs: timeout },
    clock,
  );
  const record =
    IdentityQuestionDispositionRepository.prototype.record.bind(writer);
  const base = "/private/disposition-write";
  const response = (status: number, value: unknown) => {
    const body = JSON.stringify(value);
    invariant(
      Buffer.byteLength(body) <= 4096,
      "dispositions_unavailable",
      "Response exceeds budget",
    );
    return new Response(body, {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    });
  };
  return async (request: Request): Promise<Response> => {
    const started = performance.now(),
      owned = new AbortController(),
      abort = () => owned.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const timer = setTimeout(abort, timeout);
    const gate = () =>
      invariant(
        !owned.signal.aborted && performance.now() - started < timeout,
        "dispositions_unavailable",
        "Disposition HTTP unavailable",
      );
    let owning = false;
    let stream: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      gate();
      const url = new URL(request.url),
        method = request.method;
      if (
        url.origin !== policy.origin ||
        url.search ||
        url.hash ||
        !(
          (method === "GET" && url.pathname === base + "/session") ||
          (method === "POST" && url.pathname === base + "/record")
        )
      )
        return response(404, { error: "not_found" });
      const metadata = {
        url: url.href,
        method,
        headers: new Headers(request.headers),
      };
      const site = metadata.headers.get("sec-fetch-site");
      if (
        site &&
        site !== "same-origin" &&
        !(method === "GET" && site === "none")
      )
        return response(403, { error: "request_denied" });
      if (
        (metadata.headers.has("origin") &&
          metadata.headers.get("origin") !== policy.origin) ||
        (method === "POST" && metadata.headers.get("origin") !== policy.origin)
      )
        return response(403, { error: "request_denied" });
      let input: DispositionWriteRequest | undefined;
      if (method === "POST") {
        if (metadata.headers.get("content-type") !== "application/json")
          return response(400, { error: "invalid_request" });
        const length = metadata.headers.get("content-length");
        if (
          length !== null &&
          (!/^\d+$/.test(length) || Number(length) > 132 * 1024)
        )
          return response(400, { error: "invalid_request" });
        const pieces: Uint8Array[] = [];
        let bytes = 0,
          chunks = 0;
        stream = request.body?.getReader();
        if (!stream) return response(400, { error: "invalid_request" });
        while (true) {
          gate();
          const item = await new Promise<ReadableStreamReadResult<Uint8Array>>(
            (resolve, reject) => {
              const interrupted = () => reject(Error("cancelled"));
              owned.signal.addEventListener("abort", interrupted, {
                once: true,
              });
              if (owned.signal.aborted) interrupted();
              stream!
                .read()
                .then(resolve, reject)
                .finally(() =>
                  owned.signal.removeEventListener("abort", interrupted),
                );
            },
          );
          gate();
          if (item.done) break;
          bytes += item.value.byteLength;
          invariant(
            ++chunks <= 4096 && bytes <= 132 * 1024,
            "invalid_request",
            "Body exceeds budget",
          );
          pieces.push(Uint8Array.from(item.value));
        }
        const data = new Uint8Array(bytes);
        let offset = 0;
        for (const piece of pieces) {
          data.set(piece, offset);
          offset += piece.length;
        }
        input = validateRequest(
          policy,
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)),
        );
        gate();
      }
      gate();
      // Body admission precedes fresh stored membership observation. Begun Identity SQL is awaited.
      const session = await auth.authenticate(metadata, owned.signal);
      gate();
      if (!session) return response(401, { error: "authentication_required" });
      requireScope(policy, session.context);
      if (method === "GET") {
        const result = response(200, {
          actorId: session.context.actor.id,
          csrfToken: session.csrfToken,
        });
        gate();
        return result;
      }
      const token = metadata.headers.get("x-csrf-token");
      if (!token || token.length > 256)
        return response(403, { error: "request_denied" });
      const supplied = Buffer.from(token),
        expected = Buffer.from(session.csrfToken);
      if (
        !supplied.length ||
        supplied.length > 256 ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return response(403, { error: "request_denied" });
      gate();
      owning = true;
      const value = await record(
        session.context,
        input!.expectedStorageRevision,
        input!.command,
        input!.commandId,
        owned.signal,
        gate,
      );
      // Acknowledged commit remains acknowledged even after cancellation/deadline.
      return response(200, value);
    } catch {
      return response(503, {
        error: owning
          ? "disposition_write_unknown"
          : "dispositions_unavailable",
      });
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      owned.abort();
      if (stream) void stream.cancel().catch(() => {});
    }
  };
}
