import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createReceiptV0,
	projectReceiptV0,
	type ReceiptV0,
	type ReceiptV0Input,
} from "@openprose/reactor";
import { describe, expect, it } from "vitest";

import { parseStatusArgs } from "../../src/commands/status.js";
import {
	ACTIVE_REPOSITORY_IR_PATH,
	buildReactorContractRevision,
	buildResponsibilityReactorPaths,
	formatRepositoryStatus,
	loadRepositoryStatus,
	type OpenProseRoot,
	type RepositoryIrResponsibility,
	type RepositoryIrV0,
} from "../../src/prose/index.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const stargazerFixture = join(repoRoot, "tests/open-prose/compiler/expected/stargazer.manifest.next.json");
const HASH_B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const AS_OF = "2026-05-20T15:00:00.000Z";
const NEXT_RECHECK = "2026-05-21T15:00:00.000Z";
const SECRET = "api_key=e15_projection_secret_1234567890";

describe("repository status projection tiers", () => {
	it("accepts owner subscriber and public status tier arguments", () => {
		expect(parseStatusArgs([])).toEqual({ tier: "owner" });

		for (const tier of ["owner", "subscriber", "public"] as const) {
			expect(parseStatusArgs([`--tier=${tier}`])).toEqual({ tier });
			expect(parseStatusArgs(["--tier", tier])).toEqual({ tier });
		}

		expect(() => parseStatusArgs(["--tier=partner"])).toThrow("Unsupported status projection tier");
	});

	it("renders subscriber and public projections without leaking receipt private fields", async () => {
		const temp = mkdtempSync(join(tmpdir(), "prose-status-projection-tier-"));

		try {
			writeActiveManifest(temp);
			const manifest = readFixture();
			const responsibility = manifest.responsibilities[0]!;
			const receipt = makeSecretBearingReceipt(responsibility);
			writeReceipt(temp, responsibility, receipt);

			expect(JSON.stringify(receipt)).toContain(SECRET);

			const ownerProjection = projectReceiptV0({ tier: "owner", receipt });
			if (!ownerProjection.ok) {
				throw new Error(ownerProjection.errors.join("; "));
			}
			const ownerProjectionExposesSecret = JSON.stringify(ownerProjection.projection).includes(SECRET);
			const ownerOutput = formatRepositoryStatus(await loadRepositoryStatus({ cwd: temp, tier: "owner" }));
			expect(ownerOutput.includes(SECRET)).toBe(ownerProjectionExposesSecret);

			const subscriberOutput = formatRepositoryStatus(await loadRepositoryStatus({ cwd: temp, tier: "subscriber" }));
			expect(subscriberOutput).toContain("  projection: subscriber");
			expect(subscriberOutput).toContain("provider=cli-projection-test");
			expect(subscriberOutput).toContain("model=fixture-private-receipt");
			expect(subscriberOutput).not.toContain(SECRET);

			const publicOutput = formatRepositoryStatus(await loadRepositoryStatus({ cwd: temp, tier: "public" }));
			expect(publicOutput).toContain("  projection: public");
			expect(publicOutput).toContain("surprise_cause=real-input");
			expect(publicOutput).not.toContain("provider=cli-projection-test");
			expect(publicOutput).not.toContain("model=fixture-private-receipt");
			expect(publicOutput).not.toContain(SECRET);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});
});

function writeActiveManifest(temp: string): void {
	const activePath = join(temp, ACTIVE_REPOSITORY_IR_PATH);
	mkdirSync(dirname(activePath), { recursive: true });
	copyFileSync(stargazerFixture, activePath);
}

function readFixture(): RepositoryIrV0 {
	return JSON.parse(readFileSync(stargazerFixture, "utf8")) as RepositoryIrV0;
}

function writeReceipt(temp: string, responsibility: RepositoryIrResponsibility, receipt: ReceiptV0): void {
	const openProseRoot: OpenProseRoot = { mode: "native", path: ".", absolutePath: temp };
	const paths = buildResponsibilityReactorPaths(openProseRoot, responsibility.id);
	mkdirSync(paths.absoluteDirectoryPath, { recursive: true });
	writeFileSync(join(paths.absoluteDirectoryPath, "receipts.json"), `${JSON.stringify([receipt], null, 2)}\n`);
}

function makeSecretBearingReceipt(responsibility: RepositoryIrResponsibility): ReceiptV0 {
	return createReceiptV0(makeReceiptInput(responsibility));
}

function makeReceiptInput(responsibility: RepositoryIrResponsibility): ReceiptV0Input {
	const contractRevision = buildReactorContractRevision(responsibility);

	return {
		core: {
			responsibility_id: responsibility.id,
			contract_revision: contractRevision,
			event_cause: "real-input",
			memo_key: "projection-tier-secret-injection",
			evidence_input_ids: [HASH_B],
			as_of: AS_OF,
			role: "judge",
		},
		sig: {
			scheme: "none",
			null_reason: "single-host v0.1 fixture; no cross-domain non-repudiation",
		},
		verdict: {
			status: "blocked",
			confidence: {
				value: 0.61,
				derivation_method: "projection-tier-fixture",
				calibration_grade: "none",
				label_source: "secret-injection",
			},
			blocked: {
				reason: `Owner-only private rationale includes ${SECRET}`,
				fix_target: "contract-author",
				interrupt_cause: "needs-input",
			},
		},
		freshness: {
			as_of: AS_OF,
			next_forecast_recheck: NEXT_RECHECK,
		},
		composition: {
			consumed_receipts: [],
			cycle_checked: true,
		},
		cost: {
			provider: "cli-projection-test",
			model: "fixture-private-receipt",
			role: "judge",
			tags: ["projection-tier", SECRET],
			responsibility_id: responsibility.id,
			run_id: "projection-tier-secret-run",
			as_of: AS_OF,
			tokens: {
				fresh: 19,
				reused: 5,
			},
			surprise_cause: "real-input",
			provider_norm: {
				schema: "openprose.cli.projection-tier-fixture",
				rationale: `Private rationale: ${SECRET}`,
				raw_evidence_payload: {
					private_evidence: `Private evidence: ${SECRET}`,
				},
			},
		},
	};
}
