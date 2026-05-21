import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	REPOSITORY_SERVE_LOCAL_REACTOR_MODEL,
	REPOSITORY_SERVE_LOCAL_REACTOR_PROVIDER,
	REPOSITORY_SERVE_LOCAL_REACTOR_STATUS_ENV,
} from "../../src/prose/index.js";
import {
	cleanupTemp,
	copyExampleToTemp,
	ensureBuiltCli,
	findFulfillmentArtifactPaths,
	promoteNextManifest,
	readRecord,
	readRepositoryIr,
	readSingleFulfillmentArtifact,
	readString,
	runCli,
	spawnCli,
	stopCli,
	waitFor,
	waitForMatch,
} from "./example-cli-harness.js";

const exampleSlug = "compliance-evidence-tracker";
const responsibilityId = "067NC4KG0HWJNASC5MQ2YC1H68";
const responsibilitySourcePath = "src/compliance-evidence-current.prose.md";
const systemTargetName = "evidence-tracker";
const systemSourcePath = "src/evidence-tracker.prose.md";
const triggerId = "compliance-evidence-current.evidence-change";
const triggerPath = "/webhooks/compliance/evidence";
const activationId = "compliance-evidence-current.fulfillment";
const graphNodeIds = [
	"collect-control-scope",
	"inspect-evidence",
	"prepare-gap-brief",
	"update-evidence-register",
];

describe("compliance evidence tracker example CLI integration", () => {
	it("compiles real source, serves trigger pressure, records fulfillment, and reports status attribution", async () => {
		const temp = copyExampleToTemp(exampleSlug);

		try {
			ensureBuiltCli();

			const compile = await runCli(["compile", "src", "--harness", "mock"], { cwd: temp });
			expect(compile.exitCode, compile.stderr || compile.stdout).toBe(0);
			expect(compile.stdout).toContain("prose compile src");

			const nextManifestPath = join(temp, "dist/manifest.next.json");
			expect(existsSync(nextManifestPath)).toBe(true);
			const manifest = readRepositoryIr(nextManifestPath);
			expect(manifest.responsibilities).toHaveLength(1);
			expect(manifest.responsibilities[0]).toMatchObject({
				id: responsibilityId,
				sourcePath: responsibilitySourcePath,
				fulfillment: {
					mode: "declared",
					targetName: systemTargetName,
					sourcePath: systemSourcePath,
				},
			});
			expect(manifest.triggers).toContainEqual(
				expect.objectContaining({
					id: triggerId,
					responsibilityId,
					kind: "http",
					method: "POST",
					path: triggerPath,
				}),
			);
			expect(manifest.activations).toContainEqual(
				expect.objectContaining({
					id: activationId,
					responsibilityId,
					kind: "fulfillment",
					targetName: systemTargetName,
					sourcePath: systemSourcePath,
					formeManifestId: systemTargetName,
				}),
			);
			expect(manifest.formeManifests[0]).toMatchObject({
				id: systemTargetName,
				systemName: systemTargetName,
				sourcePath: systemSourcePath,
			});
			expect(manifest.formeManifests[0]?.graph.map((node) => node.id)).toEqual(graphNodeIds);

			promoteNextManifest(temp);

			const serve = spawnCli(["serve", "--port", "0", "--harness", "mock"], {
				cwd: temp,
				env: { [REPOSITORY_SERVE_LOCAL_REACTOR_STATUS_ENV]: "down" },
			});

			try {
				const serveUrl = await waitForMatch(() => serve.stdout, /HTTP listening on (http:\/\/127\.0\.0\.1:\d+)/);
				const response = await fetch(`${serveUrl}${triggerPath}`, {
					method: "POST",
					body: JSON.stringify({
						source: "wave-e9-spawned-cli",
						review_window: "SOC2-Q2",
						changed_controls: ["CC6.1", "CC7.2"],
						evidence_updates: [
							{
								control_id: "CC6.1",
								artifact: "access-review-export.csv",
								freshness: "stale",
							},
						],
						audit_request: {
							requested_by: "internal-audit",
							due_at: "2026-05-27T17:00:00.000Z",
						},
					}),
					headers: { "content-type": "application/json" },
				});

				expect(response.status).toBe(202);
				await waitFor(() => existsSync(join(temp, `state/reactor/${responsibilityId}/receipts.json`)));
				await waitFor(() => serve.stdout.includes(`prose run ${systemSourcePath}`));
				await waitFor(() => findFulfillmentArtifactPaths(temp).length === 1);
			} finally {
				await stopCli(serve);
			}

			const artifact = readSingleFulfillmentArtifact(temp);
			expect(artifact).toMatchObject({
				kind: "openprose.fulfillment-artifact",
				version: 0,
				provenance: {
					command: "run",
					forwarded: true,
					harness: "mock",
					exitCode: 0,
					claim: expect.stringContaining("does not claim live-model fulfillment content"),
				},
				activation: {
					id: activationId,
					kind: "fulfillment",
					sourcePath: systemSourcePath,
					targetName: systemTargetName,
					formeManifestId: systemTargetName,
				},
				responsibility: {
					id: responsibilityId,
					sourcePath: responsibilitySourcePath,
				},
				pressure: {
					status: "down",
					recommendedActivationKind: "fulfillment",
					activationId,
				},
				trigger: {
					id: `${responsibilityId}.pressure`,
					kind: "manual",
				},
			});
			expect(readString(artifact.artifactPath)).toMatch(/^runs\/[0-9a-f-]+\/fulfillment-artifact\.json$/);
			expect(readString(readRecord(artifact.provenance)?.prompt)).toContain(`prose run ${systemSourcePath}`);
			const event = readRecord(artifact.event);
			expect(event).toMatchObject({
				triggerId: `${responsibilityId}.pressure`,
				payload: {
					kind: "openprose.pressure-event",
					pressure: {
						responsibilityId,
						status: "down",
						activationId,
						recommendedActivationKind: "fulfillment",
					},
				},
			});
			expect(readRecord(readRecord(event?.payload)?.pressure)?.evidence).toEqual(
				expect.arrayContaining([expect.stringContaining("surprise_cause=real-input")]),
			);

			const status = await runCli(["status"], { cwd: temp });
			expect(status.exitCode, status.stderr || status.stdout).toBe(0);
			expect(status.stdout).toContain("status: down at ");
			expect(status.stdout).toContain(`provider=${REPOSITORY_SERVE_LOCAL_REACTOR_PROVIDER}`);
			expect(status.stdout).toContain(`model=${REPOSITORY_SERVE_LOCAL_REACTOR_MODEL}`);
			expect(status.stdout).toContain("surprise_cause=real-input");
			expect(status.stdout).toContain("fresh=");
			expect(status.stdout).toContain("reused=0");
			expect(status.stdout).toContain(`pressure: fulfillment for down -> ${activationId};`);
			expect(existsSync(join(temp, `state/responsibilities/${responsibilityId}/latest.json`))).toBe(false);
		} finally {
			cleanupTemp(temp);
		}
	}, 30_000);
});
