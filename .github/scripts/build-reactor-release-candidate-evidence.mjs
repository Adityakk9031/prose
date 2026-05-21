#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import { verifyReactorPin } from './verify-reactor-pin.mjs';
import { smokeReactorTarballImport } from './smoke-reactor-tarball-import.mjs';
import {
  smokeReactorCradleTarballImport,
} from './smoke-reactor-cradle-tarball-import.mjs';
import {
  smokeReactorReleaseReadinessExample,
} from './smoke-reactor-release-readiness-example.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const require = createRequire(import.meta.url);

const releaseCandidate = loadCradleDistModule('release-candidate');
const releaseParity = loadCradleDistModule('release-parity');
const evalModule = loadCradleDistModule('eval');

export const RELEASE_CANDIDATE_REACTOR_PUBLIC_IMPORT_SPECIFIERS = Object.freeze([
  ...releaseCandidate.R7_REACTOR_PUBLIC_IMPORT_SPECIFIERS_V0,
]);
export const RELEASE_CANDIDATE_CRADLE_PUBLIC_IMPORT_SPECIFIERS = Object.freeze([
  ...releaseCandidate.R7_CRADLE_PUBLIC_IMPORT_SPECIFIERS_V0,
]);

export const DEFAULT_RELEASE_CANDIDATE_DEFERRED_ROWS = Object.freeze([
  Object.freeze({
    row_id: 'down-after-budget-exhaustion',
    status: 'deferred',
    represented: false,
    reason: 'Typed retry budget and pressure dispatch primitives are not present yet',
  }),
  Object.freeze({
    row_id: 'postgres-parity',
    status: 'future',
    represented: false,
    reason: 'Postgres adapter row is explicit future work',
  }),
  Object.freeze({
    row_id: 'live-provider-model-matrix',
    status: 'not-run',
    represented: false,
    reason: 'Live provider and model matrix was not run for this local candidate',
  }),
]);

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
        'Usage: build-reactor-release-candidate-evidence.mjs --reactorTarball <reactor.tgz> --cradleTarball <cradle.tgz> --branch <branch> --commit <sha> --worktreeStatus clean --generatedAt <iso> --asOf <iso> --releaseCandidateId <id> --verifierSmokeTests <passed/total> --exampleSmokeTests <passed/total> --reactorTests <passed/total> --cradleTests <passed/total> --diffCheck pass --dependencyScan pass --secretScan pass [--exampleDir skills/open-prose/examples/release-readiness/reactor-package-example] [--outDir <dir>]',
        '',
        'Builds a local release-candidate evidence bundle and Markdown report',
        'from explicit observed command evidence plus local package verifier',
        'and import-smoke checks.',
      ].join('\n'),
    );
    return;
  }

  const result = await buildReactorReleaseCandidateEvidence({
    asOf: required(args, 'asOf'),
    branch: required(args, 'branch'),
    commit: required(args, 'commit'),
    cradleTarballPath: required(args, 'cradleTarball'),
    generatedAt: required(args, 'generatedAt'),
    hygieneEvidence: {
      dependencyScan: required(args, 'dependencyScan'),
      diffCheck: required(args, 'diffCheck'),
      secretScan: required(args, 'secretScan'),
    },
    exampleDir: args.exampleDir,
    outDir: args.outDir,
    reactorTarballPath: required(args, 'reactorTarball'),
    releaseCandidateId: required(args, 'releaseCandidateId'),
    testEvidence: {
      cradleTests: parseTestCount(required(args, 'cradleTests'), 'cradleTests'),
      exampleSmokeTests: parseTestCount(
        required(args, 'exampleSmokeTests'),
        'exampleSmokeTests',
      ),
      reactorTests: parseTestCount(required(args, 'reactorTests'), 'reactorTests'),
      verifierSmokeTests: parseTestCount(
        required(args, 'verifierSmokeTests'),
        'verifierSmokeTests',
      ),
    },
    worktreeStatus: args.worktreeStatus ?? 'clean',
  });

  if (result.outputPaths) {
    console.log(
      [
        `Release candidate evidence bundle: ${result.outputPaths.bundleJson}`,
        `Release candidate evidence report: ${result.outputPaths.reportMarkdown}`,
        `Bundle hash: ${result.bundle.content_hash}`,
      ].join('\n'),
    );
    return;
  }

  process.stdout.write(result.reportMarkdown);
}

export async function buildReactorReleaseCandidateEvidence({
  asOf,
  branch,
  commit,
  cradleTarballPath,
  exampleDir,
  generatedAt,
  hygieneEvidence,
  outDir,
  reactorTarballPath,
  releaseCandidateId,
  smokeReactorCradleTarballImportImpl = smokeReactorCradleTarballImport,
  smokeReactorReleaseReadinessExampleImpl =
    smokeReactorReleaseReadinessExample,
  smokeReactorTarballImportImpl = smokeReactorTarballImport,
  testEvidence,
  verifyReactorPinImpl = verifyReactorPin,
  worktreeStatus = 'clean',
  writeFileImpl = writeFile,
  mkdirImpl = mkdir,
} = {}) {
  const metadata = normalizeMetadata({
    asOf,
    branch,
    commit,
    cradleTarballPath,
    generatedAt,
    reactorTarballPath,
    releaseCandidateId,
    worktreeStatus,
  });
  const normalizedTestEvidence = normalizeTestEvidence(testEvidence);
  const normalizedHygieneEvidence = normalizeHygieneEvidence(hygieneEvidence);

  const [pin, reactorSmoke, cradleSmoke, exampleSmoke] = await Promise.all([
    verifyReactorPinImpl({
      consumerPackagePath: join(REPO_ROOT, 'packages/reactor-cradle/package.json'),
      packageDir: join(REPO_ROOT, 'packages/reactor'),
      pinPath: join(REPO_ROOT, 'packages/reactor-cradle/.openprose-reactor-pin.json'),
      tarballPath: metadata.reactorTarballPath,
    }),
    smokeReactorTarballImportImpl({
      tarballPath: metadata.reactorTarballPath,
    }),
    smokeReactorCradleTarballImportImpl({
      cradleTarballPath: metadata.cradleTarballPath,
      reactorTarballPath: metadata.reactorTarballPath,
    }),
    smokeReactorReleaseReadinessExampleImpl({
      cradleTarballPath: metadata.cradleTarballPath,
      exampleDir,
      reactorTarballPath: metadata.reactorTarballPath,
    }),
  ]);
  const normalizedExampleSmoke = normalizeExampleSmokeResult(exampleSmoke);

  const releaseParityEvidence = buildReleaseParityEvidence();
  const bundle = releaseCandidate.buildR7ReleaseCandidateEvidenceBundleV0({
    as_of: metadata.asOf,
    build: {
      branch: metadata.branch,
      commit: metadata.commit,
      worktree_status: metadata.worktreeStatus,
    },
    commands: buildCommandSummaries({
      exampleSmoke: normalizedExampleSmoke,
      hygieneEvidence: normalizedHygieneEvidence,
      testEvidence: normalizedTestEvidence,
    }),
    cradle_tarball_smoke: {
      imported_entrypoints: cradleSmoke.imports.map((entry) => entry.specifier),
      package_name: cradleSmoke.cradlePackage.name,
      version: cradleSmoke.cradlePackage.version,
    },
    deferred_rows: DEFAULT_RELEASE_CANDIDATE_DEFERRED_ROWS,
    generated_at: metadata.generatedAt,
    package_pin: {
      checked_files: pin.checkedFiles,
      consumer_dependency: pin.consumerDependency,
      consumer_name: '@openprose/reactor-cradle',
      package_name: pin.packageName,
      package_tree_sha256: pin.packageTreeSha256,
      version: pin.version,
    },
    release_candidate_id: metadata.releaseCandidateId,
    release_parity: releaseParityEvidence,
    tarball_smoke: {
      imported_entrypoints: reactorSmoke.imports.map((entry) => entry.specifier),
      package_name: reactorSmoke.packageName,
      version: reactorSmoke.version,
    },
  });
  const reportMarkdown =
    releaseCandidate.renderR7ReleaseCandidateEvidenceBundleMarkdownV0(bundle);

  if (!outDir) {
    return {
      bundle,
      reportMarkdown,
    };
  }

  const outputDir = resolve(outDir);
  const outputPaths = {
    bundleJson: join(outputDir, 'reactor-release-candidate-evidence.bundle.json'),
    reportMarkdown: join(outputDir, 'reactor-release-candidate-evidence.md'),
  };
  await mkdirImpl(outputDir, { recursive: true });
  await writeFileImpl(
    outputPaths.bundleJson,
    `${JSON.stringify(bundle, null, 2)}\n`,
    'utf8',
  );
  await writeFileImpl(outputPaths.reportMarkdown, reportMarkdown, 'utf8');

  return {
    bundle,
    outputPaths,
    reportMarkdown,
  };
}

export function parseTestCount(value, label) {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be formatted as passed/total.`);
  }
  const match = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) {
    throw new Error(`${label} must be formatted as passed/total.`);
  }
  return normalizeTestCount(
    {
      tests_passed: Number(match[1]),
      tests_total: Number(match[2]),
    },
    label,
  );
}

function buildReleaseParityEvidence() {
  const proof = releaseParity.runRecordedR6ReleaseParityProofV0();
  const evalResult = releaseParity.buildR6ReleaseParityEvalResultV0(proof);
  const publicProjection = evalModule.projectCradleEvalResultV0(evalResult, 'public');

  return {
    eval_report_markdown: evalModule.renderCradleEvalReportMarkdownV0(evalResult),
    eval_result: evalResult,
    proof,
    public_projection: publicProjection,
    public_projection_report_markdown:
      evalModule.renderCradleEvalProjectionReportMarkdownV0(publicProjection),
  };
}

function buildCommandSummaries({ exampleSmoke, hygieneEvidence, testEvidence }) {
  return [
    {
      command_id: 'verifier-smoke-tests',
      status: 'pass',
      summary: 'Verifier and tarball smoke unit tests passed',
      ...testEvidence.verifierSmokeTests,
    },
    {
      command_id: 'reactor-tests',
      status: 'pass',
      summary: 'Reactor package tests passed',
      ...testEvidence.reactorTests,
    },
    {
      command_id: 'cradle-tests',
      status: 'pass',
      summary: 'Cradle package tests passed',
      ...testEvidence.cradleTests,
    },
    {
      command_id: 'local-pack',
      status: 'pass',
      summary: 'Local Reactor and Cradle package packs completed',
    },
    {
      command_id: 'pin-verify',
      status: 'pass',
      summary: 'Reactor package pin verified with checked files present',
    },
    {
      command_id: 'tarball-import-smoke',
      status: 'pass',
      summary: 'Packed Reactor and Cradle public entrypoints imported offline',
    },
    {
      command_id: 'release-readiness-example-smoke',
      status: 'pass',
      summary: `Release-readiness example ${exampleSmoke.example_id} ran from packed artifacts with ${exampleSmoke.metrics.case_count} cases, ${exampleSmoke.metrics.replay_parity_ready_rows_run} ready parity rows, ${exampleSmoke.metrics.replay_parity_future_rows} future row, and live model matrix ${exampleSmoke.model_matrix_status}`,
      ...testEvidence.exampleSmokeTests,
    },
    {
      command_id: 'diff-check',
      status: hygieneEvidence.diffCheck,
      summary: 'Whitespace diff check clean',
    },
    {
      command_id: 'dependency-scan',
      status: hygieneEvidence.dependencyScan,
      summary: 'Reactor package has no Cradle runtime imports',
    },
    {
      command_id: 'secret-scan',
      status: hygieneEvidence.secretScan,
      summary: 'Secret shaped string scan clean',
    },
  ];
}

function normalizeMetadata({
  asOf,
  branch,
  commit,
  cradleTarballPath,
  generatedAt,
  reactorTarballPath,
  releaseCandidateId,
  worktreeStatus,
}) {
  return {
    asOf: requiredString(asOf, 'asOf'),
    branch: requiredString(branch, 'branch'),
    commit: requiredString(commit, 'commit'),
    cradleTarballPath: requiredString(cradleTarballPath, 'cradleTarballPath'),
    generatedAt: requiredString(generatedAt, 'generatedAt'),
    reactorTarballPath: requiredString(reactorTarballPath, 'reactorTarballPath'),
    releaseCandidateId: requiredString(releaseCandidateId, 'releaseCandidateId'),
    worktreeStatus: cleanWorktreeStatus(worktreeStatus),
  };
}

function normalizeTestEvidence(value) {
  if (!isRecord(value)) {
    throw new Error('testEvidence is required.');
  }
  return {
    cradleTests: normalizeTestCount(value.cradleTests, 'testEvidence.cradleTests'),
    exampleSmokeTests: normalizeTestCount(
      value.exampleSmokeTests,
      'testEvidence.exampleSmokeTests',
    ),
    reactorTests: normalizeTestCount(value.reactorTests, 'testEvidence.reactorTests'),
    verifierSmokeTests: normalizeTestCount(
      value.verifierSmokeTests,
      'testEvidence.verifierSmokeTests',
    ),
  };
}

function normalizeExampleSmokeResult(value) {
  if (!isRecord(value)) {
    throw new Error('example smoke result is required.');
  }
  const metrics = value.metrics;
  if (!isRecord(metrics)) {
    throw new Error('example smoke result metrics are required.');
  }
  if (value.example_id !== 'reactor-release-readiness') {
    throw new Error('example smoke result example_id must be reactor-release-readiness.');
  }
  if (value.overall_status !== 'pass') {
    throw new Error('example smoke result overall_status must be pass.');
  }
  if (value.model_matrix_status !== 'not-run') {
    throw new Error('example smoke result model_matrix_status must be not-run.');
  }
  const caseCount = exactInteger(
    metrics.case_count,
    10,
    'example smoke case_count',
  );
  const readyRows = exactInteger(
    metrics.replay_parity_ready_rows_run,
    2,
    'example smoke replay_parity_ready_rows_run',
  );
  const futureRows = exactInteger(
    metrics.replay_parity_future_rows,
    1,
    'example smoke replay_parity_future_rows',
  );

  return {
    example_id: value.example_id,
    metrics: {
      case_count: caseCount,
      replay_parity_future_rows: futureRows,
      replay_parity_ready_rows_run: readyRows,
    },
    model_matrix_status: value.model_matrix_status,
  };
}

function exactInteger(value, expected, label) {
  if (value !== expected) {
    throw new Error(`${label} is ${String(value)}; expected ${expected}.`);
  }
  return value;
}

function normalizeTestCount(value, label) {
  if (!isRecord(value)) {
    throw new Error(`${label} must include tests_passed and tests_total.`);
  }
  const testsPassed = value.tests_passed;
  const testsTotal = value.tests_total;
  if (
    !Number.isSafeInteger(testsPassed) ||
    !Number.isSafeInteger(testsTotal) ||
    testsPassed <= 0 ||
    testsTotal <= 0 ||
    testsPassed !== testsTotal
  ) {
    throw new Error(`${label} must be equal passing safe integers.`);
  }
  return {
    tests_passed: testsPassed,
    tests_total: testsTotal,
  };
}

function normalizeHygieneEvidence(value) {
  if (!isRecord(value)) {
    throw new Error('hygieneEvidence is required.');
  }
  return {
    dependencyScan: passStatus(value.dependencyScan, 'hygieneEvidence.dependencyScan'),
    diffCheck: passStatus(value.diffCheck, 'hygieneEvidence.diffCheck'),
    secretScan: passStatus(value.secretScan, 'hygieneEvidence.secretScan'),
  };
}

function passStatus(value, label) {
  if (value !== 'pass') {
    throw new Error(`${label} must be pass.`);
  }
  return 'pass';
}

function cleanWorktreeStatus(value) {
  if (value !== 'clean') {
    throw new Error('worktreeStatus must be clean.');
  }
  return 'clean';
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function loadCradleDistModule(subpath) {
  const modulePath = join(
    REPO_ROOT,
    'packages/reactor-cradle/dist',
    subpath,
    'index.js',
  );
  try {
    return require(modulePath);
  } catch (error) {
    throw new Error(
      `Could not load built Cradle module ${subpath}. Run pnpm --filter @openprose/reactor-cradle build first. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      values[key] = next;
      index += 1;
    } else {
      values[key] = 'true';
    }
  }
  return values;
}

function required(values, key) {
  const value = values[key];
  if (!value) {
    throw new Error(`Missing required --${key}.`);
  }
  return value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMainModule() {
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}
