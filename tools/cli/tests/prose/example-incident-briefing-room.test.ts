import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	NEXT_REPOSITORY_IR_PATH,
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

const exampleSlug = "incident-briefing-room";
const responsibilityId = "067NC4KG0NSK9D9P6WW3JEHV7G";
const responsibilitySourcePath = "src/incident-channel-current.prose.md";
const fulfillmentActivationId = "incident-channel-current.fulfillment";
const fulfillmentSourcePath = "src/incident-briefing-room.prose.md";
const fulfillmentTargetName = "incident-briefing-room";
const triggerId = "incident-channel-current.evidence-change";

describe("incident briefing room bundled example", () => {
	it("runs real source compile, serve fulfillment, and status attribution through spawned CLI", async () => {
		const temp = copyExampleToTemp(exampleSlug);

		try {
			ensureBuiltCli();

			const compile = await runCli(["compile", "src", "--harness", "mock"], { cwd: temp });
			expect(compile.exitCode, compile.stderr || compile.stdout).toBe(0);
			expect(compile.stdout).toContain("prose compile src");
			expect(existsSync(join(temp, NEXT_REPOSITORY_IR_PATH))).toBe(true);

			const manifest = readRepositoryIr(join(temp, NEXT_REPOSITORY_IR_PATH));
			expect(manifest.responsibilities).toHaveLength(1);
			expect(manifest.responsibilities[0]).toMatchObject({
				id: responsibilityId,
				sourcePath: responsibilitySourcePath,
				fulfillment: {
					mode: "declared",
					targetName: fulfillmentTargetName,
					sourcePath: fulfillmentSourcePath,
				},
			});
			expect(manifest.triggers).toContainEqual(
				expect.objectContaining({
					id: triggerId,
					responsibilityId,
					kind: "http",
					method: "POST",
					path: "/incident/events",
				}),
			);
			expect(manifest.activations).toContainEqual(
				expect.objectContaining({
					id: fulfillmentActivationId,
					responsibilityId,
					kind: "fulfillment",
					targetName: fulfillmentTargetName,
					sourcePath: fulfillmentSourcePath,
					formeManifestId: fulfillmentTargetName,
				}),
			);
			expect(manifest.formeManifests[0]?.graph.map((node) => node.id)).toEqual([
				"collect-incident-signals",
				"assess-customer-impact",
				"draft-incident-brief",
				"review-incident-actions",
			]);

			promoteNextManifest(temp);

			const serve = spawnCli(["serve", "--port", "0", "--harness", "mock"], {
				cwd: temp,
				env: { [REPOSITORY_SERVE_LOCAL_REACTOR_STATUS_ENV]: "down" },
			});

			try {
				const serveUrl = await waitForMatch(() => serve.stdout, /HTTP listening on (http:\/\/127\.0\.0\.1:\d+)/);
				const response = await fetch(`${serveUrl}/incident/events`, {
					method: "POST",
					body: JSON.stringify({
						incident_id: "inc-2026-05-20-checkout-latency",
						source: "pagerduty",
						reported_at: "2026-05-20T19:14:00.000Z",
						summary: "Checkout latency rose after the canary deploy; support has three enterprise tickets.",
						links: ["https://status.example.test/incidents/inc-2026-05-20-checkout-latency"],
						severity: "sev2",
					}),
					headers: { "content-type": "application/json" },
				});

				expect(response.status).toBe(202);
				await waitFor(() => existsSync(join(temp, `state/reactor/${responsibilityId}/receipts.json`)));
				await waitFor(() => serve.stdout.includes(`prose run ${fulfillmentSourcePath}`));
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
					id: fulfillmentActivationId,
					kind: "fulfillment",
					sourcePath: fulfillmentSourcePath,
					targetName: fulfillmentTargetName,
					formeManifestId: fulfillmentTargetName,
				},
				responsibility: {
					id: responsibilityId,
					sourcePath: responsibilitySourcePath,
				},
				pressure: {
					status: "down",
					recommendedActivationKind: "fulfillment",
					activationId: fulfillmentActivationId,
				},
			});
			expect(readString(artifact.artifactPath)).toMatch(/^runs\/[0-9a-f-]+\/fulfillment-artifact\.json$/);
			expect(readString(readRecord(artifact.provenance)?.prompt)).toContain(`prose run ${fulfillmentSourcePath}`);
			expect(readRecord(artifact.trigger)).toMatchObject({
				id: `${responsibilityId}.pressure`,
				kind: "manual",
			});
			expect(readRecord(artifact.event)).toMatchObject({
				triggerId: `${responsibilityId}.pressure`,
				payload: {
					kind: "openprose.pressure-event",
					pressure: {
						responsibilityId,
						activationId: fulfillmentActivationId,
						status: "down",
					},
				},
			});

			const status = await runCli(["status"], { cwd: temp });
			expect(status.exitCode, status.stderr || status.stdout).toBe(0);
			expect(status.stdout).toContain("status: down at ");
			expect(status.stdout).toContain(`provider=${REPOSITORY_SERVE_LOCAL_REACTOR_PROVIDER}`);
			expect(status.stdout).toContain(`model=${REPOSITORY_SERVE_LOCAL_REACTOR_MODEL}`);
			expect(status.stdout).toContain("surprise_cause=real-input");
			expect(status.stdout).toContain("fresh=");
			expect(status.stdout).toContain("reused=0");
			expect(status.stdout).toContain(`pressure: fulfillment for down -> ${fulfillmentActivationId};`);
			expect(existsSync(join(temp, `state/responsibilities/${responsibilityId}/latest.json`))).toBe(false);
		} finally {
			cleanupTemp(temp);
		}
	}, 30_000);
});
