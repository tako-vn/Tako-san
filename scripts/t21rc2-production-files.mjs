import { constants, lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const T21RC2_ERROR_CODES = Object.freeze([
  'T21RC2_GATE_REJECTED', 'T21RC2_REVIEW_BINDING_REJECTED', 'T21RC2_APPROVAL_REJECTED', 'T21RC2_IDENTITY_REJECTED',
  'T21RC2_QUERY_REJECTED', 'T21RC2_QUERY_FAILED', 'T21RC2_CAPTURE_INCOMPLETE',
  'T21RC2_RECIPE_ROSTER_CHANGED', 'T21RC2_LEDGER_CHANGED',
  'T21RC2_PRODUCTION_SNAPSHOT_UNSTABLE', 'T21RC2_CLASSIFICATION_REJECTED',
  'T21RC2_RECEIPT_REJECTED', 'T21RC2_PRIVATE_PATH_REJECTED',
]);
const PRIVATE_FILES = new Set([
  'authorization.json', 'authorization-final.json', 'capture-a.json', 'capture-b.json',
  'capture-observations.json', 'capture-verified.json', 'capture-proof.json', 'classifier-input.json', 'row-manifest.json',
]);

export function t21rc2Error(code) {
  const safe = T21RC2_ERROR_CODES.includes(code) ? code : 'T21RC2_CAPTURE_INCOMPLETE';
  const error = new Error(safe);
  error.code = safe;
  return error;
}

export function safeT21RC2Error(error) {
  return T21RC2_ERROR_CODES.includes(error?.code) ? error.code : 'T21RC2_CAPTURE_INCOMPLETE';
}

export function runnerPaths(env = process.env, cwd = process.cwd()) {
  try {
    if (!path.isAbsolute(env.RUNNER_TEMP ?? '')) throw t21rc2Error('T21RC2_PRIVATE_PATH_REJECTED');
    const temp = realpathSync(env.RUNNER_TEMP);
    const workspace = realpathSync(cwd);
    const relative = path.relative(workspace, temp);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw t21rc2Error('T21RC2_PRIVATE_PATH_REJECTED');
    }
    return { privateDirectory: path.join(temp, 't21rc2'), publicReceipt: path.join(temp, 't21rc2-public-receipt.json') };
  } catch {
    throw t21rc2Error('T21RC2_PRIVATE_PATH_REJECTED');
  }
}

export function privateDirectory(env = process.env, cwd = process.cwd()) {
  const directory = runnerPaths(env, cwd).privateDirectory;
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw t21rc2Error('T21RC2_PRIVATE_PATH_REJECTED');
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw t21rc2Error('T21RC2_PRIVATE_PATH_REJECTED');
  }
  return directory;
}

export function writePrivateJson(name, value, env = process.env, cwd = process.cwd()) {
  if (!PRIVATE_FILES.has(name)) throw t21rc2Error('T21RC2_PRIVATE_PATH_REJECTED');
  writeExclusive(path.join(privateDirectory(env, cwd), name), value);
}

function writeExclusive(file, value) {
  let descriptor;
  try {
    descriptor = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
  } catch {
    throw t21rc2Error('T21RC2_PRIVATE_PATH_REJECTED');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readPrivateJson(name, env = process.env, cwd = process.cwd()) {
  if (!PRIVATE_FILES.has(name)) throw t21rc2Error('T21RC2_PRIVATE_PATH_REJECTED');
  try {
    const file = path.join(privateDirectory(env, cwd), name);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw t21rc2Error('T21RC2_PRIVATE_PATH_REJECTED');
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw t21rc2Error('T21RC2_PRIVATE_PATH_REJECTED');
  }
}

export function writePublicReceipt(receipt, env = process.env, cwd = process.cwd()) {
  writeExclusive(runnerPaths(env, cwd).publicReceipt, receipt);
}

export function removePublicReceipt(env = process.env, cwd = process.cwd()) {
  rmSync(runnerPaths(env, cwd).publicReceipt, { force: true });
}

export function buildT21RC2FailureReceipt(error) {
  return {
    schemaVersion: 1, status: 'T21RC2_CAPTURE_BLOCKED', reason: safeT21RC2Error(error),
    certification: 'NOT_A_RELEASE_CERTIFICATION', readOnly: true,
    productionMutations: 0, sqlWrites: 0, restores: 0, migrations: 0,
    applied0039: false, deploys: 0, repairAuthorized: false, t21gStatus: 'T21G_NOT_READY',
    rowLevelEvidenceDelivery: 'UNCONFIGURED',
  };
}

export function recordT21RC2Failure(error, env = process.env, cwd = process.cwd()) {
  try {
    removePublicReceipt(env, cwd);
    writePublicReceipt(buildT21RC2FailureReceipt(error), env, cwd);
  } catch {
    // Missing or unsafe runner storage must not expose the original exception.
  }
}

export function cleanupT21RC2Files(env = process.env, cwd = process.cwd()) {
  const directory = runnerPaths(env, cwd).privateDirectory;
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw t21rc2Error('T21RC2_PRIVATE_PATH_REJECTED');
    rmSync(directory, { recursive: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw t21rc2Error('T21RC2_PRIVATE_PATH_REJECTED');
  }
}
