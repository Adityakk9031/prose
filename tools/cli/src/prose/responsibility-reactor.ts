import { posix, resolve } from "node:path";
import {
	canonicalizeForReceiptV0,
	createFileSystemStorageAdapterV0,
	createMemoryEventSinkAdapterV0,
	createNullSandboxAdapterV0,
	createReactor,
	createStaticConnectorAdapterV0,
	createSystemClockAdapterV0,
	hashCanonicalReceiptV0,
	projectReceiptV0,
	type ColdStartPolicyInputV0,
	type CompiledEvidencePlan,
	type ContentHashV0,
	type ContractSummaryProjectionV0,
	type ForecastScheduleStateV0,
	type PolicyLiveObservableV0,
	type ReceiptOwnerProjectionV0,
	type ReceiptProjectionResultV0,
	type ReceiptV0,
	type ReactorAdaptersV0,
	type ReactorAgentSdkAdapterV0,
	type ReactorClockAdapterV0,
	type ReactorConnectorAdapterV0,
	type ReactorEventSinkAdapterV0,
	type ReactorIngestResultV0,
	type ReactorModelGatewayAdapterV0,
	type ReactorSandboxAdapterV0,
	type ReactorSdkV0,
} from "@openprose/reactor";
import type { OpenProseRoot } from "./openprose-root.js";
import type { RepositoryIrResponsibility, RepositoryIrTrigger, RepositoryIrV0 } from "./repository-ir.js";
import type { RepositoryServeEvent, RepositoryServeLoadedIr } from "./repository-serve.js";
import {
	RESPONSIBILITY_PRESSURE_KIND,
	RESPONSIBILITY_PRESSURE_VERSION,
	validateResponsibilityPressureRecord,
	type ResponsibilityPressureActivationKind,
	type ResponsibilityPressureRecord,
	type ResponsibilityPressureStatus,
} from "./responsibility-pressure.js";
import { fingerprintResponsibility } from "./responsibility-status.js";

export const RESPONSIBILITY_REACTOR_STATE_DIR = "state/reactor";
export const RESPONSIBILITY_REACTOR_POLICY_REVISION = "1";
export const RESPONSIBILITY_REACTOR_EVIDENCE_SOURCE_SUFFIX = "trigger-event";
export const RESPONSIBILITY_REACTOR_TRIGGER_DEDUPE_SCHEMA = "openprose.repository-trigger-dedupe";

export class ResponsibilityReactorError extends Error {
	readonly details: string[];

	constructor(message: string, details: readonly string[] = []) {
		super(message);
		this.name = "ResponsibilityReactorError";
		this.details = [...details];
	}
}

export interface ResponsibilityReactorPaths {
	responsibilityId: string;
	directoryPath: string;
	absoluteDirectoryPath: string;
}

export interface LoadResponsibilityReactorOptions {
	loaded: RepositoryServeLoadedIr;
	responsibilityId: string;
	modelGateway: ReactorModelGatewayAdapterV0;
	agentSdk: ReactorAgentSdkAdapterV0;
	clock?: ReactorClockAdapterV0;
	connectors?: ReactorConnectorAdapterV0;
	eventSink?: ReactorEventSinkAdapterV0;
	sandbox?: ReactorSandboxAdapterV0;
	storageDirectory?: string;
	asOf?: string;
}

export interface ResponsibilityReactorBridge {
	responsibility: RepositoryIrResponsibility;
	paths: ResponsibilityReactorPaths;
	reactor: ReactorSdkV0;
	contractRevision: ContentHashV0;
	coldStart: ColdStartPolicyInputV0;
	adapters: ReactorAdaptersV0;
}

export interface RepositoryTriggerReactorEvent {
	kind: "real-input";
	contract_revision: ContentHashV0;
	cold_start?: ColdStartPolicyInputV0;
	evidence: readonly [
		{
			readonly source_id: string;
			readonly content_hash: ContentHashV0;
			readonly payload: {
				readonly schema: "openprose.repository-trigger-evidence";
				readonly v: 0;
				readonly manifest_path: string;
				readonly ir_version: number;
				readonly responsibility_id: string;
				readonly trigger: RepositoryIrTrigger;
				readonly event: RepositoryServeEvent;
			};
		},
	];
}

export interface IngestRepositoryTriggerThroughReactorResult {
	event: RepositoryTriggerReactorEvent;
	triggerDedupeKey: ContentHashV0;
	result: ReactorIngestResultV0;
	receipt?: ReceiptV0;
	projection?: ReceiptOwnerProjectionV0;
	projectionResult?: ReceiptProjectionResultV0;
	pressure?: ResponsibilityPressureRecord;
}

export interface RepositoryTriggerReceiptLookupResult {
	event: RepositoryTriggerReactorEvent;
	triggerDedupeKey: ContentHashV0;
	receipt?: ReceiptV0;
}

export function loadResponsibilityReactor(
	options: LoadResponsibilityReactorOptions,
): ResponsibilityReactorBridge {
	const responsibility = findResponsibility(options.loaded.manifest, options.responsibilityId);
	const paths = buildResponsibilityReactorPaths(
		options.loaded.openProseRoot,
		responsibility.id,
		options.storageDirectory,
	);
	const storage = createFileSystemStorageAdapterV0({ directory: paths.absoluteDirectoryPath });
	const adapters: ReactorAdaptersV0 = {
		clock: options.clock ?? createSystemClockAdapterV0(),
		storage,
		modelGateway: options.modelGateway,
		agentSdk: options.agentSdk,
		sandbox: options.sandbox ?? createNullSandboxAdapterV0(),
		connectors: options.connectors ?? createStaticConnectorAdapterV0(),
		eventSink: options.eventSink ?? createMemoryEventSinkAdapterV0(),
	};
	const contractRevision = buildReactorContractRevision(responsibility);

	return {
		responsibility,
		paths,
		reactor: createReactor({
			responsibility_id: responsibility.id,
			adapters,
		}),
		contractRevision,
		coldStart: buildReactorColdStartFromResponsibility({
			responsibility,
			asOf: options.asOf ?? adapters.clock.now(),
		}),
		adapters,
	};
}

export function buildResponsibilityReactorPaths(
	openProseRoot: OpenProseRoot,
	responsibilityId: string,
	storageDirectory?: string,
): ResponsibilityReactorPaths {
	if (responsibilityId.trim().length === 0) {
		throw new ResponsibilityReactorError("responsibilityId must be a non-empty string");
	}

	const directoryPath = storageDirectory ?? posix.join(RESPONSIBILITY_REACTOR_STATE_DIR, encodeURIComponent(responsibilityId));
	return {
		responsibilityId,
		directoryPath,
		absoluteDirectoryPath: resolve(openProseRoot.absolutePath, directoryPath),
	};
}

export function buildReactorContractRevision(responsibility: RepositoryIrResponsibility): ContentHashV0 {
	return `sha256:${fingerprintResponsibility(responsibility)}` as ContentHashV0;
}

export function buildReactorEvidenceSourceId(responsibilityId: string): string {
	return `repository-ir:${responsibilityId}:${RESPONSIBILITY_REACTOR_EVIDENCE_SOURCE_SUFFIX}`;
}

export function buildReactorPolicyNamespace(responsibilityId: string): string {
	return `policy.openprose-cli.${safePolicySegment(responsibilityId)}`;
}

export function buildReactorContractSummaryProjection(
	responsibility: RepositoryIrResponsibility,
): ContractSummaryProjectionV0 {
	const contractRevision = buildReactorContractRevision(responsibility);
	const summaryInput = {
		id: responsibility.id,
		sourcePath: responsibility.sourcePath,
		goal: responsibility.goal,
		continuity: responsibility.continuity,
		criteria: responsibility.criteria,
		constraints: responsibility.constraints,
		tools: responsibility.tools,
		...(responsibility.fulfillment === undefined ? {} : { fulfillment: responsibility.fulfillment }),
	};
	const summary = [
		`Goal: ${responsibility.goal}`,
		...(responsibility.criteria.length === 0
			? []
			: [`Criteria: ${responsibility.criteria.join("; ")}`]),
		...(responsibility.constraints.length === 0
			? []
			: [`Constraints: ${responsibility.constraints.join("; ")}`]),
	].join("\n");

	return {
		summary,
		source_contract_revision: contractRevision,
		projection_hash: hashCanonicalReceiptV0(canonicalizeForReceiptV0(summaryInput)),
	};
}

export function buildReactorColdStartFromResponsibility(options: {
	responsibility: RepositoryIrResponsibility;
	asOf: string;
}): ColdStartPolicyInputV0 {
	const contractRevision = buildReactorContractRevision(options.responsibility);
	const policyNamespace = buildReactorPolicyNamespace(options.responsibility.id);
	const evidenceSourceId = buildReactorEvidenceSourceId(options.responsibility.id);

	return {
		contract_revision: contractRevision,
		contract_summary: buildReactorContractSummaryProjection(options.responsibility),
		no_anchor: true,
		live_observables: buildReactorLiveObservables(options.responsibility),
		compiled_evidence_plan: {
			responsibility_id: options.responsibility.id,
			contract_revision: contractRevision,
			policy_artifact_namespace: policyNamespace,
			policy_artifact_revision: RESPONSIBILITY_REACTOR_POLICY_REVISION,
			plan_revision: "repository-ir-v0",
			as_of: options.asOf,
			evidence_order: "unordered",
			sources: [
				{
					id: evidenceSourceId,
					kind: "adapter",
					required: true,
				},
			],
		} satisfies CompiledEvidencePlan,
		forecast_schedule: {
			responsibility_id: options.responsibility.id,
			contract_revision: contractRevision,
			memo_key: `repository-ir:${options.responsibility.id}:forecast-seed`,
			evidence_input_ids: [],
			next_evidence_recheck: addMilliseconds(options.asOf, 24 * 60 * 60 * 1000),
			next_plan_recheck: addMilliseconds(options.asOf, 7 * 24 * 60 * 60 * 1000),
		} satisfies ForecastScheduleStateV0,
		policy_artifact_namespace: policyNamespace,
	};
}

export function buildRepositoryTriggerReactorEvent(options: {
	loaded: RepositoryServeLoadedIr;
	responsibility: RepositoryIrResponsibility;
	trigger: RepositoryIrTrigger;
	event: RepositoryServeEvent;
	includeColdStart: boolean;
	asOf: string;
}): RepositoryTriggerReactorEvent {
	const payload = {
		schema: "openprose.repository-trigger-evidence" as const,
		v: 0 as const,
		manifest_path: options.loaded.manifestPath,
		ir_version: options.loaded.manifest.version,
		responsibility_id: options.responsibility.id,
		trigger: options.trigger,
		event: options.event,
	};

	return {
		kind: "real-input",
		contract_revision: buildReactorContractRevision(options.responsibility),
		...(options.includeColdStart
			? {
					cold_start: buildReactorColdStartFromResponsibility({
						responsibility: options.responsibility,
						asOf: options.asOf,
					}),
				}
			: {}),
		evidence: [
			{
				source_id: buildReactorEvidenceSourceId(options.responsibility.id),
				content_hash: hashCanonicalReceiptV0(canonicalizeForReceiptV0(payload)),
				payload,
			},
		],
	};
}

export function buildRepositoryTriggerDedupeKey(options: {
	loaded: RepositoryServeLoadedIr;
	responsibility: RepositoryIrResponsibility;
	trigger: RepositoryIrTrigger;
	event: RepositoryServeEvent;
}): ContentHashV0 {
	return hashCanonicalReceiptV0(
		canonicalizeForReceiptV0({
			schema: RESPONSIBILITY_REACTOR_TRIGGER_DEDUPE_SCHEMA,
			v: 0,
			manifest_path: options.loaded.manifestPath,
			ir_version: options.loaded.manifest.version,
			responsibility_id: options.responsibility.id,
			trigger: options.trigger,
			event: normalizeRepositoryServeEventForDedupe(options.event),
		}),
	);
}

export function findRepositoryTriggerReceipt(options: {
	bridge: ResponsibilityReactorBridge;
	loaded: RepositoryServeLoadedIr;
	event: RepositoryServeEvent;
	asOf?: string;
}): RepositoryTriggerReceiptLookupResult {
	const trigger = findTrigger(options.loaded.manifest, options.bridge.responsibility.id, options.event.triggerId);
	const event = buildRepositoryTriggerReactorEvent({
		loaded: options.loaded,
		responsibility: options.bridge.responsibility,
		trigger,
		event: options.event,
		includeColdStart: false,
		asOf: options.asOf ?? options.bridge.adapters.clock.now(),
	});
	const triggerDedupeKey = buildRepositoryTriggerDedupeKey({
		loaded: options.loaded,
		responsibility: options.bridge.responsibility,
		trigger,
		event: options.event,
	});
	const evidenceHash = event.evidence[0].content_hash;
	const receipt = options.bridge.reactor.receipts().find((candidate) => {
		return (
			candidate.core.responsibility_id === options.bridge.responsibility.id &&
			candidate.core.contract_revision === options.bridge.contractRevision &&
			candidate.core.evidence_input_ids.includes(evidenceHash)
		);
	});

	return {
		event,
		triggerDedupeKey,
		...(receipt === undefined ? {} : { receipt }),
	};
}

export function ingestRepositoryTriggerThroughReactor(options: {
	bridge: ResponsibilityReactorBridge;
	loaded: RepositoryServeLoadedIr;
	event: RepositoryServeEvent;
	asOf?: string;
}): IngestRepositoryTriggerThroughReactorResult {
	const trigger = findTrigger(options.loaded.manifest, options.bridge.responsibility.id, options.event.triggerId);
	const asOf = options.asOf ?? options.bridge.adapters.clock.now();
	const event = buildRepositoryTriggerReactorEvent({
		loaded: options.loaded,
		responsibility: options.bridge.responsibility,
		trigger,
		event: options.event,
		includeColdStart: shouldIncludeColdStart(options.bridge.reactor),
		asOf,
	});
	const triggerDedupeKey = buildRepositoryTriggerDedupeKey({
		loaded: options.loaded,
		responsibility: options.bridge.responsibility,
		trigger,
		event: options.event,
	});
	const result = options.bridge.reactor.ingest(event);
	const receipt = latestReceipt(options.bridge.reactor.receipts());
	const projectionResult = receipt === undefined ? undefined : projectReceiptV0({ tier: "owner", receipt });
	const projection = projectionResult?.ok && projectionResult.projection.tier === "owner"
		? projectionResult.projection
		: undefined;
	const pressure =
		receipt === undefined || projection === undefined
			? undefined
			: buildPressureFromReceiptProjection({
					manifest: options.loaded.manifest,
					responsibility: options.bridge.responsibility,
					receipt,
					projection,
					triggerDedupeKey,
				});

	return {
		event,
		triggerDedupeKey,
		result,
		...(receipt === undefined ? {} : { receipt }),
		...(projection === undefined ? {} : { projection }),
		...(projectionResult === undefined ? {} : { projectionResult }),
		...(pressure === undefined ? {} : { pressure }),
	};
}

export function buildPressureFromReceiptProjection(options: {
	manifest: RepositoryIrV0;
	responsibility: RepositoryIrResponsibility;
	receipt: ReceiptV0;
	projection: ReceiptOwnerProjectionV0;
	recordedAt?: string;
	triggerDedupeKey?: ContentHashV0;
}): ResponsibilityPressureRecord | undefined {
	const status = options.projection.status;
	if (status === null || status === "up") {
		return undefined;
	}

	const recommendedActivationKind = selectPressureActivationKind(status);
	const activation = selectPressureActivation(options.manifest, {
		responsibilityId: options.responsibility.id,
		status,
		recommendedActivationKind,
	});
	if (activation === undefined) {
		throw new ResponsibilityReactorError(
			`Responsibility '${options.responsibility.id}' has unhealthy Reactor status but no ${recommendedActivationKind}, fulfillment, retry, or escalation activation.`,
		);
	}

	const dedupeKey = hashCanonicalReceiptV0(
		canonicalizeForReceiptV0({
			schema: "openprose.reactor-cli.pressure-dedupe",
			v: 0,
			receipt_hash: options.receipt.content_hash,
			responsibility_id: options.responsibility.id,
			recommended_activation_kind: activation.kind,
			activation_id: activation.id,
		}),
	);
	const blocked = options.projection.verdict.blocked;
	const record: ResponsibilityPressureRecord = {
		kind: RESPONSIBILITY_PRESSURE_KIND,
		version: RESPONSIBILITY_PRESSURE_VERSION,
		pressureId: dedupeKey,
		dedupeKey,
		responsibilityId: options.responsibility.id,
		responsibilityFingerprint: fingerprintResponsibility(options.responsibility),
		status,
		evidence: [
			`Reactor receipt ${options.receipt.content_hash} reported ${status}.`,
			`fresh=${options.projection.token_truth.fresh} reused=${options.projection.token_truth.reused} surprise_cause=${options.projection.token_truth.surprise_cause}`,
		],
		recommendedActivationKind: activation.kind as ResponsibilityPressureActivationKind,
		activationId: activation.id,
		reason:
			status === "blocked" && blocked?.reason !== null && blocked?.reason !== undefined
				? blocked.reason
				: `Reactor receipt ${options.receipt.content_hash} reported ${status}; activate '${activation.id}' to reconcile it.`,
		recordedAt: options.recordedAt ?? options.receipt.core.as_of,
		source: {
			statusRecordedAt: options.receipt.core.as_of,
			statusRunId: options.receipt.content_hash,
			...(options.triggerDedupeKey === undefined ? {} : { triggerDedupeKey: options.triggerDedupeKey }),
		},
	};
	const validation = validateResponsibilityPressureRecord(record);
	if (!validation.valid) {
		throw new ResponsibilityReactorError("Derived Reactor pressure record is invalid.", validation.errors);
	}

	return record;
}

function buildReactorLiveObservables(
	responsibility: RepositoryIrResponsibility,
): readonly PolicyLiveObservableV0[] {
	const segment = safePolicySegment(responsibility.id);
	return [
		{
			id: `source.${segment}.trigger_event`,
			source: "connector",
			description: "Repository trigger payloads that wake this responsibility.",
		},
		{
			id: `receipt.${segment}.judged_status`,
			source: "receipt-log",
			description: "Reactor receipts recording status decisions for this responsibility.",
		},
		{
			id: `cost.${segment}.fresh_tokens`,
			source: "cost-ledger",
			description: "Fresh and reused judge tokens for this responsibility.",
		},
		{
			id: "cost.fresh_tokens_per_maintained_day",
			source: "cost-ledger",
			description: "Fresh tokens spent per maintained responsibility day.",
		},
		{
			id: "receipt.escalation_precision_7d",
			source: "receipt-log",
			description: "Seven-day precision of escalations later confirmed as needed.",
		},
		{
			id: "kernel.deep_shallow_contradiction_count_7d",
			source: "kernel-backstop",
			description: "Deep revalidations that contradicted shallow receipt history.",
		},
	];
}

function findResponsibility(
	manifest: RepositoryIrV0,
	responsibilityId: string,
): RepositoryIrResponsibility {
	const responsibility = manifest.responsibilities.find((candidate) => candidate.id === responsibilityId);
	if (responsibility === undefined) {
		throw new ResponsibilityReactorError(`Unknown responsibility '${responsibilityId}'.`);
	}
	return responsibility;
}

function findTrigger(
	manifest: RepositoryIrV0,
	responsibilityId: string,
	triggerId: string,
): RepositoryIrTrigger {
	const trigger = manifest.triggers.find((candidate) => candidate.id === triggerId);
	if (trigger === undefined) {
		throw new ResponsibilityReactorError(`Unknown trigger '${triggerId}'.`);
	}
	if (trigger.responsibilityId !== responsibilityId) {
		throw new ResponsibilityReactorError(
			`Trigger '${triggerId}' belongs to a different responsibility.`,
		);
	}
	return trigger;
}

function selectPressureActivation(
	manifest: RepositoryIrV0,
	options: {
		responsibilityId: string;
		status: ResponsibilityPressureStatus;
		recommendedActivationKind: ResponsibilityPressureActivationKind;
	},
) {
	const candidates = manifest.activations.filter(
		(activation) =>
			activation.responsibilityId === options.responsibilityId &&
			(activation.kind === "fulfillment" || activation.kind === "retry" || activation.kind === "escalation"),
	);

	const preferred = candidates.find((activation) => activation.kind === options.recommendedActivationKind);
	if (preferred !== undefined) {
		return preferred;
	}

	return candidates.find((activation) => activation.kind === "fulfillment") ??
		candidates.find((activation) => activation.kind === "retry") ??
		candidates.find((activation) => activation.kind === "escalation");
}

function selectPressureActivationKind(status: ResponsibilityPressureStatus): ResponsibilityPressureActivationKind {
	return status === "blocked" ? "escalation" : "fulfillment";
}

function shouldIncludeColdStart(reactor: ReactorSdkV0): boolean {
	const registry = reactor.registry();
	return !(
		typeof registry.policy_artifact_namespace === "string" &&
		registry.policy_artifact_namespace.length > 0 &&
		registry.policy_artifact_namespace !== "policy.uninitialized" &&
		typeof registry.policy_artifact_revision === "string" &&
		registry.policy_artifact_revision.length > 0 &&
		registry.policy_artifact_revision !== "0"
	);
}

function latestReceipt(receipts: readonly ReceiptV0[]): ReceiptV0 | undefined {
	return receipts.length === 0 ? undefined : receipts[receipts.length - 1];
}

function normalizeRepositoryServeEventForDedupe(event: RepositoryServeEvent): RepositoryServeEvent {
	if (!isRecord(event.payload) || event.payload.kind !== "openprose.http-event") {
		return event;
	}

	const payload: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(event.payload)) {
		if (key !== "receivedAt") {
			payload[key] = value;
		}
	}
	return { ...event, payload };
}

function addMilliseconds(instant: string, milliseconds: number): string {
	const parsed = Date.parse(instant);
	if (!Number.isFinite(parsed)) {
		throw new ResponsibilityReactorError("asOf must be a replayable instant");
	}
	return new Date(parsed + milliseconds).toISOString();
}

function safePolicySegment(value: string): string {
	const segment = value.replace(/[^A-Za-z0-9_.-]+/g, ".").replace(/^\.+|\.+$/g, "");
	return segment.length === 0 ? "responsibility" : segment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
