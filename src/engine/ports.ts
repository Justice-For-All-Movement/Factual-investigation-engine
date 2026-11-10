// Collaborator ports of the factual investigation engine (E08).
// The engine never imports another engine's package: the host (PAM or a standalone deployment) supplies objects
// implementing these interfaces. Every object crossing a port is named by universal reference string (uref).
// Operations with an external side effect take `idempotencyKey`; an implementation must return the same result
// for a repeated key so that an interrupted step can be retried without repeating the effect.
import type { Json } from '../contracts.ts';
import type { AuthorizationPort, BudgetPort, EvidenceVersionInfo, ServiceContext } from '../service-kit.ts';

export type DiscoveryItem = Readonly<{ ref: string; title: string; sourceId?: string; evidenceRef?: string; locator?: string }>;
/** A contact lead is a reference only: identity details stay in the owning engine. */
export type ContactLead = Readonly<{ ref: string; label: string; role?: string }>;
export type SourceCoverage = Readonly<{ sourceId: string; status: 'searched' | 'zero_result' | 'failed' | 'access_restricted' | 'not_attempted'; itemCount: number; note?: string }>;
export type PortEffort = Readonly<{ timeMinutes?: number; costUnits?: number }>;

/** E04 discovery and acquisition. */
export interface DiscoveryPort {
  startCollectionRun(ctx: ServiceContext, input: { subject: string; objective: string; query: string; sourceIds?: readonly string[]; idempotencyKey: string }): Promise<{ runRef: string; state: string; effort?: PortEffort }>;
  searchSource(ctx: ServiceContext, input: { query: string; sourceId?: string; limit?: number }): Promise<{ items: readonly DiscoveryItem[]; searched: readonly string[]; restricted?: readonly string[]; effort?: PortEffort }>;
  getCoverage(ctx: ServiceContext, runRef: string): Promise<{ runRef: string; state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; sources: readonly SourceCoverage[]; items: readonly DiscoveryItem[]; contactLeads: readonly ContactLead[]; effort?: PortEffort }>;
}

/** E05 evidence. `describe` is the kit EvidencePort method; `describeProvenance` is an engine-defined extension (the kit type has no origin or custody fields). */
export interface EvidenceDescribePort {
  describe(ctx: ServiceContext, ref: string): Promise<(EvidenceVersionInfo & { origin?: Json; custodySummary?: string }) | null>;
  describeProvenance?(ctx: ServiceContext, ref: string): Promise<{ origin: Json; custodySummary: string; custodyEvents?: number } | null>;
}

/** E06 document and media processing. */
export interface ProcessingPort {
  requestProcessing(ctx: ServiceContext, input: { evidenceRef: string; operations: readonly string[]; idempotencyKey: string }): Promise<{ jobRef: string; state: string; effort?: PortEffort }>;
  getText(ctx: ServiceContext, evidenceRef: string): Promise<{ available: boolean; reason?: string; derivativeRef?: string; text?: string; segments?: readonly Readonly<{ selector: Json; text: string }>[] }>;
  search(ctx: ServiceContext, input: { query: string; evidenceRefs?: readonly string[]; limit?: number }): Promise<{ hits: readonly Readonly<{ evidenceRef: string; selector: Json; snippet: string }>[] }>;
}

export type StatementLabel = 'allegation' | 'attributed_testimony' | 'verified_fact' | 'inference' | 'unknown';
export type KnowledgeGap = Readonly<{ id: string; kind: string; description: string; claimRef?: string; evidenceRef?: string; contactLeadRef?: string }>;
export type ChronologyEntry = Readonly<{ at: string; description: string; claimRef: string; status?: string; sources?: readonly string[] }>;

/** E07 knowledge and verification. */
export interface KnowledgePort {
  proposeClaim(ctx: ServiceContext, input: { subject: string; statement: string; label: StatementLabel; sources: readonly Readonly<{ ref: string; selector?: Json }>[]; idempotencyKey: string }): Promise<{ claimRef: string; state: string }>;
  createLink(ctx: ServiceContext, input: { from: string; to: string; relation: string; idempotencyKey: string }): Promise<{ linkRef: string }>;
  getSourceFamilies(ctx: ServiceContext, refs: readonly string[]): Promise<readonly Readonly<{ familyRef: string; label: string; members: readonly string[] }>[]>;
  getGaps(ctx: ServiceContext, input: { subject: string; claimRefs: readonly string[] }): Promise<readonly KnowledgeGap[]>;
  getChronology(ctx: ServiceContext, input: { subject: string; claimRefs: readonly string[] }): Promise<readonly ChronologyEntry[]>;
  getGraph(ctx: ServiceContext, input: { claimRefs: readonly string[] }): Promise<{ nodes: readonly Json[]; edges: readonly Json[] }>;
  getImpact(ctx: ServiceContext, ref: string): Promise<{ dependents: readonly string[] }>;
}

/** E03 correspondence and outreach. Nothing here sends: plans and drafts are prepared for the owning engine's own approval and sending rules. */
export interface CorrespondencePort {
  createContactPlan(ctx: ServiceContext, input: { subject: string; question: string; contactLeadRef?: string; purpose: string; idempotencyKey: string }): Promise<{ planRef: string; state: string }>;
  draftInquiry(ctx: ServiceContext, input: { subject: string; questions: readonly string[]; contactPlanRef?: string; contactLeadRef?: string; idempotencyKey: string }): Promise<{ draftRef: string; threadRef?: string; state: string }>;
  getThreadState(ctx: ServiceContext, threadRef: string): Promise<{ threadRef: string; state: string; replies: readonly Readonly<{ ref: string; receivedAt: string; evidenceRef?: string }>[] }>;
}

export type InvestigationPorts = Readonly<{
  discovery?: DiscoveryPort;
  evidence?: EvidenceDescribePort;
  processing?: ProcessingPort;
  knowledge?: KnowledgePort;
  correspondence?: CorrespondencePort;
  budget?: BudgetPort;
  authorization?: AuthorizationPort;
}>;
