import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { CommandName } from "./command-model.js";

export const FULFILLMENT_ARTIFACT_KIND = "openprose.fulfillment-artifact";
export const FULFILLMENT_ARTIFACT_VERSION = 0;
export const PROSE_FULFILLMENT_ARTIFACT_PATH_ENV = "PROSE_FULFILLMENT_ARTIFACT_PATH";

const artifactActivationKinds = new Set(["fulfillment", "retry", "escalation"]);

export interface ForwardedFulfillmentArtifactOptions {
	command: CommandName;
	argv: readonly string[];
	cwd: string;
	env: Readonly<Record<string, string | undefined>>;
	exitCode: number;
	harness: string;
	prompt: string;
}

export async function recordForwardedFulfillmentArtifact(
	options: ForwardedFulfillmentArtifactOptions,
): Promise<string | undefined> {
	if (options.command !== "run" || options.exitCode !== 0) {
		return undefined;
	}

	const relativeArtifactPath = options.env[PROSE_FULFILLMENT_ARTIFACT_PATH_ENV];
	if (relativeArtifactPath === undefined) {
		return undefined;
	}
	if (relativeArtifactPath.length === 0 || isAbsolute(relativeArtifactPath)) {
		throw new FulfillmentArtifactError(`${PROSE_FULFILLMENT_ARTIFACT_PATH_ENV} must be a root-relative path.`);
	}

	const contextText = options.env.PROSE_ACTIVATION_CONTEXT;
	if (contextText === undefined) {
		throw new FulfillmentArtifactError(
			`${PROSE_FULFILLMENT_ARTIFACT_PATH_ENV} requires PROSE_ACTIVATION_CONTEXT.`,
		);
	}

	const context = parseActivationContext(contextText);
	const activation = readRecord(context.activation);
	const activationKind = readString(activation?.kind);
	if (activationKind === undefined || !artifactActivationKinds.has(activationKind)) {
		return undefined;
	}

	const openProseRoot = options.env.PROSE_OPENPROSE_ROOT ?? options.cwd;
	const absoluteArtifactPath = resolve(openProseRoot, relativeArtifactPath);
	if (!isPathInside(resolve(openProseRoot), absoluteArtifactPath)) {
		throw new FulfillmentArtifactError(`${PROSE_FULFILLMENT_ARTIFACT_PATH_ENV} must stay inside the OpenProse root.`);
	}

	const artifact = buildArtifact({
		context,
		exitCode: options.exitCode,
		harness: options.harness,
		prompt: options.prompt,
		relativeArtifactPath,
	});
	await mkdir(dirname(absoluteArtifactPath), { recursive: true });
	await writeFile(absoluteArtifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
	return absoluteArtifactPath;
}

export class FulfillmentArtifactError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FulfillmentArtifactError";
	}
}

function buildArtifact(options: {
	context: Record<string, unknown>;
	exitCode: number;
	harness: string;
	prompt: string;
	relativeArtifactPath: string;
}): Record<string, unknown> {
	const activation = readRecord(options.context.activation) ?? {};
	const responsibility = readRecord(options.context.responsibility) ?? {};
	const trigger = readRecord(options.context.trigger) ?? {};
	const pressure = readRecord(options.context.pressure);
	const event = readRecord(options.context.event);

	return {
		kind: FULFILLMENT_ARTIFACT_KIND,
		version: FULFILLMENT_ARTIFACT_VERSION,
		recordedAt: new Date().toISOString(),
		artifactPath: options.relativeArtifactPath,
		provenance: {
			command: "run",
			forwarded: true,
			harness: options.harness,
			exitCode: options.exitCode,
			prompt: options.prompt,
			claim: "Activation dispatch artifact only; it does not claim live-model fulfillment content.",
		},
		activation: compactRecord({
			id: readString(activation.id),
			kind: readString(activation.kind),
			attemptId: readString(activation.attemptId),
			sourcePath: readString(activation.sourcePath),
			targetName: readString(activation.targetName),
			formeManifestId: readString(activation.formeManifestId),
		}),
		responsibility: compactRecord({
			id: readString(responsibility.id),
			fingerprint: readString(responsibility.fingerprint),
			sourcePath: readString(responsibility.sourcePath),
			goal: readString(responsibility.goal),
		}),
		trigger: compactRecord({
			id: readString(trigger.id),
			kind: readString(trigger.kind),
			reason: readString(trigger.reason),
		}),
		...(pressure === undefined
			? {}
			: {
					pressure: compactRecord({
						id: readString(pressure.pressureId),
						dedupeKey: readString(pressure.dedupeKey),
						status: readString(pressure.status),
						recommendedActivationKind: readString(pressure.recommendedActivationKind),
						activationId: readString(pressure.activationId),
						recordedAt: readString(pressure.recordedAt),
						reason: readString(pressure.reason),
					}),
				}),
		...(event === undefined ? {} : { event }),
	};
}

function parseActivationContext(text: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new FulfillmentArtifactError(`Unable to parse PROSE_ACTIVATION_CONTEXT: ${message}`);
	}
	if (!isRecord(parsed)) {
		throw new FulfillmentArtifactError("PROSE_ACTIVATION_CONTEXT must be a JSON object.");
	}
	return parsed;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPathInside(root: string, path: string): boolean {
	const relativePath = relative(root, path);
	return relativePath === "" || (!relativePath.startsWith("..") && relativePath !== ".." && !isAbsolute(relativePath));
}
