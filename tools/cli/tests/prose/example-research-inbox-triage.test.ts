import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	NEXT_REPOSITORY_IR_PATH,
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

const exampleSlug = "research-inbox-triage";
const responsibilityId = "067NC4KG15XNS7AYBXG62RK3CG";
const responsibilitySourcePath = "src/research-inbox-responsibility.prose.md";
const systemName = "research-inbox-triage";
const systemSourcePath = "src/research-inbox-triage.prose.md";
const fulfillmentActivationId = "research-inbox-responsibility.fulfillment";

describe("research-inbox-triage example CLI integration", () => {
	it("uses real source compile and writes a fulfillment artifact from spawned serve", async () => {
		ensureBuiltCli();
		const temp = copyExampleToTemp(exampleSlug);

		try {
			const compile = await runCli(["compile", "src", "--harness", "mock"], { cwd: temp });
			expect(compile.exitCode, compile.stderr || compile.stdout).toBe(0);
			expect(compile.stdout).toContain("prose compile src");

			const nextManifestPath = join(temp, NEXT_REPOSITORY_IR_PATH);
			expect(existsSync(nextManifestPath)).toBe(true);
			const manifest = readRepositoryIr(nextManifestPath);
			expect(manifest.sources).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "responsibility",
						name: "research-inbox-responsibility",
						path: responsibilitySourcePath,
					}),
					expect.objectContaining({
						kind: "system",
						name: systemName,
						path: systemSourcePath,
					}),
				]),
			);
			expect(manifest.responsibilities).toEqual([
				expect.objectContaining({
					id: responsibilityId,
					sourcePath: responsibilitySourcePath,
					fulfillment: expect.objectContaining({
						mode: "declared",
						targetName: systemName,
						sourcePath: systemSourcePath,
					}),
				}),
			]);
			expect(manifest.triggers).toContainEqual(
				expect.objectContaining({
					id: "research-inbox-responsibility.evidence-change",
					responsibilityId,
					kind: "http",
					method: "POST",
					path: "/inbox/items",
				}),
			);
			expect(manifest.activations).toContainEqual(
				expect.objectContaining({
					id: fulfillmentActivationId,
					responsibilityId,
					kind: "fulfillment",
					targetName: systemName,
					sourcePath: systemSourcePath,
					formeManifestId: systemName,
				}),
			);
			expect(manifest.formeManifests).toEqual([
				expect.objectContaining({
					id: systemName,
					systemName,
					sourcePath: systemSourcePath,
					graph: [
						expect.objectContaining({ id: "inbox-ingestor" }),
						expect.objectContaining({ id: "topic-clusterer" }),
						expect.objectContaining({ id: "priority-scorer" }),
						expect.objectContaining({ id: "action-planner" }),
					],
				}),
			]);

			promoteNextManifest(temp);

			const serve = spawnCli(["serve", "--port", "0", "--harness", "mock"], {
				cwd: temp,
				env: { [REPOSITORY_SERVE_LOCAL_REACTOR_STATUS_ENV]: "down" },
			});

			try {
				const serveUrl = await waitForMatch(() => serve.stdout, /HTTP listening on (http:\/\/127\.0\.0\.1:\d+)/);
				const response = await fetch(`${serveUrl}/inbox/items`, {
					method: "POST",
					body: JSON.stringify({
						item: {
							title: "New retrieval benchmark for grounded answer quality",
							source_url: "https://example.test/research/retrieval-benchmark",
							submitter_note: "Looks relevant to the active RAG evaluation question.",
						},
						active_questions: ["How should we evaluate retrieval quality for long-form answers?"],
						available_owners: ["research lead", "platform engineer"],
						received_at: "2026-05-20T17:00:00.000Z",
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
					id: fulfillmentActivationId,
					kind: "fulfillment",
					sourcePath: systemSourcePath,
					targetName: systemName,
					formeManifestId: systemName,
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
			expect(readString(readRecord(artifact.provenance)?.prompt)).toContain(`prose run ${systemSourcePath}`);
			expect(readRecord(readRecord(artifact.event)?.payload)).toMatchObject({
				kind: "openprose.pressure-event",
				pressure: expect.objectContaining({
					responsibilityId,
					status: "down",
					activationId: fulfillmentActivationId,
				}),
			});

			const status = await runCli(["status"], { cwd: temp });
			expect(status.exitCode, status.stderr || status.stdout).toBe(0);
			expect(status.stdout).toContain("status: down at ");
			expect(status.stdout).toContain(`provider=${REPOSITORY_SERVE_LOCAL_REACTOR_PROVIDER}`);
			expect(status.stdout).toContain("model=deterministic-shallow-v0");
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
