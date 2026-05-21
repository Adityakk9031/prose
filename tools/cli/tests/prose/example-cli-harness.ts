import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RepositoryIrV0 } from "../../src/prose/index.js";
import { ACTIVE_REPOSITORY_IR_PATH, NEXT_REPOSITORY_IR_PATH } from "../../src/prose/index.js";

export const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
export const cliRoot = join(repoRoot, "tools/cli");
export const builtCliEntry = join(cliRoot, "dist/index.js");
const buildLockPath = join(
	tmpdir(),
	`openprose-cli-build-${createHash("sha1").update(cliRoot).digest("hex")}.lock`,
);

let builtCliReady = false;

export interface CliRunResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

export interface SpawnedCli {
	process: ChildProcess;
	closed: Promise<CliRunResult>;
	readonly stdout: string;
	readonly stderr: string;
}

export function copyExampleToTemp(slug: string, prefix = `prose-${slug}-shell-`): string {
	const temp = mkdtempSync(join(tmpdir(), prefix));
	cpSync(join(repoRoot, "skills/open-prose/examples", slug), temp, { recursive: true });
	return temp;
}

export function cleanupTemp(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

export function ensureBuiltCli(): void {
	if (builtCliReady && existsSync(builtCliEntry)) {
		return;
	}
	withBuildLock(() => {
		if (!existsSync(builtCliEntry)) {
			execFileSync("npm", ["run", "build"], { cwd: cliRoot, stdio: "pipe" });
		}
		builtCliReady = true;
	});
}

export function promoteNextManifest(root: string): void {
	copyFileSync(join(root, NEXT_REPOSITORY_IR_PATH), join(root, ACTIVE_REPOSITORY_IR_PATH));
}

export function readRepositoryIr(path: string): RepositoryIrV0 {
	return JSON.parse(readFileSync(path, "utf8")) as RepositoryIrV0;
}

export function findFulfillmentArtifactPaths(root: string): string[] {
	const runsPath = join(root, "runs");
	if (!existsSync(runsPath)) {
		return [];
	}

	return readdirSync(runsPath, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(runsPath, entry.name, "fulfillment-artifact.json"))
		.filter((artifactPath) => existsSync(artifactPath));
}

export function readSingleFulfillmentArtifact(root: string): Record<string, unknown> {
	const artifactPaths = findFulfillmentArtifactPaths(root);
	if (artifactPaths.length !== 1 || artifactPaths[0] === undefined) {
		throw new Error(`Expected exactly one fulfillment artifact, found ${artifactPaths.length}.`);
	}
	return JSON.parse(readFileSync(artifactPaths[0], "utf8")) as Record<string, unknown>;
}

export function runCli(
	args: readonly string[],
	options: { cwd: string; env?: Readonly<Record<string, string | undefined>> },
): Promise<CliRunResult> {
	const child = spawnCli(args, options);
	return child.closed;
}

export function spawnCli(
	args: readonly string[],
	options: { cwd: string; env?: Readonly<Record<string, string | undefined>> },
): SpawnedCli {
	let stdout = "";
	let stderr = "";
	const child = spawn(process.execPath, [builtCliEntry, ...args], {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => void (stdout += chunk));
	child.stderr.on("data", (chunk: string) => void (stderr += chunk));
	const closed = new Promise<CliRunResult>((resolve) => {
		child.on("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
	});

	return {
		process: child,
		closed,
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
	};
}

export async function stopCli(cli: SpawnedCli): Promise<CliRunResult> {
	if (cli.process.exitCode === null && cli.process.signalCode === null) {
		cli.process.kill("SIGTERM");
	}
	const result = await cli.closed;
	if (result.exitCode !== 0 && result.signal !== "SIGTERM" && !result.stderr.includes("SIGTERM")) {
		throw new Error(`CLI process exited with ${String(result.exitCode)}.\n${result.stderr}`);
	}
	return result;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("Timed out waiting for condition.");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

export async function waitForMatch(read: () => string, pattern: RegExp, timeoutMs = 3_000): Promise<string> {
	let match: RegExpMatchArray | null = null;
	await waitFor(() => {
		match = read().match(pattern);
		return match !== null;
	}, timeoutMs);
	return match?.[1] ?? "";
}

export function readRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

export function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withBuildLock(action: () => void): void {
	const fd = acquireBuildLock();
	try {
		action();
	} finally {
		closeSync(fd);
		try {
			unlinkSync(buildLockPath);
		} catch (error) {
			const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
			if (code !== "ENOENT") {
				throw error;
			}
		}
	}
}

function acquireBuildLock(): number {
	const startedAt = Date.now();
	while (true) {
		try {
			return openSync(buildLockPath, "wx");
		} catch (error) {
			const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
			if (code !== "EEXIST") {
				throw error;
			}
			if (Date.now() - startedAt > 120_000) {
				throw new Error(`Timed out waiting for CLI build lock: ${buildLockPath}`);
			}
			sleepSync(50);
		}
	}
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
