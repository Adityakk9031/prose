import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	ACTIVE_REPOSITORY_IR_PATH,
	REPOSITORY_SERVE_LOCAL_REACTOR_MODEL,
	REPOSITORY_SERVE_LOCAL_REACTOR_PROVIDER,
	REPOSITORY_SERVE_LOCAL_REACTOR_STATUS_ENV,
	createLocalRepositoryServeReactorOptions,
	startRepositoryServeDaemon,
	type RepositoryServeTimerScheduler,
} from "../../src/prose/index.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const stargazerFixture = join(repoRoot, "tests/open-prose/compiler/expected/stargazer.manifest.next.json");
const responsibilityId = "067NC4KG01RG50R40M30E20918";

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

describe("repository serve Reactor adapters", () => {
	it("let the live daemon run through local Reactor adapters without judge status files", async () => {
		const temp = mkdtempSync(join(tmpdir(), "prose-serve-local-reactor-"));
		const io = memoryStreams();
		let current = new Date(2026, 0, 1, 5, 59, 30);
		const scheduled: Array<{ callback: () => void | Promise<void>; delayMs: number }> = [];
		const scheduler: RepositoryServeTimerScheduler = {
			setTimeout(callback, delayMs) {
				scheduled.push({ callback, delayMs });
				return { cancel() {} };
			},
		};
		const calls: string[] = [];

		try {
			writeActiveManifest(temp);
			const daemon = await startRepositoryServeDaemon({
				cwd: temp,
				env: { [REPOSITORY_SERVE_LOCAL_REACTOR_STATUS_ENV]: "down" },
				host: "127.0.0.1",
				port: 0,
				now: () => current,
				reactor: createLocalRepositoryServeReactorOptions({
					env: { [REPOSITORY_SERVE_LOCAL_REACTOR_STATUS_ENV]: "down" },
					now: () => current.toISOString(),
				}),
				stdout: io.streams.stdout,
				stderr: io.streams.stderr,
				timerScheduler: scheduler,
				commandRunner: async (options) => {
					calls.push(options.env.PROSE_ACTIVATION_ID ?? "");
					return 0;
				},
			});

			try {
				current = new Date(2026, 0, 1, 6, 0, 0);
				await scheduled[0]!.callback();
				expect(calls).toEqual(["high-intent-stargazer-outreach.fulfillment"]);
				const receipts = JSON.parse(
					readFileSync(join(temp, `state/reactor/${responsibilityId}/receipts.json`), "utf8"),
				) as Array<{
					cost: { provider: string; model: string; surprise_cause: string; tokens: { fresh: number; reused: number } };
					verdict: { status: string };
				}>;
				expect(receipts).toHaveLength(1);
				expect(receipts[0]?.verdict.status).toBe("down");
				expect(receipts[0]?.cost.provider).toBe(REPOSITORY_SERVE_LOCAL_REACTOR_PROVIDER);
				expect(receipts[0]?.cost.model).toBe(REPOSITORY_SERVE_LOCAL_REACTOR_MODEL);
				expect(receipts[0]?.cost.surprise_cause).toBe("real-input");
				expect(receipts[0]?.cost.tokens.fresh).toBeGreaterThan(0);
				expect(receipts[0]?.cost.tokens.reused).toBe(0);
				expect(() => readFileSync(join(temp, `state/responsibilities/${responsibilityId}/latest.json`), "utf8")).toThrow();
			} finally {
				await daemon.stop();
			}
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
