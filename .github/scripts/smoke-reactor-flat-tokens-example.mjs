#!/usr/bin/env node

import { execFile } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const EXPECTED_REACTOR_PACKAGE_NAME = '@openprose/reactor';
const EXPECTED_CRADLE_PACKAGE_NAME = '@openprose/reactor-cradle';
const EXPECTED_EXAMPLE_SCHEMA = 'openprose.reactor.example.flat-tokens';
const EXPECTED_EXAMPLE_VERSION = 0;
const EXPECTED_EXAMPLE_ID = 'reactor-flat-tokens';
const DEFAULT_EXAMPLE_DIR = 'skills/open-prose/examples/flat-tokens';
const EXAMPLE_SCRIPT_NAME = 'flat-tokens.example.mjs';
const CONTENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const execFileAsync = promisify(execFile);

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        'Usage: smoke-reactor-flat-tokens-example.mjs --reactorTarball <reactor.tgz> --cradleTarball <cradle.tgz> [--exampleDir skills/open-prose/examples/flat-tokens]',
        '',
        'Installs packed @openprose/reactor and @openprose/reactor-cradle',
        'artifacts into a temporary offline consumer, runs npm run example',
        'for the flat-tokens example, and validates its receipt token output.',
      ].join('\n'),
    );
    return;
  }

  const result = await smokeReactorFlatTokensExample({
    cradleTarballPath: required(args, 'cradleTarball'),
    exampleDir: args.exampleDir ?? DEFAULT_EXAMPLE_DIR,
    reactorTarballPath: required(args, 'reactorTarball'),
  });

  console.log(
    `Reactor flat-tokens example smoke verified: ${result.example_id}; tokens.fresh=${result.tokens.fresh}; tokens.reused=${result.tokens.reused}; ratio=${result.tokens.ratio}; receipts=${result.runtime.receipt_count}.`,
  );
}

export async function smokeReactorFlatTokensExample({
  cradleTarballPath,
  exampleDir = DEFAULT_EXAMPLE_DIR,
  execFileImpl = execFileAsync,
  reactorTarballPath,
} = {}) {
  if (!reactorTarballPath) {
    throw new Error('Missing required --reactorTarball.');
  }
  if (!cradleTarballPath) {
    throw new Error('Missing required --cradleTarball.');
  }

  const sourceExampleRoot = resolve(exampleDir);
  const sourceExamplePath = join(sourceExampleRoot, EXAMPLE_SCRIPT_NAME);
  await assertDirectory(sourceExampleRoot, 'Flat-tokens example directory');
  await assertFile(sourceExamplePath, 'Flat-tokens example script');

  const tempRoot = await mkdtemp(join(tmpdir(), 'openprose-reactor-flat-tokens-'));
  try {
    const consumerRoot = join(tempRoot, 'consumer');
    const packageScopeRoot = join(consumerRoot, 'node_modules', '@openprose');
    const installedReactorRoot = join(packageScopeRoot, 'reactor');
    const installedCradleRoot = join(packageScopeRoot, 'reactor-cradle');
    const consumerExampleRoot = join(consumerRoot, 'example');

    const reactorPackage = await extractPackageTarball({
      execFileImpl,
      expectedName: EXPECTED_REACTOR_PACKAGE_NAME,
      label: 'Reactor package',
      tarballPath: reactorTarballPath,
      tempRoot,
      targetDirName: 'reactor-extract',
    });
    const cradlePackage = await extractPackageTarball({
      execFileImpl,
      expectedName: EXPECTED_CRADLE_PACKAGE_NAME,
      label: 'Cradle package',
      tarballPath: cradleTarballPath,
      tempRoot,
      targetDirName: 'cradle-extract',
    });

    const cradleDependency = reactorDependencyField(
      cradlePackage.packageJson,
      cradlePackage.packageJsonPath,
    );
    if (!reactorDependencyMatches(cradleDependency, reactorPackage.version)) {
      throw new Error(
        `${cradlePackage.packageJsonPath} depends on ${EXPECTED_REACTOR_PACKAGE_NAME} as ${cradleDependency}; expected ${reactorPackage.version} for the packed Reactor artifact.`,
      );
    }

    await mkdir(packageScopeRoot, { recursive: true });
    await cp(reactorPackage.packageRoot, installedReactorRoot, {
      force: true,
      recursive: true,
    });
    await cp(cradlePackage.packageRoot, installedCradleRoot, {
      force: true,
      recursive: true,
    });
    await cp(sourceExampleRoot, consumerExampleRoot, {
      force: true,
      recursive: true,
    });
    await writeFile(
      join(consumerRoot, 'package.json'),
      `${JSON.stringify(
        {
          name: 'openprose-reactor-flat-tokens-example-consumer',
          private: true,
          type: 'module',
          dependencies: {
            [EXPECTED_REACTOR_PACKAGE_NAME]: reactorPackage.version,
            [EXPECTED_CRADLE_PACKAGE_NAME]: cradlePackage.version,
          },
        },
        null,
        2,
      )}\n`,
    );

    const startedAt = process.hrtime.bigint();
    const { stdout } = await runExample(execFileImpl, consumerExampleRoot);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const output = parseFlatTokensExampleOutput(stdout);
    if (elapsedMs > 60_000) {
      throw new Error(
        `Flat-tokens example exceeded 60s local budget: ${elapsedMs.toFixed(0)}ms`,
      );
    }

    return {
      ...output,
      elapsed_ms: elapsedMs,
      cradlePackage: {
        name: cradlePackage.name,
        version: cradlePackage.version,
      },
      reactorPackage: {
        name: reactorPackage.name,
        version: reactorPackage.version,
      },
    };
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

async function runExample(execFileImpl, exampleRoot) {
  try {
    return await execFileImpl('npm', ['run', 'example', '--silent'], {
      cwd: exampleRoot,
      env: {
        ...process.env,
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_offline: 'true',
        pnpm_config_offline: 'true',
        YARN_ENABLE_NETWORK: '0',
      },
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
    const detail = [
      stderr,
      stdout,
      error instanceof Error ? error.message : String(error),
    ]
      .filter(Boolean)
      .join('\n');
    throw new Error(`Flat-tokens example smoke failed:\n${detail}`);
  }
}

export function parseFlatTokensExampleOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Flat-tokens example did not print valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  assertRecord(parsed, 'example output');
  assertEqual(parsed.schema, EXPECTED_EXAMPLE_SCHEMA, 'schema');
  assertEqual(parsed.v, EXPECTED_EXAMPLE_VERSION, 'v');
  assertEqual(parsed.example_id, EXPECTED_EXAMPLE_ID, 'example_id');
  assertEqual(parsed.scenario_id, 'incident-briefing-static-zero', 'scenario_id');
  assertEqual(parsed.world_profile, 'static', 'world_profile');
  assertEqual(parsed.overall_status, 'pass', 'overall_status');
  assertPackageImports(parsed.package_imports);

  const runtime = recordField(parsed, 'runtime');
  assertEqual(
    runtime.create_reactor_ingest_path,
    true,
    'runtime.create_reactor_ingest_path',
  );
  assertEqual(
    runtime.offline_replay_model_gateway,
    true,
    'runtime.offline_replay_model_gateway',
  );
  assertEqual(runtime.network_calls, 0, 'runtime.network_calls');
  assertEqual(runtime.receipt_count, 4, 'runtime.receipt_count');
  assertEqual(
    runtime.token_bearing_receipt_count,
    4,
    'runtime.token_bearing_receipt_count',
  );
  assertEqual(
    runtime.model_invocation_count,
    2,
    'runtime.model_invocation_count',
  );

  const tokens = recordField(parsed, 'tokens');
  assertEqual(tokens.fresh, 46, 'tokens.fresh');
  assertEqual(tokens.reused, 46, 'tokens.reused');
  assertEqual(tokens.ratio, '46:46', 'tokens.ratio');
  assertEqual(tokens.reused_to_fresh_ratio, 1, 'tokens.reused_to_fresh_ratio');

  const relationships = recordField(parsed, 'relationships');
  assertRelationshipOk(
    recordField(relationships, 'surprise_attribution_complete'),
    'relationships.surprise_attribution_complete',
  );
  assertRelationshipOk(
    recordField(relationships, 'flat_spend_under_static'),
    'relationships.flat_spend_under_static',
  );

  const receipts = arrayField(parsed, 'receipts');
  assertEqual(receipts.length, 4, 'receipts.length');
  assertReceiptRows(receipts);

  const serialized = JSON.stringify(parsed);
  if (/raw[_ -]?replay[_ -]?bytes|judge[_ -]?rationale|secret|api[_ -]?key/i.test(serialized)) {
    throw new Error(
      'example output includes raw replay bytes, rationale text, or secret-shaped fields',
    );
  }

  return parsed;
}

async function extractPackageTarball({
  execFileImpl,
  expectedName,
  label,
  tarballPath,
  tempRoot,
  targetDirName,
}) {
  const extractDir = join(tempRoot, targetDirName);
  await mkdir(extractDir, { recursive: true });

  try {
    await execFileImpl('tar', ['-xzf', resolve(tarballPath), '-C', extractDir], {
      cwd: tempRoot,
    });
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
    const detail = [
      stderr,
      stdout,
      error instanceof Error ? error.message : String(error),
    ]
      .filter(Boolean)
      .join('\n');
    throw new Error(`${label} tarball extraction failed:\n${detail}`);
  }

  const packageRoot = join(extractDir, 'package');
  await assertDirectory(packageRoot, `${label} tarball root`);

  const packageJsonPath = join(packageRoot, 'package.json');
  const packageJson = await readJson(packageJsonPath);
  const name = stringField(packageJson, 'name', packageJsonPath);
  const version = stringField(packageJson, 'version', packageJsonPath);

  if (name !== expectedName) {
    throw new Error(
      `${packageJsonPath} package name is ${name}; expected ${expectedName}.`,
    );
  }

  return {
    name,
    packageJson,
    packageJsonPath,
    packageRoot,
    version,
  };
}

function assertReceiptRows(receipts) {
  const expected = [
    {
      as_of: '2026-05-18T12:00:00.000Z',
      event_cause: 'real-input',
      recheck_kind: null,
      outcome: 'model-invocation',
      fresh: 41,
      reused: 0,
    },
    {
      as_of: '2026-05-18T12:15:00.000Z',
      event_cause: 'forecast-recheck',
      recheck_kind: 'evidence-age',
      outcome: 'memo-hit',
      fresh: 0,
      reused: 41,
    },
    {
      as_of: '2026-05-18T18:00:00.000Z',
      event_cause: 'forecast-recheck',
      recheck_kind: 'plan-age',
      outcome: 'model-invocation',
      fresh: 5,
      reused: 0,
    },
    {
      as_of: '2026-05-19T12:00:00.000Z',
      event_cause: 'forecast-recheck',
      recheck_kind: 'evidence-age',
      outcome: 'memo-hit',
      fresh: 0,
      reused: 5,
    },
  ];

  receipts.forEach((receipt, index) => {
    assertRecord(receipt, `receipts[${index}]`);
    assertEqual(receipt.index, index, `receipts[${index}].index`);
    assertContentHash(receipt.content_hash, `receipts[${index}].content_hash`);
    assertEqual(receipt.as_of, expected[index].as_of, `receipts[${index}].as_of`);
    assertEqual(
      receipt.event_cause,
      expected[index].event_cause,
      `receipts[${index}].event_cause`,
    );
    assertEqual(
      receipt.recheck_kind,
      expected[index].recheck_kind,
      `receipts[${index}].recheck_kind`,
    );
    assertEqual(
      receipt.outcome,
      expected[index].outcome,
      `receipts[${index}].outcome`,
    );
    const tokens = recordField(receipt, 'tokens');
    assertEqual(tokens.fresh, expected[index].fresh, `receipts[${index}].tokens.fresh`);
    assertEqual(tokens.reused, expected[index].reused, `receipts[${index}].tokens.reused`);
  });
}

function reactorDependencyField(packageJson, packageJsonPath) {
  const dependency = packageJson?.dependencies?.[EXPECTED_REACTOR_PACKAGE_NAME];
  if (typeof dependency !== 'string' || dependency.trim() === '') {
    throw new Error(
      `${packageJsonPath} is missing dependency ${EXPECTED_REACTOR_PACKAGE_NAME}.`,
    );
  }
  return dependency;
}

function reactorDependencyMatches(dependency, reactorVersion) {
  return dependency === reactorVersion || dependency === `workspace:${reactorVersion}`;
}

async function assertDirectory(path, label) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    throw new Error(
      `${label} is missing at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!info.isDirectory()) {
    throw new Error(`${label} at ${path} is not a directory.`);
  }
}

async function assertFile(path, label) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    throw new Error(
      `${label} is missing at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!info.isFile()) {
    throw new Error(`${label} at ${path} is not a file.`);
  }
}

async function readJson(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Could not read ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Could not parse ${path} as JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument ${arg}.`);
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}.`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function required(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required --${key}.`);
  }
  return value;
}

function stringField(value, field, label) {
  const fieldValue = value?.[field];
  if (typeof fieldValue !== 'string' || fieldValue.trim() === '') {
    throw new Error(`${label} field ${field} must be a non-empty string.`);
  }
  return fieldValue;
}

function assertPackageImports(value) {
  const expected = [
    '@openprose/reactor/sdk',
    '@openprose/reactor/receipt',
    '@openprose/reactor/cost',
    '@openprose/reactor-cradle/doubles/clock',
    '@openprose/reactor-cradle/replay/model-gateway',
    '@openprose/reactor-cradle/world',
  ];
  if (!Array.isArray(value) || value.join('\n') !== expected.join('\n')) {
    throw new Error('package_imports does not match expected public imports.');
  }
}

function assertRelationshipOk(value, label) {
  assertEqual(value.ok, true, `${label}.ok`);
  const checked = recordField(value, 'checked');
  assertPositiveInteger(checked.receipts, `${label}.checked.receipts`);
  assertPositiveInteger(
    checked.token_bearing_receipts,
    `${label}.checked.token_bearing_receipts`,
  );
}

function assertRecord(value, label) {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function recordField(value, field) {
  const fieldValue = value?.[field];
  assertRecord(fieldValue, field);
  return fieldValue;
}

function arrayField(value, field) {
  const fieldValue = value?.[field];
  if (!Array.isArray(fieldValue)) {
    throw new Error(`${field} must be an array.`);
  }
  return fieldValue;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} is ${String(actual)}; expected ${String(expected)}.`);
  }
}

function assertContentHash(value, label) {
  if (typeof value !== 'string' || !CONTENT_HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a sha256 content hash.`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMainModule() {
  return process.argv[1] === new URL(import.meta.url).pathname;
}
