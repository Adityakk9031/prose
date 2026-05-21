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
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const EXPECTED_PACKAGE_NAME = '@openprose/reactor';
const execFileAsync = promisify(execFile);

export const REACTOR_PUBLIC_EXPORT_SUBPATHS = Object.freeze([
  '.',
  './receipt',
  './cost',
  './kernel',
  './evidence-plan',
  './memo',
  './forecast',
  './sdk',
  './policy',
  './composition',
  './projection',
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
        'Usage: smoke-reactor-tarball-import.mjs --tarball <package.tgz>',
        '',
        'Extracts a packed @openprose/reactor tarball into a temporary local',
        'consumer, installs it directly into node_modules without a package',
        'manager or network, and imports every public package export.',
      ].join('\n'),
    );
    return;
  }

  const result = await smokeReactorTarballImport({
    tarballPath: required(args, 'tarball'),
  });

  console.log(
    `Reactor tarball import smoke verified: ${result.packageName}@${result.version}; imported ${result.imports.length} public entrypoints.`,
  );
}

export async function smokeReactorTarballImport({
  execFileImpl = execFileAsync,
  expectedSubpaths = REACTOR_PUBLIC_EXPORT_SUBPATHS,
  tarballPath,
} = {}) {
  if (!tarballPath) {
    throw new Error('Missing required --tarball.');
  }

  const subpaths = normalizeExpectedSubpaths(expectedSubpaths);
  const tempRoot = await mkdtemp(join(tmpdir(), 'openprose-reactor-import-'));

  try {
    const extractDir = join(tempRoot, 'extract');
    const consumerRoot = join(tempRoot, 'consumer');
    const installedPackageRoot = join(
      consumerRoot,
      'node_modules',
      '@openprose',
      'reactor',
    );

    await mkdir(extractDir, { recursive: true });
    await mkdir(dirname(installedPackageRoot), { recursive: true });
    await execFileImpl('tar', ['-xzf', resolve(tarballPath), '-C', extractDir], {
      cwd: tempRoot,
    });

    const packageRoot = join(extractDir, 'package');
    await assertDirectory(packageRoot, 'Package tarball root');

    const packageJsonPath = join(packageRoot, 'package.json');
    const packageJson = await readJson(packageJsonPath);
    const packageName = stringField(packageJson, 'name', packageJsonPath);
    const version = stringField(packageJson, 'version', packageJsonPath);

    if (packageName !== EXPECTED_PACKAGE_NAME) {
      throw new Error(
        `${packageJsonPath} package name is ${packageName}; expected ${EXPECTED_PACKAGE_NAME}.`,
      );
    }

    const exportTargets = await verifyPackedExports({
      packageJson,
      packageJsonPath,
      packageRoot,
      subpaths,
    });

    await cp(packageRoot, installedPackageRoot, {
      force: true,
      recursive: true,
    });
    await writeFile(
      join(consumerRoot, 'package.json'),
      `${JSON.stringify(
        {
          name: 'openprose-reactor-tarball-smoke-consumer',
          private: true,
          type: 'module',
          dependencies: {
            [EXPECTED_PACKAGE_NAME]: version,
          },
        },
        null,
        2,
      )}\n`,
    );

    const importScriptPath = join(consumerRoot, 'import-public-entrypoints.mjs');
    await writeFile(importScriptPath, importSmokeScript(), 'utf8');

    const importSpecifiers = subpaths.map(toImportSpecifier);
    const { stdout } = await runImportSmoke(execFileImpl, importScriptPath, {
      consumerRoot,
      importSpecifiers,
    });
    const imports = parseImportSmokeOutput(stdout, importSpecifiers);

    return {
      exportTargets,
      imports,
      packageName,
      subpaths,
      version,
    };
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

async function verifyPackedExports({
  packageJson,
  packageJsonPath,
  packageRoot,
  subpaths,
}) {
  const exportsMap = exportsField(packageJson, packageJsonPath);
  const exportTargets = [];

  for (const subpath of subpaths) {
    if (!Object.prototype.hasOwnProperty.call(exportsMap, subpath)) {
      throw new Error(`${packageJsonPath} is missing required export "${subpath}".`);
    }

    const exportLabel = `${packageJsonPath} exports["${subpath}"]`;
    const defaultTarget = defaultExportTarget(exportsMap[subpath], exportLabel);
    await assertPackageFile(packageRoot, defaultTarget, `${exportLabel} default`);

    exportTargets.push({
      default: defaultTarget,
      specifier: toImportSpecifier(subpath),
      subpath,
    });
  }

  return exportTargets;
}

async function runImportSmoke(execFileImpl, importScriptPath, {
  consumerRoot,
  importSpecifiers,
}) {
  try {
    return await execFileImpl(process.execPath, [importScriptPath], {
      cwd: consumerRoot,
      env: {
        ...process.env,
        OPENPROSE_REACTOR_IMPORT_SPECIFIERS: JSON.stringify(importSpecifiers),
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
    throw new Error(`Reactor tarball import smoke failed:\n${detail}`);
  }
}

function importSmokeScript() {
  return `const specifiers = JSON.parse(process.env.OPENPROSE_REACTOR_IMPORT_SPECIFIERS ?? "[]");
const imports = [];

for (const specifier of specifiers) {
  const namespace = await import(specifier);
  const exportNames = Object.keys(namespace).sort();
  if (exportNames.length === 0) {
    throw new Error(\`\${specifier} imported but exposed no runtime exports.\`);
  }
  imports.push({
    exportCount: exportNames.length,
    sampleExports: exportNames.slice(0, 8),
    specifier,
  });
}

process.stdout.write(JSON.stringify({ imports }) + "\\n");
`;
}

function parseImportSmokeOutput(stdout, expectedSpecifiers) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Could not parse import smoke output as JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!Array.isArray(parsed?.imports)) {
    throw new Error('Import smoke output must contain an imports array.');
  }
  if (parsed.imports.length !== expectedSpecifiers.length) {
    throw new Error(
      `Import smoke output reported ${parsed.imports.length} imports; expected ${expectedSpecifiers.length}.`,
    );
  }

  return parsed.imports.map((entry, index) => {
    const specifier = stringField(entry, 'specifier', `imports[${index}]`);
    if (specifier !== expectedSpecifiers[index]) {
      throw new Error(
        `Import smoke output specifier ${specifier}; expected ${expectedSpecifiers[index]}.`,
      );
    }
    if (!Number.isInteger(entry.exportCount) || entry.exportCount <= 0) {
      throw new Error(`${specifier} must report at least one runtime export.`);
    }

    return {
      exportCount: entry.exportCount,
      sampleExports: Array.isArray(entry.sampleExports)
        ? entry.sampleExports.filter((value) => typeof value === 'string')
        : [],
      specifier,
    };
  });
}

function exportsField(packageJson, label) {
  const value = packageJson?.exports;
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new Error(`${label} must contain an object "exports" map.`);
  }
  return value;
}

function defaultExportTarget(value, label) {
  if (typeof value === 'string') {
    return normalizePackageTarget(value, label);
  }

  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.default === 'string'
  ) {
    return normalizePackageTarget(value.default, `${label}.default`);
  }

  throw new Error(`${label} must expose a string default target.`);
}

function normalizePackageTarget(value, label) {
  if (typeof value !== 'string' || !value.startsWith('./')) {
    throw new Error(`${label} must be a package-relative "./" target.`);
  }

  const relativePath = value.slice(2);
  if (
    relativePath === '' ||
    relativePath.includes('\0') ||
    relativePath.split('/').includes('..')
  ) {
    throw new Error(`${label} must not be empty or contain traversal.`);
  }

  return relativePath;
}

async function assertPackageFile(packageRoot, packageTarget, label) {
  const path = join(packageRoot, ...packageTarget.split('/'));
  let fileStat;
  try {
    fileStat = await stat(path);
  } catch {
    throw new Error(`${label} target ${packageTarget} is missing from the packed package.`);
  }

  if (!fileStat.isFile()) {
    throw new Error(`${label} target ${packageTarget} is not a file.`);
  }
}

async function assertDirectory(path, label) {
  let fileStat;
  try {
    fileStat = await stat(path);
  } catch {
    throw new Error(`${label} is missing.`);
  }

  if (!fileStat.isDirectory()) {
    throw new Error(`${label} is not a directory.`);
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

function stringField(value, field, label) {
  const fieldValue = value?.[field];
  if (typeof fieldValue !== 'string' || fieldValue.trim() === '') {
    throw new Error(`${label} must contain a non-empty string field "${field}".`);
  }
  return fieldValue.trim();
}

function normalizeExpectedSubpaths(subpaths) {
  if (!Array.isArray(subpaths) || subpaths.length === 0) {
    throw new Error('Expected subpaths must be a non-empty array.');
  }

  const seen = new Set();
  return subpaths.map((subpath, index) => {
    if (typeof subpath !== 'string' || subpath.trim() === '') {
      throw new Error(`Expected subpaths[${index}] must be a non-empty string.`);
    }
    const normalized = subpath.trim();
    if (normalized !== '.' && !normalized.startsWith('./')) {
      throw new Error(
        `Expected subpaths[${index}] must be "." or a package export subpath starting with "./".`,
      );
    }
    if (seen.has(normalized)) {
      throw new Error(`Expected subpaths contains duplicate ${normalized}.`);
    }
    seen.add(normalized);
    return normalized;
  });
}

function toImportSpecifier(subpath) {
  return subpath === '.'
    ? EXPECTED_PACKAGE_NAME
    : `${EXPECTED_PACKAGE_NAME}/${subpath.slice(2)}`;
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

function isMainModule() {
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}
