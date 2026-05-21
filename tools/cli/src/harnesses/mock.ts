import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Harness } from "./types.js";

export interface MockHarnessOptions {
	response?: string;
	handler?: (prompt: string) => string | Promise<string>;
}

export const MOCK_COMPILE_MANIFEST_FIXTURE_ENV = "PROSE_MOCK_COMPILE_MANIFEST_FIXTURE";
export const MOCK_COMPILE_OUTPUT_ENV = "PROSE_MOCK_COMPILE_OUTPUT";

export function createMockHarness(options: MockHarnessOptions = {}): Harness {
	return {
		name: "mock",
		async run(prompt, runOptions) {
			await maybeWriteCompileFixture(prompt, runOptions);
			const text = options.handler ? await options.handler(prompt) : (options.response ?? prompt);
			if (text) {
				runOptions.stdout.write(text);
				if (!text.endsWith("\n")) {
					runOptions.stdout.write("\n");
				}
			}
			return 0;
		},
	};
}

async function maybeWriteCompileFixture(prompt: string, runOptions: Parameters<Harness["run"]>[1]): Promise<void> {
	const fixturePath = runOptions.env?.[MOCK_COMPILE_MANIFEST_FIXTURE_ENV];
	if (fixturePath === undefined || !prompt.startsWith("prose compile")) {
		return;
	}

	const outputPath = runOptions.env?.[MOCK_COMPILE_OUTPUT_ENV] ?? "dist/manifest.next.json";
	const absoluteOutputPath = resolve(runOptions.cwd ?? process.cwd(), outputPath);
	await mkdir(dirname(absoluteOutputPath), { recursive: true });
	await copyFile(fixturePath, absoluteOutputPath);
}
