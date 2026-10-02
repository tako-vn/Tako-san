import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireSuccessfulCi, validateReleaseSource } from './release-check.mjs';
import {
  readPrivateJson,
  recordT21RC2Failure,
  safeT21RC2Error,
  t21rc2Error,
  writePrivateJson,
} from './t21rc2-production-files.mjs';

export const T21RC2_REPOSITORY_ID = 1385308553;
export const T21RC2_REPOSITORY = 'vn-tak/Tako-san';
export const EXPECTED_PRODUCTION_REVIEWER = 'vn-taphoanhatung';
export const T21RC2_WORKFLOW_PATH = '.github/workflows/production-d1-t21rc-row-reconciliation.yml';
const OPTIONAL_REVIEW_BOUND_PATHS = Object.freeze([
  '.npmrc', '.pnpmfile.cjs', 'pnpm-workspace.yaml', '.gitattributes',
  'vite.config.js', 'vite.config.mjs', 'vite.config.cjs', 'vite.config.mts', 'vite.config.cts',
  '.env', '.env.local', '.env.development', '.env.development.local',
]);
export const T21RC2_REVIEW_BOUND_PATHS = Object.freeze([
  T21RC2_WORKFLOW_PATH,
  'scripts/t21rc2-production-approval.mjs',
  'scripts/t21rc2-production-capture.mjs',
  'scripts/t21rc2-production-files.mjs',
  'scripts/t21rc2-production-receipt.mjs',
  'scripts/t21rc-row-reconciliation.mjs',
  'scripts/t21r-v1-authority.mjs',
  'scripts/release-check.mjs',
  'scripts/d1-migration-check.mjs',
  'docs/ai/recipe-catalog/T21RC_ROW_RECONCILIATION_SCHEMA.json',
  'docs/ai/recipe-catalog/T21RA_RUNTIME_CANONICAL_TARGET.json',
  'wrangler.jsonc',
  'package.json',
  'pnpm-lock.yaml',
  '.github/workflows/ci.yml',
  'scripts/t21rb-v1-semantic.mjs',
  'vite.config.ts',
  'tsconfig.json',
  'data/recipe-import/approved-batches.json',
  'data/recipe-import/t14f/pilot-30.jsonl',
  'data/recipe-import/t14f/scale-399.jsonl',
  'data/recipe-refresh/v2/ingredient-reconciliation.json',
  'packages/recipes/src/import/catalog-release.current.json',
  'migrations',
  'packages/domain/src/availability.ts',
  'packages/domain/src/foundation.ts',
  'packages/domain/src/index.ts',
  'packages/domain/src/inventory-read-authority.ts',
  'packages/domain/src/inventory-truth.ts',
  'packages/domain/src/meal-planning-api.ts',
  'packages/domain/src/meal-shopping-api.ts',
  'packages/domain/src/quantity.ts',
  'packages/domain/src/units.ts',
  'packages/domain/src/week/index.ts',
  'packages/domain/src/week/leftover.ts',
  'packages/domain/src/week/packages.ts',
  'packages/domain/src/week/planner.ts',
  'packages/domain/src/week/portion.ts',
  'packages/domain/src/week/pricing.ts',
  'packages/domain/src/week/score.ts',
  'packages/domain/src/week/shopping.ts',
  'packages/domain/src/week/types.ts',
  'packages/domain/src/week/utilization.ts',
  'packages/recipes/src/catalog-fingerprint.ts',
  'packages/recipes/src/data.ts',
  'packages/recipes/src/import/compiler.ts',
  'packages/recipes/src/import/duplicates.ts',
  'packages/recipes/src/import/identity.ts',
  'packages/recipes/src/import/ingredients.ts',
  'packages/recipes/src/import/index.ts',
  'packages/recipes/src/import/normalize.ts',
  'packages/recipes/src/import/parse.ts',
  'packages/recipes/src/import/release-manifest.ts',
  'packages/recipes/src/import/schema.ts',
  'packages/recipes/src/import/sql-render.ts',
  'packages/recipes/src/import/types.ts',
  'packages/recipes/src/runtime-recipe.ts',
  'packages/recipes/src/seed-render.ts',
  'packages/recipes/src/vietnamese-bank.ts',
  'packages/recipes/src/vietnamese-images.ts',
  ...OPTIONAL_REVIEW_BOUND_PATHS,
]);

const API_VERSION = '2026-03-10';
const API_BASE = `https://api.github.com/repos/${T21RC2_REPOSITORY}`;
const FULL_SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CI_RUNS = 1000;
const PAGE_SIZE = 100;
const MAIN_REF = 'main';

const gateError = () => t21rc2Error('T21RC2_GATE_REJECTED');
const approvalError = () => t21rc2Error('T21RC2_APPROVAL_REJECTED');
const fail = (condition, code = 'T21RC2_GATE_REJECTED') => {
  if (!condition) throw t21rc2Error(code);
};
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};
const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

function normalizeLogin(value, code = 'T21RC2_GATE_REJECTED') {
  fail(typeof value === 'string' && GITHUB_LOGIN.test(value), code);
  return value.toLowerCase();
}

function normalizeId(value, code = 'T21RC2_GATE_REJECTED') {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  fail(typeof value === 'string' && /^[1-9][0-9]*$/.test(value), code);
  return value;
}

function safeInteger(value, code = 'T21RC2_GATE_REJECTED') {
  const normalized = normalizeId(value, code);
  const number = Number(normalized);
  fail(Number.isSafeInteger(number) && number > 0, code);
  return number;
}

function bypassFlagSet(record) {
  return Object.entries(record).some(([key, value]) => {
    if (!/bypass/i.test(key)) return false;
    return value !== false && value !== null && value !== undefined && value !== 0 && value !== '';
  });
}

function normalizeEnvironmentPolicy(environment) {
  fail(isRecord(environment), 'T21RC2_APPROVAL_REJECTED');
  fail(environment.name === 'production', 'T21RC2_APPROVAL_REJECTED');
  const environmentId = normalizeId(environment.id, 'T21RC2_APPROVAL_REJECTED');
  fail(typeof environment.can_admins_bypass === 'boolean', 'T21RC2_APPROVAL_REJECTED');
  fail(Array.isArray(environment.protection_rules), 'T21RC2_APPROVAL_REJECTED');

  const protectionRules = environment.protection_rules.map((rule) => {
    fail(isRecord(rule) && typeof rule.type === 'string', 'T21RC2_APPROVAL_REJECTED');
    fail(!bypassFlagSet(rule), 'T21RC2_APPROVAL_REJECTED');
    const id = normalizeId(rule.id, 'T21RC2_APPROVAL_REJECTED');
    if (rule.type === 'required_reviewers') {
      fail(typeof rule.prevent_self_review === 'boolean', 'T21RC2_APPROVAL_REJECTED');
      fail(Array.isArray(rule.reviewers) && rule.reviewers.length === 1, 'T21RC2_APPROVAL_REJECTED');
      const entry = rule.reviewers[0];
      fail(isRecord(entry) && entry.type === 'User', 'T21RC2_APPROVAL_REJECTED');
      fail(isRecord(entry.reviewer), 'T21RC2_APPROVAL_REJECTED');
      const login = normalizeLogin(entry.reviewer.login, 'T21RC2_APPROVAL_REJECTED');
      fail(login === EXPECTED_PRODUCTION_REVIEWER, 'T21RC2_APPROVAL_REJECTED');
      return {
        id,
        type: rule.type,
        preventSelfReview: rule.prevent_self_review,
        reviewers: [{
          type: entry.type,
          id: normalizeId(entry.reviewer.id, 'T21RC2_APPROVAL_REJECTED'),
          login,
        }],
      };
    }
    if (rule.type === 'wait_timer') {
      fail(Number.isSafeInteger(rule.wait_timer) && rule.wait_timer >= 0, 'T21RC2_APPROVAL_REJECTED');
      return { id, type: rule.type, waitTimer: rule.wait_timer };
    }
    if (rule.type === 'branch_policy') return { id, type: rule.type };
    throw approvalError();
  });

  fail(
    protectionRules.filter((rule) => rule.type === 'required_reviewers').length === 1,
    'T21RC2_APPROVAL_REJECTED',
  );
  const deploymentBranchPolicy = environment.deployment_branch_policy;
  if (deploymentBranchPolicy !== null) {
    fail(isRecord(deploymentBranchPolicy), 'T21RC2_APPROVAL_REJECTED');
    fail(
      typeof deploymentBranchPolicy.protected_branches === 'boolean' &&
        typeof deploymentBranchPolicy.custom_branch_policies === 'boolean',
      'T21RC2_APPROVAL_REJECTED',
    );
  }

  return {
    environmentId,
    name: environment.name,
    canAdminsBypass: environment.can_admins_bypass,
    protectionRules: protectionRules.sort((a, b) => {
      const left = canonicalJson(a);
      const right = canonicalJson(b);
      return left < right ? -1 : left > right ? 1 : 0;
    }),
    deploymentBranchPolicy:
      deploymentBranchPolicy === null
        ? null
        : {
            protectedBranches: deploymentBranchPolicy.protected_branches,
            customBranchPolicies: deploymentBranchPolicy.custom_branch_policies,
          },
  };
}

function approvalHistoryProof(history, environmentId, expectedReviewerId, actor, triggeringActor) {
  fail(Array.isArray(history) && history.length === 1, 'T21RC2_APPROVAL_REJECTED');
  const approval = history[0];
  fail(isRecord(approval) && !bypassFlagSet(approval), 'T21RC2_APPROVAL_REJECTED');
  fail(approval.state === 'approved', 'T21RC2_APPROVAL_REJECTED');
  fail(isRecord(approval.user) && approval.user.type === 'User', 'T21RC2_APPROVAL_REJECTED');
  const reviewer = normalizeLogin(approval.user.login, 'T21RC2_APPROVAL_REJECTED');
  fail(reviewer === EXPECTED_PRODUCTION_REVIEWER, 'T21RC2_APPROVAL_REJECTED');
  const reviewerId = normalizeId(approval.user.id, 'T21RC2_APPROVAL_REJECTED');
  fail(reviewerId === expectedReviewerId, 'T21RC2_APPROVAL_REJECTED');
  fail(reviewer !== actor && reviewer !== triggeringActor, 'T21RC2_APPROVAL_REJECTED');
  fail(Array.isArray(approval.environments) && approval.environments.length === 1, 'T21RC2_APPROVAL_REJECTED');
  const [approvedEnvironment] = approval.environments;
  fail(isRecord(approvedEnvironment), 'T21RC2_APPROVAL_REJECTED');
  const approvedEnvironmentId = normalizeId(approvedEnvironment.id, 'T21RC2_APPROVAL_REJECTED');
  fail(
    approvedEnvironmentId === environmentId && approvedEnvironment.name === 'production',
    'T21RC2_APPROVAL_REJECTED',
  );
  return {
    state: approval.state,
    reviewer: { id: reviewerId, login: reviewer, type: approval.user.type },
    environments: [{ id: approvedEnvironmentId, name: approvedEnvironment.name }],
  };
}

export function validateProductionApproval({ history, environment, actor, triggeringActor } = {}) {
  try {
    const normalizedActor = normalizeLogin(actor, 'T21RC2_APPROVAL_REJECTED');
    const normalizedTriggeringActor = normalizeLogin(triggeringActor, 'T21RC2_APPROVAL_REJECTED');
    const policy = normalizeEnvironmentPolicy(environment);
    const expectedReviewerId = policy.protectionRules.find((rule) => rule.type === 'required_reviewers').reviewers[0].id;
    const historyProof = approvalHistoryProof(
      history,
      policy.environmentId,
      expectedReviewerId,
      normalizedActor,
      normalizedTriggeringActor,
    );
    return {
      environment: 'production',
      state: 'approved',
      reviewer: EXPECTED_PRODUCTION_REVIEWER,
      actor: normalizedActor,
      historySha256: sha256({ history: historyProof, actor: normalizedActor, triggeringActor: normalizedTriggeringActor }),
      policySha256: sha256(policy),
    };
  } catch {
    throw approvalError();
  }
}

function validateRunMetadata({ run, ref, runId, runAttempt, actor, triggeringActor }) {
  fail(isRecord(run));
  fail(normalizeId(run.id) === runId);
  fail(runAttempt === '1' && String(run.run_attempt) === '1');
  fail(FULL_SHA.test(run.head_sha ?? '') && run.head_sha === ref);
  fail(run.head_branch === 'main' && run.event === 'workflow_dispatch');
  fail(run.path === T21RC2_WORKFLOW_PATH);
  fail(isRecord(run.repository) && run.repository.full_name === T21RC2_REPOSITORY);
  fail(normalizeId(run.repository.id) === String(T21RC2_REPOSITORY_ID));
  fail(isRecord(run.head_repository) && run.head_repository.full_name === T21RC2_REPOSITORY);
  fail(normalizeId(run.head_repository.id) === String(T21RC2_REPOSITORY_ID));
  fail(normalizeLogin(run.actor?.login) === actor);
  fail(normalizeLogin(run.triggering_actor?.login) === triggeringActor);
}

export function assertReviewedExecutionClosure(reviewedSha, releaseRef, { cwd = process.cwd() } = {}) {
  const code = 'T21RC2_REVIEW_BINDING_REJECTED';
  try {
    fail(FULL_SHA.test(reviewedSha ?? '') && FULL_SHA.test(releaseRef ?? '') && reviewedSha !== releaseRef, code);
    const options = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 };
    for (const sha of [reviewedSha, releaseRef]) {
      const commit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`], options).trim();
      fail(commit === sha, code);
    }
    const reviewedEntries = execFileSync('git', [
      'ls-tree', '-r', '-z', '--full-tree', reviewedSha, '--', ...T21RC2_REVIEW_BOUND_PATHS,
    ], options).split('\0').filter(Boolean);
    const reviewedFiles = new Map(reviewedEntries.map((entry) => {
      const [metadata, file] = entry.split('\t');
      fail(/^100(?:644|755) blob [a-f0-9]{40}$/.test(metadata), code);
      return [file, metadata];
    }));
    // Auto-loaded config slots may be absent, but their later addition is still bound.
    const reviewedPaths = [...reviewedFiles.keys()];
    fail(T21RC2_REVIEW_BOUND_PATHS.every((file) => OPTIONAL_REVIEW_BOUND_PATHS.includes(file)
      ? reviewedFiles.has(file) || !reviewedPaths.some((entry) => entry.startsWith(`${file}/`))
      : reviewedFiles.has(file) || (file === 'migrations' && reviewedPaths.some((entry) => entry.startsWith('migrations/')))), code);
    execFileSync('git', [
      'diff', '--quiet', '--no-ext-diff', '--no-textconv', reviewedSha, releaseRef,
      '--', ...T21RC2_REVIEW_BOUND_PATHS,
    ], options);
  } catch {
    throw t21rc2Error(code);
  }
}

export function validateT21RC2Gate({
  ref,
  reviewedSha,
  confirmation,
  repositoryId,
  repository,
  actor,
  triggeringActor,
  runId,
  runAttempt,
  run,
  mainSha,
  ciRuns,
  cwd = process.cwd(),
  sourceValidator = validateReleaseSource,
} = {}) {
  try {
    fail(FULL_SHA.test(ref ?? '') && FULL_SHA.test(reviewedSha ?? '') && FULL_SHA.test(mainSha ?? ''));
    fail(ref === mainSha);
    fail(reviewedSha !== ref, 'T21RC2_REVIEW_BINDING_REJECTED');
    fail(confirmation === true || confirmation === 'true');
    fail(normalizeId(repositoryId) === String(T21RC2_REPOSITORY_ID));
    fail(repository === T21RC2_REPOSITORY);
    const normalizedActor = normalizeLogin(actor);
    const normalizedTriggeringActor = normalizeLogin(triggeringActor);
    const normalizedRunId = normalizeId(runId);
    fail(runAttempt === '1');
    validateRunMetadata({
      run,
      ref,
      runId: normalizedRunId,
      runAttempt,
      actor: normalizedActor,
      triggeringActor: normalizedTriggeringActor,
    });
    fail(typeof sourceValidator === 'function');
    const source = sourceValidator({ ref, hardenedSha: reviewedSha, cwd });
    fail(source?.sha === ref && source?.mainSha === mainSha && source?.hardenedSha === reviewedSha);
    assertReviewedExecutionClosure(reviewedSha, ref, { cwd });
    const successfulCi = requireSuccessfulCi(ciRuns, { sha: ref, repository: T21RC2_REPOSITORY });
    const ci = {
      id: safeInteger(successfulCi.id),
      attempt: safeInteger(successfulCi.attempt),
      headSha: successfulCi.headSha,
    };
    fail(ci.headSha === mainSha);
    return {
      schemaVersion: 1,
      repositoryId: T21RC2_REPOSITORY_ID,
      repository: T21RC2_REPOSITORY,
      mainSha,
      reviewedSha,
      runId: normalizedRunId,
      runAttempt: '1',
      actor: normalizedActor,
      triggeringActor: normalizedTriggeringActor,
      ci,
    };
  } catch (error) {
    if (error?.code === 'T21RC2_REVIEW_BINDING_REJECTED') throw error;
    throw gateError();
  }
}

function validateActionEnvironment(env, { requireToken = false } = {}) {
  fail(isRecord(env));
  fail(env.GITHUB_EVENT_NAME === 'workflow_dispatch');
  fail(env.GITHUB_REF === 'refs/heads/main');
  fail(FULL_SHA.test(env.GITHUB_SHA ?? '') && env.GITHUB_SHA === env.RELEASE_REF);
  // Review history does not bind an approval to a rerun attempt.
  fail(env.GITHUB_RUN_ATTEMPT === '1');
  fail(env.CONFIRM_T21RC_READ_ONLY_CAPTURE === 'true');
  if (requireToken) {
    fail(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0 && env.GH_TOKEN.trim() === env.GH_TOKEN);
  }
  return {
    repositoryId: env.GITHUB_REPOSITORY_ID,
    repository: env.GITHUB_REPOSITORY,
    ref: env.RELEASE_REF,
    reviewedSha: env.REVIEWED_SHA,
    confirmation: env.CONFIRM_T21RC_READ_ONLY_CAPTURE,
    actor: env.GITHUB_ACTOR,
    triggeringActor: env.GITHUB_TRIGGERING_ACTOR,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
  };
}

function gitOutput(execute, cwd, args) {
  try {
    const value = execute('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    const output = Buffer.isBuffer(value) ? value.toString('utf8') : value;
    const sha = typeof output === 'string' ? output.trim() : '';
    fail(FULL_SHA.test(sha));
    return sha;
  } catch {
    throw gateError();
  }
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
  };
}

async function getGitHubJson(fetchImpl, url, token, code) {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    fail(response && response.status === 200 && response.ok === true && response.redirected !== true, code);
    const contentLength = response.headers?.get?.('content-length');
    if (contentLength !== null && contentLength !== undefined) {
      fail(/^\d+$/.test(contentLength) && Number(contentLength) <= MAX_RESPONSE_BYTES, code);
    }
    fail(typeof response.text === 'function', code);
    const bodyText = await response.text();
    fail(Buffer.byteLength(bodyText, 'utf8') <= MAX_RESPONSE_BYTES, code);
    return { body: JSON.parse(bodyText), response };
  } catch {
    throw t21rc2Error(code);
  }
}

async function fetchCurrentMainSha(fetchImpl, token) {
  const { body } = await getGitHubJson(
    fetchImpl,
    `${API_BASE}/commits/${MAIN_REF}`,
    token,
    'T21RC2_GATE_REJECTED',
  );
  fail(isRecord(body) && FULL_SHA.test(body.sha ?? ''));
  return body.sha;
}

function hasNextPage(response) {
  const link = response.headers?.get?.('link');
  return typeof link === 'string' && /;\s*rel\s*=\s*"?next"?/i.test(link);
}

function ciRunsUrl(sha, page) {
  const url = new URL(`${API_BASE}/actions/workflows/ci.yml/runs`);
  url.searchParams.set('event', 'push');
  url.searchParams.set('branch', 'main');
  url.searchParams.set('head_sha', sha);
  url.searchParams.set('per_page', String(PAGE_SIZE));
  url.searchParams.set('page', String(page));
  return url.href;
}

async function fetchCompleteCiRuns(fetchImpl, sha, token) {
  const runs = [];
  let expectedTotal;
  let pageCount;
  for (let page = 1; page <= (pageCount ?? 1); page += 1) {
    const { body, response } = await getGitHubJson(
      fetchImpl,
      ciRunsUrl(sha, page),
      token,
      'T21RC2_GATE_REJECTED',
    );
    fail(isRecord(body) && Array.isArray(body.workflow_runs));
    fail(Number.isSafeInteger(body.total_count) && body.total_count >= 0);
    if (expectedTotal === undefined) {
      expectedTotal = body.total_count;
      fail(expectedTotal <= MAX_CI_RUNS);
      pageCount = Math.max(1, Math.ceil(expectedTotal / PAGE_SIZE));
    } else {
      fail(body.total_count === expectedTotal);
    }
    const pageRuns = body.workflow_runs;
    const expectedLength = Math.min(PAGE_SIZE, Math.max(0, expectedTotal - (page - 1) * PAGE_SIZE));
    fail(pageRuns.length === expectedLength);
    fail(hasNextPage(response) === (page < pageCount));
    runs.push(...pageRuns);
  }
  fail(runs.length === expectedTotal);
  const ids = runs.map((run) => normalizeId(run?.id));
  fail(new Set(ids).size === ids.length);
  return runs;
}

async function fetchApprovalHistory(fetchImpl, runId, token) {
  const url = new URL(`${API_BASE}/actions/runs/${encodeURIComponent(runId)}/approvals`);
  url.searchParams.set('per_page', String(PAGE_SIZE));
  url.searchParams.set('page', '1');
  const { body, response } = await getGitHubJson(
    fetchImpl,
    url.href,
    token,
    'T21RC2_APPROVAL_REJECTED',
  );
  fail(Array.isArray(body) && body.length < PAGE_SIZE, 'T21RC2_APPROVAL_REJECTED');
  fail(!hasNextPage(response), 'T21RC2_APPROVAL_REJECTED');
  return body;
}

function validateStoredApproval(approval, actor, triggeringActor) {
  fail(isRecord(approval), 'T21RC2_APPROVAL_REJECTED');
  fail(
    approval.environment === 'production' &&
      approval.state === 'approved' &&
      approval.reviewer === EXPECTED_PRODUCTION_REVIEWER,
    'T21RC2_APPROVAL_REJECTED',
  );
  const approvalActor = normalizeLogin(approval.actor, 'T21RC2_APPROVAL_REJECTED');
  fail(approvalActor === actor, 'T21RC2_APPROVAL_REJECTED');
  const reviewer = normalizeLogin(approval.reviewer, 'T21RC2_APPROVAL_REJECTED');
  fail(reviewer === EXPECTED_PRODUCTION_REVIEWER, 'T21RC2_APPROVAL_REJECTED');
  fail(reviewer !== actor && reviewer !== triggeringActor, 'T21RC2_APPROVAL_REJECTED');
  fail(DIGEST.test(approval.historySha256 ?? '') && DIGEST.test(approval.policySha256 ?? ''), 'T21RC2_APPROVAL_REJECTED');
}

export function requireStoredAuthorizationBinding(authorization, env = process.env) {
  fail(isRecord(authorization));
  fail(authorization.schemaVersion === 1);
  const action = validateActionEnvironment(env);
  const actor = normalizeLogin(action.actor);
  const triggeringActor = normalizeLogin(action.triggeringActor);
  fail(normalizeId(action.repositoryId) === String(T21RC2_REPOSITORY_ID));
  fail(action.repository === T21RC2_REPOSITORY);
  fail(normalizeId(authorization.repositoryId) === String(T21RC2_REPOSITORY_ID));
  fail(authorization.repository === T21RC2_REPOSITORY);
  fail(FULL_SHA.test(authorization.mainSha ?? '') && authorization.mainSha === action.ref);
  fail(authorization.mainSha === env.GITHUB_SHA);
  fail(FULL_SHA.test(authorization.reviewedSha ?? '') && authorization.reviewedSha === action.reviewedSha);
  fail(authorization.runId === normalizeId(action.runId));
  fail(authorization.runAttempt === '1' && authorization.runAttempt === action.runAttempt);
  fail(normalizeLogin(authorization.actor) === actor);
  fail(normalizeLogin(authorization.triggeringActor) === triggeringActor);
  fail(actor !== EXPECTED_PRODUCTION_REVIEWER && triggeringActor !== EXPECTED_PRODUCTION_REVIEWER);
  fail(isRecord(authorization.ci));
  safeInteger(authorization.ci.id);
  safeInteger(authorization.ci.attempt);
  fail(FULL_SHA.test(authorization.ci.headSha ?? '') && authorization.ci.headSha === authorization.mainSha);
  validateStoredApproval(authorization.approval, actor, triggeringActor);
  return authorization;
}

export async function authorizeProductionRun({
  env = process.env,
  cwd = process.cwd(),
  fetchImpl = fetch,
  execute = execFileSync,
  requireApproval = true,
  sourceValidator = validateReleaseSource,
} = {}) {
  let action;
  try {
    action = validateActionEnvironment(env, { requireToken: true });
    fail(typeof fetchImpl === 'function' && typeof execute === 'function');
    fail(typeof sourceValidator === 'function');
    fail(FULL_SHA.test(action.ref ?? '') && FULL_SHA.test(action.reviewedSha ?? ''));
    fail(action.confirmation === 'true');
    fail(normalizeId(action.repositoryId) === String(T21RC2_REPOSITORY_ID));
    fail(action.repository === T21RC2_REPOSITORY);
    normalizeLogin(action.actor);
    normalizeLogin(action.triggeringActor);
    normalizeId(action.runId);
  } catch {
    throw gateError();
  }

  const token = env.GH_TOKEN;
  const mainSha = gitOutput(execute, cwd, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    'refs/remotes/origin/main^{commit}',
  ]);
  const currentMainSha = await fetchCurrentMainSha(fetchImpl, token);
  fail(currentMainSha === action.ref && currentMainSha === mainSha);
  const runUrl = `${API_BASE}/actions/runs/${encodeURIComponent(normalizeId(action.runId))}`;
  const { body: run } = await getGitHubJson(fetchImpl, runUrl, token, 'T21RC2_GATE_REJECTED');
  const ciRuns = await fetchCompleteCiRuns(fetchImpl, action.ref, token);
  const gate = validateT21RC2Gate({ ...action, run, mainSha, ciRuns, cwd, sourceValidator });
  if (!requireApproval) return gate;

  const environmentUrl = `${API_BASE}/environments/production`;
  const { body: environment } = await getGitHubJson(
    fetchImpl,
    environmentUrl,
    token,
    'T21RC2_APPROVAL_REJECTED',
  );
  const history = await fetchApprovalHistory(fetchImpl, gate.runId, token);
  const approval = validateProductionApproval({
    history,
    environment,
    actor: gate.actor,
    triggeringActor: gate.triggeringActor,
  });
  return { ...gate, approval };
}

function requireImmutableAuthorizationMatch(original, fresh) {
  const fields = [
    'schemaVersion',
    'repositoryId',
    'repository',
    'mainSha',
    'reviewedSha',
    'runId',
    'runAttempt',
    'actor',
    'triggeringActor',
  ];
  fail(fields.every((field) => original[field] === fresh[field]), 'T21RC2_APPROVAL_REJECTED');
  fail(
    canonicalJson(original.ci) === canonicalJson(fresh.ci) &&
      canonicalJson(original.approval) === canonicalJson(fresh.approval),
    'T21RC2_APPROVAL_REJECTED',
  );
}

export async function runT21RC2ApprovalCommand(command, {
  env = process.env,
  cwd = process.cwd(),
  fetchImpl = fetch,
  execute = execFileSync,
  sourceValidator = validateReleaseSource,
} = {}) {
  const common = { env, cwd, fetchImpl, execute, sourceValidator };
  if (command === 'gate') {
    const gate = await authorizeProductionRun({ ...common, requireApproval: false });
    fail(typeof env.GITHUB_OUTPUT === 'string' && path.isAbsolute(env.GITHUB_OUTPUT));
    fail(FULL_SHA.test(gate.mainSha));
    try {
      appendFileSync(env.GITHUB_OUTPUT, `candidate_sha=${gate.mainSha}\n`);
    } catch {
      throw gateError();
    }
    return { candidateSha: gate.mainSha };
  }
  if (command === 'approve') {
    const authorization = await authorizeProductionRun({ ...common, requireApproval: true });
    requireStoredAuthorizationBinding(authorization, env);
    writePrivateJson('authorization.json', authorization, env, cwd);
    return authorization;
  }
  if (command === 'recheck') {
    const stored = readPrivateJson('authorization.json', env, cwd);
    requireStoredAuthorizationBinding(stored, env);
    const fresh = await authorizeProductionRun({ ...common, requireApproval: true });
    requireStoredAuthorizationBinding(fresh, env);
    requireImmutableAuthorizationMatch(stored, fresh);
    writePrivateJson('authorization-final.json', fresh, env, cwd);
    return fresh;
  }
  throw gateError();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runT21RC2ApprovalCommand(process.argv[2]).catch((error) => {
    recordT21RC2Failure(error);
    console.error(safeT21RC2Error(error));
    process.exitCode = 1;
  });
}
