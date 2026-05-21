import { Command } from "@oclif/core";
import {
	formatRepositoryStatus,
	loadRepositoryStatus,
	RepositoryStatusError,
} from "../prose/index.js";
import {
	DEFAULT_REPOSITORY_STATUS_PROJECTION_TIER,
	REPOSITORY_STATUS_PROJECTION_TIERS,
	type RepositoryStatusProjectionTier,
} from "../prose/repository-status.js";

export default class Status extends Command {
	static summary = "Show OpenProse repository status.";
	static usage = "status [--tier owner|subscriber|public]";
	static strict = false;

	async run(): Promise<void> {
		try {
			const args = parseStatusArgs(this.argv);
			const status = await loadRepositoryStatus({ cwd: process.cwd(), tier: args.tier });
			this.log(formatRepositoryStatus(status));
		} catch (error) {
			if (error instanceof RepositoryStatusError) {
				const details = error.details.length === 0 ? "" : `\n${error.details.map((detail) => `- ${detail}`).join("\n")}`;
				this.error(`${error.message}${details}`, { exit: 1 });
			}
			const message = error instanceof Error ? error.message : String(error);
			this.error(message, { exit: 1 });
		}
	}
}

export interface StatusArgs {
	tier: RepositoryStatusProjectionTier;
}

export function parseStatusArgs(argv: readonly string[]): StatusArgs {
	let tier: RepositoryStatusProjectionTier = DEFAULT_REPOSITORY_STATUS_PROJECTION_TIER;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === undefined) {
			continue;
		}
		if (arg === "--tier") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("-")) {
				throw new RepositoryStatusError("Missing value for --tier.", [statusUsage()]);
			}
			tier = parseProjectionTier(value);
			index += 1;
			continue;
		}
		if (arg.startsWith("--tier=")) {
			tier = parseProjectionTier(arg.slice("--tier=".length));
			continue;
		}

		throw new RepositoryStatusError(`Unexpected argument '${arg}' for 'prose status'.`, [statusUsage()]);
	}

	return { tier };
}

function parseProjectionTier(value: string): RepositoryStatusProjectionTier {
	if (REPOSITORY_STATUS_PROJECTION_TIERS.some((tier) => tier === value)) {
		return value as RepositoryStatusProjectionTier;
	}

	throw new RepositoryStatusError(`Unsupported status projection tier '${value}'.`, [
		`--tier must be one of: ${REPOSITORY_STATUS_PROJECTION_TIERS.join(", ")}`,
	]);
}

function statusUsage(): string {
	return "Usage: prose status [--tier owner|subscriber|public]";
}
