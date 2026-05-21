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

const responsibilityId = "067NC4KG0XVMH2AA9D64TKJFA0";
const responsibilitySourcePath = "src/customer-risk-maintained.prose.md";
const fulfillmentId = "customer-risk-maintained.fulfillment";
const fulfillmentSourcePath = "src/risk-radar.prose.md";
const fulfillmentTargetName = "risk-radar";
const triggerPath = "/webhooks/customer-risk/signals";
const reactorReceiptPath = `state/reactor/${responsibilityId}/receipts.json`;
const legacyLatestPath = `state/responsibilities/${responsibilityId}/latest.json`;

describe("customer-risk-radar example CLI integration", () => {
	it("compiles source, serves a trigger, records fulfillment, and reports Reactor attribution", async () => {
		const root = copyExampleToTemp("customer-risk-radar");

		try {
			ensureBuiltCli();

			const compile = await runCli(["compile", "src", "--harness", "mock"], { cwd: root });
			expect(compile.exitCode, compile.stderr || compile.stdout).toBe(0);
			expect(compile.stdout).toContain("prose compile src");
			expect(existsSync(join(root, NEXT_REPOSITORY_IR_PATH))).toBe(true);

			const manifest = readRepositoryIr(join(root, NEXT_REPOSITORY_IR_PATH));
			expect(manifest.sources).toEqual(
				expect.arrayContaining([
					{ path: responsibilitySourcePath, kind: "responsibility", name: "customer-risk-maintained" },
					{ path: "src/customer-risk-review.prose.md", kind: "gateway", name: "customer-risk-review" },
					{ path: fulfillmentSourcePath, kind: "system", name: fulfillmentTargetName },
				]),
			);
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
					id: "customer-risk-maintained.evidence-change",
					responsibilityId,
					kind: "http",
					method: "POST",
					path: triggerPath,
				}),
			);
			expect(manifest.activations).toContainEqual(
				expect.objectContaining({
					id: fulfillmentId,
					responsibilityId,
					kind: "fulfillment",
					targetName: fulfillmentTargetName,
					sourcePath: fulfillmentSourcePath,
					formeManifestId: fulfillmentTargetName,
				}),
			);
			const riskRadarManifest = manifest.formeManifests.find((forme) => forme.id === fulfillmentTargetName);
			expect(riskRadarManifest?.graph.map((node) => node.id)).toEqual([
				"collect-account-signals",
				"assess-risk",
				"recommend-actions",
				"update-risk-ledger",
			]);

			promoteNextManifest(root);

			const serve = spawnCli(["serve", "--port", "0", "--harness", "mock"], {
				cwd: root,
				env: { [REPOSITORY_SERVE_LOCAL_REACTOR_STATUS_ENV]: "down" },
			});

			try {
				const serveUrl = await waitForMatch(() => serve.stdout, /HTTP listening on (http:\/\/127\.0\.0\.1:\d+)/);
				const response = await fetch(`${serveUrl}${triggerPath}`, {
					method: "POST",
					body: JSON.stringify({
						kind: "account-signal-change",
						source: "customer-health-pipeline",
						reported_at: "2026-05-20T18:30:00.000Z",
						accounts: [
							{
								account_id: "acct-northstar",
								owner: "renewals-team",
								renewal_date: "2026-06-15",
								usage_trend: "down-32pct-14d",
								support_friction: "three-severity-two-tickets-open",
								stakeholder_note: "executive sponsor changed roles",
							},
						],
					}),
					headers: { "content-type": "application/json" },
				});

				expect(response.status).toBe(202);
				await waitFor(() => existsSync(join(root, reactorReceiptPath)));
				await waitFor(() => serve.stdout.includes(`prose run ${fulfillmentSourcePath}`));
				await waitFor(() => findFulfillmentArtifactPaths(root).length === 1);
			} finally {
				await stopCli(serve);
			}

			expect(findFulfillmentArtifactPaths(root)).toHaveLength(1);
			const artifact = readSingleFulfillmentArtifact(root);
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
					id: fulfillmentId,
					kind: "fulfillment",
					sourcePath: fulfillmentSourcePath,
					targetName: fulfillmentTargetName,
					formeManifestId: fulfillmentTargetName,
				},
				responsibility: {
					id: responsibilityId,
					sourcePath: responsibilitySourcePath,
					goal: "Customer risk is visible early enough that account owners can intervene before churn, renewal, or escalation windows become urgent.",
				},
				trigger: {
					id: `${responsibilityId}.pressure`,
					kind: "manual",
					reason: "Responsibility pressure requested fulfillment.",
				},
				pressure: {
					status: "down",
					recommendedActivationKind: "fulfillment",
					activationId: fulfillmentId,
				},
			});
			expect(readString(artifact.artifactPath)).toMatch(/^runs\/[0-9a-f-]+\/fulfillment-artifact\.json$/);
			expect(readString((readRecord(artifact.provenance) ?? {}).prompt)).toContain(
				`prose run ${fulfillmentSourcePath}`,
			);
			expect((readRecord(artifact.event) ?? {}).triggerId).toBe(`${responsibilityId}.pressure`);
			expect(readRecord((readRecord(artifact.event) ?? {}).payload)).toMatchObject({
				kind: "openprose.pressure-event",
				pressure: {
					responsibilityId,
					status: "down",
					recommendedActivationKind: "fulfillment",
					activationId: fulfillmentId,
				},
			});

			const status = await runCli(["status"], { cwd: root });
			expect(status.exitCode, status.stderr || status.stdout).toBe(0);
			expect(status.stdout).toContain("status: down at ");
			expect(status.stdout).toContain(`provider=${REPOSITORY_SERVE_LOCAL_REACTOR_PROVIDER}`);
			expect(status.stdout).toContain(`model=${REPOSITORY_SERVE_LOCAL_REACTOR_MODEL}`);
			expect(status.stdout).toContain("surprise_cause=real-input");
			expect(status.stdout).toContain("fresh=");
			expect(status.stdout).toContain("reused=0");
			expect(status.stdout).toContain(`pressure: fulfillment for down -> ${fulfillmentId};`);
			expect(existsSync(join(root, legacyLatestPath))).toBe(false);
		} finally {
			cleanupTemp(root);
		}
	}, 30_000);
});
