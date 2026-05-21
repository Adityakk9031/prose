#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const EXPECTED_PACKAGE_NAME = '@openprose/reactor';
const EXPECTED_CONSUMER_NAME = '@openprose/reactor-cradle';
const DEFAULT_PACKAGE_DIR = 'packages/reactor';
const DEFAULT_CONSUMER_PACKAGE = 'packages/reactor-cradle/package.json';
const DEFAULT_PIN = 'packages/reactor-cradle/.openprose-reactor-pin.json';
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
        'Usage: verify-reactor-pin.mjs --tarball <package.tgz> [options]',
        '',
        'Options:',
        '  --packageDir <path>        Reactor package directory (default: packages/reactor)',
        '  --consumerPackage <path>   Cradle package.json path (default: packages/reactor-cradle/package.json)',
        '  --pin <path>               Reactor pin JSON path (default: packages/reactor-cradle/.openprose-reactor-pin.json)',
      ].join('\n'),
    );
    return;
  }

  const result = await verifyReactorPin({
    consumerPackagePath: args.consumerPackage ?? DEFAULT_CONSUMER_PACKAGE,
    packageDir: args.packageDir ?? DEFAULT_PACKAGE_DIR,
    pinPath: args.pin ?? DEFAULT_PIN,
    tarballPath: required(args, 'tarball'),
  });

  console.log(
    `Reactor package pin verified: ${result.packageName}@${result.version} ${result.packageTreeSha256}; ${result.checkedFiles.length} checked files present.`,
  );
}

export async function verifyReactorPin({
  consumerPackagePath = DEFAULT_CONSUMER_PACKAGE,
  packageDir = DEFAULT_PACKAGE_DIR,
  pinPath = DEFAULT_PIN,
  inspectPackedPackageImpl = inspectPackedReactorPackage,
  readFileImpl = readFile,
  tarballPath,
} = {}) {
  if (!tarballPath) {
    throw new Error('Missing required --tarball.');
  }

  const packageJsonPath = resolve(packageDir, 'package.json');
  const [packageJson, consumerPackageJson, pin] = await Promise.all([
    readJson(packageJsonPath, readFileImpl),
    readJson(consumerPackagePath, readFileImpl),
    readJson(pinPath, readFileImpl),
  ]);

  const packageName = stringField(packageJson, 'name', packageJsonPath);
  const version = stringField(packageJson, 'version', packageJsonPath);
  const consumerName = stringField(
    consumerPackageJson,
    'name',
    consumerPackagePath,
  );
  const pinnedPackage = stringField(pin, 'package', pinPath);
  const pinnedVersion = stringField(pin, 'version', pinPath);
  const pinnedPackageTreeSha256 = normalizeSha256(
    stringField(pin, 'packageTreeSha256', pinPath),
    `${pinPath} packageTreeSha256`,
  );
  const checkedFiles = checkedFilesField(pin, 'checkedFiles', pinPath);
  const inspectedPackage = normalizePackedPackageInspection(
    await inspectPackedPackageImpl(tarballPath),
    tarballPath,
  );

  if (packageName !== EXPECTED_PACKAGE_NAME) {
    throw new Error(
      `${packageJsonPath} package name is ${packageName}; expected ${EXPECTED_PACKAGE_NAME}.`,
    );
  }
  if (consumerName !== EXPECTED_CONSUMER_NAME) {
    throw new Error(
      `${consumerPackagePath} package name is ${consumerName}; expected ${EXPECTED_CONSUMER_NAME}.`,
    );
  }
  if (pinnedPackage !== packageName) {
    throw new Error(
      `${pinPath} pins package ${pinnedPackage}; expected ${packageName}.`,
    );
  }
  if (pinnedVersion !== version) {
    throw new Error(
      `${pinPath} pins ${packageName}@${pinnedVersion}; package.json is ${version}.`,
    );
  }
  if (pinnedPackageTreeSha256 !== inspectedPackage.packageTreeSha256) {
    throw new Error(
      `${pinPath} package tree SHA-256 is ${pinnedPackageTreeSha256}; packed artifact tree is ${inspectedPackage.packageTreeSha256}.`,
    );
  }

  const expectedDependency = `workspace:${version}`;
  const consumerDependency =
    consumerPackageJson?.dependencies?.[packageName] ?? null;
  if (consumerDependency !== expectedDependency) {
    throw new Error(
      `${consumerPackagePath} depends on ${packageName} as ${
        consumerDependency ?? 'missing'
      }; expected ${expectedDependency}.`,
    );
  }

  const packedFiles = new Set(inspectedPackage.files);
  const missingCheckedFiles = checkedFiles.filter((file) => !packedFiles.has(file));
  if (missingCheckedFiles.length > 0) {
    throw new Error(
      `${pinPath} checkedFiles missing from packed artifact: ${missingCheckedFiles.join(', ')}.`,
    );
  }

  return {
    checkedFiles,
    consumerDependency,
    packageName,
    packageTreeSha256: inspectedPackage.packageTreeSha256,
    version,
  };
}

export async function inspectPackedReactorPackage(tarballPath) {
  const extractDir = await mkdtemp(join(tmpdir(), 'openprose-reactor-pin-'));
  try {
    await execFileAsync('tar', ['-xzf', resolve(tarballPath), '-C', extractDir]);
    const packageRoot = join(extractDir, 'package');
    const files = await collectFiles(packageRoot);
    const hash = createHash('sha256');

    for (const path of files) {
      const bytes = await readFile(join(packageRoot, ...path.split('/')));
      hash.update('file\0');
      hash.update(path);
      hash.update('\0');
      hash.update(String(bytes.length));
      hash.update('\0');
      hash.update(bytes);
      hash.update('\0');
    }

    return {
      files,
      packageTreeSha256: hash.digest('hex'),
    };
  } finally {
    await rm(extractDir, { force: true, recursive: true });
  }
}

async function collectFiles(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolutePath, relativePath)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Package tarball contains unsupported entry ${relativePath}.`);
    }

    files.push(relativePath);
  }

  return files.sort();
}

async function readJson(path, readFileImpl) {
  let text;
  try {
    text = await readFileImpl(path, 'utf8');
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

function checkedFilesField(value, field, label) {
  const fieldValue = value?.[field];
  if (!Array.isArray(fieldValue) || fieldValue.length === 0) {
    throw new Error(`${label} must contain a non-empty array field "${field}".`);
  }

  const seen = new Set();
  return fieldValue.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(
        `${label} ${field}[${index}] must be a non-empty package-relative file path.`,
      );
    }

    const file = entry.trim();
    if (
      file.startsWith('/') ||
      file.startsWith('./') ||
      file.includes('\0') ||
      file.split('/').includes('..')
    ) {
      throw new Error(
        `${label} ${field}[${index}] must be a package-relative file path without traversal.`,
      );
    }
    if (seen.has(file)) {
      throw new Error(`${label} ${field} contains duplicate file ${file}.`);
    }

    seen.add(file);
    return file;
  });
}

function normalizePackedPackageInspection(value, label) {
  const packageTreeSha256 = normalizeSha256(
    value?.packageTreeSha256,
    `${label} packageTreeSha256`,
  );
  if (!Array.isArray(value?.files)) {
    throw new Error(`${label} inspection must include a files array.`);
  }

  const files = value.files.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`${label} files[${index}] must be a non-empty string.`);
    }
    return entry.trim();
  });

  return {
    files,
    packageTreeSha256,
  };
}

function normalizeSha256(value, label) {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a 64-character hex SHA-256 digest.`);
  }

  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a 64-character hex SHA-256 digest.`);
  }
  return normalized;
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
