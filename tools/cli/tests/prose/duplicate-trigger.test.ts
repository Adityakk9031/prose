import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	ACTIVE_REPOSITORY_IR_PATH,
	buildResponsibilityPressurePaths,
	createLocalRepositoryServeReactorOptions,
	startRepositoryServeDaemon,
	type OpenProseRoot,
	type RepositoryIrV0,
	type RepositoryServeDaemon,
	type RepositoryServeReactorOptions,
} from "../../src/prose/index.js";

const releaseReadinessResponsibilityId = "067NC4KG0SYKXFT085146H258R";
const releaseReadinessTriggerId = "release-candidate-ready.evidence-change";
const releaseReadinessFulfillmentId = "release-candidate-ready.fulfillment";
const fixedCycleTime = "2026-05-20T12:05:00.000Z";

function memoryStreams() {
	let stdout = "";
	let stderr = "";

	return {
		streams: {
			stdout: { write: (chunk: string) => void (stdout += chunk) },
			stderr: { write: (chunk: string) => void (stderr += chunk) },
		},
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
	};
}

describe("duplicate release-readiness triggers", () => {
	it("claims one durable pressure and dispatches fulfillment once for identical POST triggers in a serve cycle", async () => {
		const temp = mkdtempSync(join(tmpdir(), "prose-duplicate-trigger-"));
		const io = memoryStreams();
		const env = { PROSE_REACTOR_LOCAL_STATUS: "down" };
		const secondPosted = deferred();
		const emittedEvents: unknown[] = [];
		const activationCalls: Array<{ activationId: string; pressureId: string; dedupeKey: string }> = [];
		let ingestEvents = 0;
		let currentCycleTime = fixedCycleTime;
		let daemon: RepositoryServeDaemon | undefined;

		const eventSink: NonNullable<RepositoryServeReactorOptions["eventSink"]> = {
			emit(event) {
				emittedEvents.push(event);
				if (isRecord(event) && event.type === "ingest") {
					ingestEvents += 1;
				}
			},
		};

		try {
			writeActiveManifest(temp);
			daemon = await startRepositoryServeDaemon({
				cwd: temp,
				env,
				host: "127.0.0.1",
				port: 0,
				now: () => new Date(currentCycleTime),
				reactor: {
					...createLocalRepositoryServeReactorOptions({
						env,
						now: () => currentCycleTime,
					}),
					eventSink,
				},
				stdout: io.streams.stdout,
				stderr: io.streams.stderr,
				commandRunner: async (options) => {
					activationCalls.push({
						activationId: options.env.PROSE_ACTIVATION_ID ?? "",
						pressureId: options.env.PROSE_PRESSURE_ID ?? "",
						dedupeKey: options.env.PROSE_PRESSURE_DEDUPE_KEY ?? "",
					});
					if (activationCalls.length === 1) {
						await secondPosted.promise;
					}
					return 0;
				},
			});

			expect(daemon.address).toBeDefined();
			const body = JSON.stringify({
				release_id: "v0.1.0-rc",
				source: "duplicate-trigger-test",
				reported_at: fixedCycleTime,
				summary: "Release readiness review requested.",
			});

			const first = await postReleaseReadiness(daemon.address!.url, body);
			expect(first.status).toBe(202);
			await waitFor(() => activationCalls.length === 1);

			const root: OpenProseRoot = { mode: "native", path: ".", absolutePath: temp };
			const pressurePaths = buildResponsibilityPressurePaths(root, releaseReadinessResponsibilityId);
			await waitFor(() => existsSync(pressurePaths.absolutePressureLogPath));

			currentCycleTime = "2026-05-20T12:05:01.000Z";
			const second = await postReleaseReadiness(daemon.address!.url, body);
			expect(second.status).toBe(202);
			secondPosted.resolve();
			await waitFor(() => ingestEvents === 1);

			await daemon.stop();
			daemon = undefined;

			const pressureLog = readJsonl(pressurePaths.absolutePressureLogPath);
			const claimFiles = readdirSync(pressurePaths.absolutePressureClaimDirectoryPath).filter((name) =>
				name.endsWith(".json"),
			);
			const receipts = JSON.parse(
				readFileSync(join(temp, `state/reactor/${releaseReadinessResponsibilityId}/receipts.json`), "utf8"),
			) as Array<{ content_hash?: string }>;
			expect(emittedEvents).toHaveLength(1);
			expect(activationCalls.map((call) => call.activationId)).toEqual([releaseReadinessFulfillmentId]);
			expect(receipts).toHaveLength(1);
			expect(pressureLog).toHaveLength(1);
			expect(claimFiles).toHaveLength(1);
			const claimFile = claimFiles[0];
			if (claimFile === undefined) {
				throw new Error("Expected one pressure claim file.");
			}
			const claimedPressure = JSON.parse(
				readFileSync(join(pressurePaths.absolutePressureClaimDirectoryPath, claimFile), "utf8"),
			) as PressureLogEntry;
			expect(claimedPressure).toEqual(pressureLog[0]);
			expect(activationCalls[0]).toMatchObject({
				pressureId: pressureLog[0]?.pressureId,
				dedupeKey: pressureLog[0]?.dedupeKey,
			});
			expect(pressureLog[0]?.source.statusRunId).toBe(receipts[0]?.content_hash);
			expect(pressureLog[0]?.source.triggerDedupeKey).toMatch(/^sha256:[0-9a-f]{64}$/);
		} finally {
			secondPosted.resolve();
			await daemon?.stop();
			rmSync(temp, { recursive: true, force: true });
		}
	}, 10_000);
});

async function postReleaseReadiness(url: string, body: string): Promise<Response> {
	return fetch(`${url}/release/readiness`, {
		method: "POST",
		body,
		headers: { "content-type": "application/json" },
	});
}

function writeActiveManifest(root: string): void {
	writeJson(join(root, ACTIVE_REPOSITORY_IR_PATH), releaseReadinessManifest());
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

interface PressureLogEntry {
	pressureId?: string;
	dedupeKey?: string;
	source: {
		statusRunId?: string;
		triggerDedupeKey?: string;
	};
}

function readJsonl(path: string): PressureLogEntry[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as PressureLogEntry);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("Timed out waiting for condition.");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function releaseReadinessManifest(): RepositoryIrV0 {
	return {
		kind: "openprose.repository-ir",
		version: 0,
		sources: [
			{ path: "src/release-candidate-ready.prose.md", kind: "responsibility", name: "release-candidate-ready" },
			{ path: "src/release-readiness-events.prose.md", kind: "gateway", name: "release-readiness-events" },
			{ path: "src/release-readiness.prose.md", kind: "system", name: "release-readiness" },
			{ path: "src/record-release-decision.prose.md", kind: "service", name: "record-release-decision" },
		],
		responsibilities: [
			{
				id: releaseReadinessResponsibilityId,
				sourcePath: "src/release-candidate-ready.prose.md",
				goal: "The release candidate has a current readiness decision before shipping.",
				continuity: ["Reconcile readiness when release evidence or owner overrides change."],
				criteria: ["The readiness decision names ship or hold and cites the evidence behind it."],
				constraints: ["Do not recommend shipping with unresolved blockers hidden in caveats."],
				tools: [],
				fulfillment: {
					mode: "declared",
					targetName: "release-readiness",
					sourcePath: "src/release-readiness.prose.md",
				},
			},
		],
		triggers: [
			{
				id: releaseReadinessTriggerId,
				responsibilityId: releaseReadinessResponsibilityId,
				kind: "http",
				method: "POST",
				path: "/release/readiness",
				reason: "Release-readiness events should refresh the current ship or hold decision.",
			},
		],
		activations: [
			{
				id: "release-candidate-ready.judge",
				responsibilityId: releaseReadinessResponsibilityId,
				kind: "judge",
				triggerIds: [releaseReadinessTriggerId],
				reason: "Determine whether the release candidate readiness responsibility is up, drifting, down, or blocked.",
			},
			{
				id: releaseReadinessFulfillmentId,
				responsibilityId: releaseReadinessResponsibilityId,
				kind: "fulfillment",
				triggerIds: [releaseReadinessTriggerId],
				targetName: "release-readiness",
				sourcePath: "src/release-readiness.prose.md",
				formeManifestId: "release-readiness",
				reason: "Use the release-readiness system when Reactor pressure says the responsibility needs work.",
			},
		],
		formeManifests: [
			{
				id: "release-readiness",
				systemName: "release-readiness",
				sourcePath: "src/release-readiness.prose.md",
				caller: {
					requires: [{ name: "activation_event" }],
					returns: [{ name: "decision_record", source: "record-release-decision" }],
				},
				graph: [
					{
						id: "record-release-decision",
						sourcePath: "src/record-release-decision.prose.md",
						workspacePath: "workspace/record-release-decision/",
						inputs: [{ name: "activation_event", from: "caller", path: "inputs/activation_event.json" }],
						outputs: [
							{
								name: "decision_record",
								workspacePath: "workspace/record-release-decision/decision_record.md",
								bindingPath: "bindings/record-release-decision/decision_record.md",
								public: true,
							},
						],
					},
				],
				executionOrder: [{ nodeId: "record-release-decision", dependsOn: ["caller"] }],
				environment: [],
				tools: [],
				warnings: [],
			},
		],
		diagnostics: [],
	};
}
