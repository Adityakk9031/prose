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
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const EXPECTED_REACTOR_PACKAGE_NAME = '@openprose/reactor';
const EXPECTED_CRADLE_PACKAGE_NAME = '@openprose/reactor-cradle';
const EXPECTED_EXAMPLE_SCHEMA =
  'openprose.reactor.example.release-readiness';
const EXPECTED_EXAMPLE_VERSION = 0;
const EXPECTED_EXAMPLE_ID = 'reactor-release-readiness';
const DEFAULT_EXAMPLE_DIR = 'skills/open-prose/examples/release-readiness/reactor-package-example';
const EXAMPLE_SCRIPT_NAME = 'release-readiness.example.mjs';
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
        'Usage: smoke-reactor-release-readiness-example.mjs --reactorTarball <reactor.tgz> --cradleTarball <cradle.tgz> [--exampleDir skills/open-prose/examples/release-readiness/reactor-package-example]',
        '',
        'Installs packed @openprose/reactor and @openprose/reactor-cradle',
        'artifacts into a temporary offline consumer, runs the release',
        'readiness example there, and validates its deterministic JSON output.',
      ].join('\n'),
    );
    return;
  }

  const result = await smokeReactorReleaseReadinessExample({
    cradleTarballPath: required(args, 'cradleTarball'),
    exampleDir: args.exampleDir ?? DEFAULT_EXAMPLE_DIR,
    reactorTarballPath: required(args, 'reactorTarball'),
  });

  console.log(
    `Reactor release-readiness example smoke verified: ${result.example_id}; ${result.overall_status}; ${result.metrics.case_count} cases; ${result.metrics.replay_parity_ready_rows_run} ready parity rows and ${result.metrics.replay_parity_future_rows} future rows.`,
  );
}

export async function smokeReactorReleaseReadinessExample({
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

  const sourceExamplePath = resolve(exampleDir, EXAMPLE_SCRIPT_NAME);
  await assertFile(sourceExamplePath, 'Release-readiness example script');

  const tempRoot = await mkdtemp(join(tmpdir(), 'openprose-reactor-example-'));
  try {
    const consumerRoot = join(tempRoot, 'consumer');
    const packageScopeRoot = join(consumerRoot, 'node_modules', '@openprose');
    const installedReactorRoot = join(packageScopeRoot, 'reactor');
    const installedCradleRoot = join(packageScopeRoot, 'reactor-cradle');
    const consumerExampleRoot = join(consumerRoot, 'example');
    const consumerExamplePath = join(consumerExampleRoot, EXAMPLE_SCRIPT_NAME);

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
    await mkdir(consumerExampleRoot, { recursive: true });
    await cp(sourceExamplePath, consumerExamplePath);
    await writeFile(
      join(consumerRoot, 'package.json'),
      `${JSON.stringify(
        {
          name: 'openprose-reactor-release-readiness-example-consumer',
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

    const { stdout } = await runExample(execFileImpl, consumerExamplePath, {
      consumerRoot,
    });
    const output = parseExampleOutput(stdout);

    return {
      ...output,
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

async function runExample(execFileImpl, examplePath, { consumerRoot }) {
  try {
    return await execFileImpl(process.execPath, [examplePath], {
      cwd: consumerRoot,
      env: {
        ...process.env,
        npm_config_offline: 'true',
        pnpm_config_offline: 'true',
        YARN_ENABLE_NETWORK: '0',
      },
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
    const detail = [stderr, stdout, error instanceof Error ? error.message : String(error)]
      .filter(Boolean)
      .join('\n');
    throw new Error(`Release-readiness example smoke failed:\n${detail}`);
  }
}

function parseExampleOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Release-readiness example did not print valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  assertRecord(parsed, 'example output');
  assertEqual(parsed.schema, EXPECTED_EXAMPLE_SCHEMA, 'schema');
  assertEqual(parsed.v, EXPECTED_EXAMPLE_VERSION, 'v');
  assertEqual(parsed.example_id, EXPECTED_EXAMPLE_ID, 'example_id');
  assertEqual(parsed.overall_status, 'pass', 'overall_status');
  assertEqual(parsed.model_matrix_status, 'not-run', 'model_matrix_status');
  assertPackageImports(parsed.package_imports);

  const metrics = recordField(parsed, 'metrics');
  assertPositiveInteger(metrics.case_count, 'metrics.case_count');
  assertPositiveInteger(metrics.case_pass_count, 'metrics.case_pass_count');
  assertPositiveInteger(metrics.assertion_count, 'metrics.assertion_count');
  assertPositiveInteger(
    metrics.assertion_pass_count,
    'metrics.assertion_pass_count',
  );
  assertEqual(
    metrics.replay_parity_ready_rows_run,
    2,
    'metrics.replay_parity_ready_rows_run',
  );
  assertEqual(
    metrics.replay_parity_future_rows,
    1,
    'metrics.replay_parity_future_rows',
  );

  const releaseParity = recordField(parsed, 'release_parity');
  assertContentHash(
    releaseParity.eval_content_hash,
    'release_parity.eval_content_hash',
  );
  assertContentHash(
    releaseParity.public_projection_content_hash,
    'release_parity.public_projection_content_hash',
  );
  assertEqual(
    releaseParity.public_projection_source_hash,
    releaseParity.eval_content_hash,
    'release_parity.public_projection_source_hash',
  );

  const sampledReceipt = recordField(parsed, 'sampled_receipt');
  assertContentHash(sampledReceipt.content_hash, 'sampled_receipt.content_hash');
  assertEqual(sampledReceipt.proof_ok, true, 'sampled_receipt.proof_ok');
  assertEqual(
    sampledReceipt.public_projection_tier,
    'public',
    'sampled_receipt.public_projection_tier',
  );
  assertContentHash(
    sampledReceipt.public_projection_content_hash,
    'sampled_receipt.public_projection_content_hash',
  );

  const reports = recordField(parsed, 'reports');
  assertContentHash(reports.eval_markdown_sha256, 'reports.eval_markdown_sha256');
  assertPositiveInteger(
    reports.eval_markdown_bytes,
    'reports.eval_markdown_bytes',
  );
  assertContentHash(
    reports.projection_markdown_sha256,
    'reports.projection_markdown_sha256',
  );
  assertPositiveInteger(
    reports.projection_markdown_bytes,
    'reports.projection_markdown_bytes',
  );

  const deferredRows = arrayField(parsed, 'deferred_rows');
  if (
    !deferredRows.some(
      (item) =>
        isRecord(item) &&
        item.row_id === 'down-after-budget-exhaustion' &&
        item.represented === false,
    )
  ) {
    throw new Error(
      'deferred_rows must include down-after-budget-exhaustion represented=false',
    );
  }

  const serialized = JSON.stringify(parsed);
  if (/raw[_ -]?replay[_ -]?bytes|trace|judge[_ -]?rationale/i.test(serialized)) {
    throw new Error('example output includes raw trace, replay bytes, or rationale text');
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
    const detail = [stderr, stdout, error instanceof Error ? error.message : String(error)]
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

function assertPackageImports(value) {
  const expected = [
    '@openprose/reactor-cradle/release-parity',
    '@openprose/reactor-cradle/eval',
    '@openprose/reactor/receipt',
    '@openprose/reactor/projection',
  ];
  if (!Array.isArray(value) || value.join('\n') !== expected.join('\n')) {
    throw new Error('package_imports does not match expected public imports.');
  }
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
