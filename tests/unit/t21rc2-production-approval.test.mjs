import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EXPECTED_PRODUCTION_REVIEWER,
  T21RC2_REPOSITORY,
  T21RC2_REPOSITORY_ID,
  T21RC2_REVIEW_BOUND_PATHS,
  T21RC2_WORKFLOW_PATH,
  assertReviewedExecutionClosure,
  authorizeProductionRun,
  requireStoredAuthorizationBinding,
  runT21RC2ApprovalCommand,
  validateProductionApproval,
  validateT21RC2Gate,
} from '../../scripts/t21rc2-production-approval.mjs';
import { buildT21RC2FailureReceipt, readPrivateJson, writePrivateJson } from '../../scripts/t21rc2-production-files.mjs';
import { runT21RC2CaptureCommand } from '../../scripts/t21rc2-production-capture.mjs';
import { validateReleaseSource } from '../../scripts/release-check.mjs';

const WORKFLOW_CI = '.github/workflows/ci.yml';
const TEST_ACTOR = 'dispatch-user';
const RUN_ID = '12345';
let fixtureRoot;
let cwd;
let baselineSha;
let reviewedSha;
let mainSha;
let sideSha;
let advancedMainSha;
let sourceValidator;
let contextCounter = 0;

function git(...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commit(file, contents, message) {
  mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  writeFileSync(path.join(cwd, file), contents);
  git('add', file);
  git('-c', 'user.name=T21RC2 Test', '-c', 'user.email=t21rc2-test@example.invalid', 'commit', '--quiet', '-m', message);
  return git('rev-parse', 'HEAD');
}

function ciRun(sha = mainSha, overrides = {}) {
  return {
    id: 400,
    run_attempt: 1,
    head_sha: sha,
    head_branch: 'main',
    event: 'push',
    path: WORKFLOW_CI,
    status: 'completed',
    conclusion: 'success',
    repository: { full_name: T21RC2_REPOSITORY },
    head_repository: { full_name: T21RC2_REPOSITORY },
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function runMetadata(overrides = {}) {
  return {
    id: Number(RUN_ID),
    run_attempt: 1,
    head_sha: mainSha,
    head_branch: 'main',
    event: 'workflow_dispatch',
    path: T21RC2_WORKFLOW_PATH,
    repository: { id: T21RC2_REPOSITORY_ID, full_name: T21RC2_REPOSITORY },
    head_repository: { id: T21RC2_REPOSITORY_ID, full_name: T21RC2_REPOSITORY },
    actor: { login: TEST_ACTOR },
    triggering_actor: { login: TEST_ACTOR },
    ...overrides,
  };
}

function gateInput(overrides = {}) {
  return {
    ref: mainSha,
    reviewedSha,
    confirmation: true,
    repositoryId: String(T21RC2_REPOSITORY_ID),
    repository: T21RC2_REPOSITORY,
    actor: TEST_ACTOR,
    triggeringActor: TEST_ACTOR,
    runId: RUN_ID,
    runAttempt: '1',
    run: runMetadata(),
    mainSha,
    ciRuns: [ciRun()],
    cwd,
    sourceValidator,
    ...overrides,
  };
}

function approvalEnvironment(overrides = {}) {
  return {
    id: 801,
    name: 'production',
    can_admins_bypass: true,
    protection_rules: [
      {
        id: 802,
        type: 'required_reviewers',
        prevent_self_review: false,
        reviewers: [
          {
            type: 'User',
            reviewer: { id: 803, login: EXPECTED_PRODUCTION_REVIEWER },
          },
        ],
      },
    ],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: false },
    ...overrides,
  };
}

function approvalEntry(overrides = {}) {
  return {
    state: 'approved',
    user: { id: 803, type: 'User', login: EXPECTED_PRODUCTION_REVIEWER },
    environments: [{ id: 801, name: 'production' }],
    comment: 'SECRET_APPROVAL_COMMENT',
    ...overrides,
  };
}

function authorizationProof() {
  const gate = validateT21RC2Gate(gateInput());
  const approval = validateProductionApproval({
    history: [approvalEntry()],
    environment: approvalEnvironment(),
    actor: gate.actor,
    triggeringActor: gate.triggeringActor,
  });
  return { ...gate, approval };
}

function actionContext(label = 'test') {
  const runnerTemp = path.join(fixtureRoot, `runner-${label}-${contextCounter++}`);
  mkdirSync(runnerTemp);
  const githubOutput = path.join(runnerTemp, 'github-output');
  writeFileSync(githubOutput, '');
  return {
    GITHUB_REPOSITORY_ID: String(T21RC2_REPOSITORY_ID),
    GITHUB_REPOSITORY: T21RC2_REPOSITORY,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: mainSha,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_ACTOR: TEST_ACTOR,
    GITHUB_TRIGGERING_ACTOR: TEST_ACTOR,
    GITHUB_RUN_ID: RUN_ID,
    GITHUB_RUN_ATTEMPT: '1',
    RELEASE_REF: mainSha,
    REVIEWED_SHA: reviewedSha,
    CONFIRM_T21RC_READ_ONLY_CAPTURE: 'true',
    GH_TOKEN: 'MOCK_GITHUB_READ_TOKEN',
    RUNNER_TEMP: runnerTemp,
    GITHUB_OUTPUT: githubOutput,
  };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function apiFetch({
  currentMainSha = mainSha,
  run = runMetadata(),
  ciPages = [{ total_count: 1, workflow_runs: [ciRun()] }],
  environment = approvalEnvironment(),
  history = [approvalEntry()],
  responseOverrides = {},
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    const key = `${parsed.pathname}${parsed.search}`;
    if (parsed.pathname.endsWith('/commits/main')) {
      return responseOverrides.main ?? jsonResponse({ sha: currentMainSha });
    }
    if (parsed.pathname.endsWith(`/actions/runs/${RUN_ID}/approvals`)) {
      return responseOverrides.approvals ?? jsonResponse(history);
    }
    if (parsed.pathname.endsWith(`/actions/runs/${RUN_ID}`)) {
      return responseOverrides.run ?? jsonResponse(run);
    }
    if (parsed.pathname.endsWith('/environments/production')) {
      return responseOverrides.environment ?? jsonResponse(environment);
    }
    if (parsed.pathname.endsWith('/actions/workflows/ci.yml/runs')) {
      const page = Number(parsed.searchParams.get('page'));
      const body = ciPages[page - 1];
      if (!body) throw new Error('Unexpected CI pagination request');
      return responseOverrides[`ci-${page}`] ?? jsonResponse(body, {
        headers: body.next ? { link: body.next } : {},
      });
    }
    throw new Error(`Unexpected mocked route: ${key}`);
  };
  return { fetchImpl, calls };
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(path.join(tmpdir(), 't21rc2-production-approval-'));
  cwd = path.join(fixtureRoot, 'repo');
  mkdirSync(cwd);
  execFileSync('git', ['init', '--initial-branch=main', '--quiet'], { cwd });
  execFileSync('git', ['config', 'user.name', 'T21RC2 Test'], { cwd });
  execFileSync('git', ['config', 'user.email', 't21rc2-test@example.invalid'], { cwd });
  for (const file of T21RC2_REVIEW_BOUND_PATHS) {
    const fixtureFile = file === 'migrations' ? 'migrations/0001_reviewed_fixture.sql' : file;
    mkdirSync(path.dirname(path.join(cwd, fixtureFile)), { recursive: true });
    writeFileSync(path.join(cwd, fixtureFile), `reviewed fixture for ${file}\n`);
  }
  git('add', '--', ...T21RC2_REVIEW_BOUND_PATHS);
  baselineSha = commit('fixture.txt', 'baseline\n', 'baseline');
  git('checkout', '--quiet', '-b', 'reviewed-implementation');
  reviewedSha = commit('fixture.txt', 'reviewed\n', 'reviewed change');
  git('checkout', '--quiet', 'main');
  commit('main-doc.md', 'unrelated main documentation\n', 'main documentation');
  git('merge', '--no-ff', '--quiet', 'reviewed-implementation', '-m', 'protected feature merge');
  mainSha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', mainSha);
  git('checkout', '--quiet', '-b', 'unreviewed', baselineSha);
  sideSha = commit('fixture.txt', 'side\n', 'unreviewed side commit');
  git('checkout', '--quiet', '-b', 'advanced-main', mainSha);
  advancedMainSha = commit('fixture.txt', 'advanced main\n', 'advance main');
  git('checkout', '--quiet', 'main');
  sourceValidator = (args) => validateReleaseSource({ ...args, baselineSha });
});

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

describe('T21R-C2 repository and exact-main gate', () => {
  it('binds the transferred repository name to the unchanged repository ID', () => {
    expect(T21RC2_REPOSITORY).toBe('vn-tak/Tako-san');
    expect(T21RC2_REPOSITORY_ID).toBe(1385308553);
  });

  it('reuses release source ancestry validation and exact-main successful CI', () => {
    const proof = validateT21RC2Gate(gateInput());
    expect(proof).toEqual({
      schemaVersion: 1,
      repositoryId: T21RC2_REPOSITORY_ID,
      repository: T21RC2_REPOSITORY,
      mainSha,
      reviewedSha,
      runId: RUN_ID,
      runAttempt: '1',
      actor: TEST_ACTOR,
      triggeringActor: TEST_ACTOR,
      ci: { id: 400, attempt: 1, headSha: mainSha },
    });
  });

  it('rejects a reviewed SHA that is not an ancestor of current main', () => {
    expect(() => validateT21RC2Gate(gateInput({ reviewedSha: sideSha }))).toThrow('T21RC2_GATE_REJECTED');
  });

  it.each([
    ['repository id', { repositoryId: '1' }],
    ['repository name', { repository: 'vn-tak/other' }],
    ['former repository name', { repository: 'vn-tako4/Tako-san' }],
    ['former run repository despite unchanged id', () => ({ run: runMetadata({ repository: { id: T21RC2_REPOSITORY_ID, full_name: 'vn-tako4/Tako-san' } }) })],
    ['former CI repository', () => ({ ciRuns: [ciRun(mainSha, { repository: { full_name: 'vn-tako4/Tako-san' }, head_repository: { full_name: 'vn-tako4/Tako-san' } })] })],
    ['uppercase SHA', () => ({ ref: mainSha.toUpperCase() })],
    ['stale main SHA', () => ({ mainSha: reviewedSha })],
    ['missing confirmation', { confirmation: false }],
    ['rerun attempt', () => ({ runAttempt: '2', run: runMetadata({ run_attempt: 2 }) })],
    ['wrong workflow event', () => ({ run: runMetadata({ event: 'push' }) })],
    ['wrong workflow path', () => ({ run: runMetadata({ path: '.github/workflows/other.yml' }) })],
    ['wrong run identity', () => ({ run: runMetadata({ id: 999 }) })],
    ['actor metadata mismatch', () => ({ run: runMetadata({ actor: { login: 'other-user' } }) })],
    ['no exact-main CI', { ciRuns: [] }],
    ['failed latest exact-main CI', () => ({ ciRuns: [ciRun(mainSha, { conclusion: 'failure' })] })],
    ['unrelated CI ref', () => ({ ciRuns: [ciRun(reviewedSha)] })],
  ])('fails closed for %s', (_label, buildOverrides) => {
    const overrides = typeof buildOverrides === 'function' ? buildOverrides() : buildOverrides;
    expect(() => validateT21RC2Gate(gateInput(overrides))).toThrow('T21RC2_GATE_REJECTED');
  });
});

describe('T21R-C2 reviewed execution closure (real Git objects)', () => {
  function candidateInput(sha) {
    return gateInput({ ref: sha, mainSha: sha, run: runMetadata({ head_sha: sha }), ciRuns: [ciRun(sha)] });
  }

  function candidateContext(sha, label) {
    return { ...actionContext(label), GITHUB_SHA: sha, RELEASE_REF: sha };
  }

  function candidateApi(sha) {
    return apiFetch({ currentMainSha: sha, run: runMetadata({ head_sha: sha }), ciPages: [{ total_count: 1, workflow_runs: [ciRun(sha)] }] });
  }

  async function changedCandidate(file, callback) {
    git('checkout', '--quiet', '--detach', mainSha);
    try {
      const fixtureFile = file === 'migrations' ? 'migrations/0001_reviewed_fixture.sql' : file;
      const changedSha = commit(fixtureFile, `PRIVATE_CHANGED_FILE_CONTENT ${file}\n`, 'change reviewed execution bytes');
      git('update-ref', 'refs/remotes/origin/main', changedSha);
      return await callback(changedSha);
    } finally {
      git('checkout', '--quiet', 'main');
      git('update-ref', 'refs/remotes/origin/main', mainSha);
    }
  }

  it('allows the protected merge and later unrelated docs commit with its own exact-main CI', () => {
    expect(git('rev-list', '--parents', '-n', '1', mainSha).split(' ')).toHaveLength(3);
    expect(git('merge-base', '--is-ancestor', reviewedSha, mainSha)).toBe('');
    expect(() => assertReviewedExecutionClosure(reviewedSha, mainSha, { cwd })).not.toThrow();
    git('update-ref', 'refs/remotes/origin/main', advancedMainSha);
    try {
      expect(validateT21RC2Gate(candidateInput(advancedMainSha)).mainSha).toBe(advancedMainSha);
      expect(() => validateT21RC2Gate({ ...candidateInput(advancedMainSha), ciRuns: [ciRun(mainSha)] })).toThrow('T21RC2_GATE_REJECTED');
    } finally {
      git('update-ref', 'refs/remotes/origin/main', mainSha);
    }
  });

  it.each(T21RC2_REVIEW_BOUND_PATHS)('rejects unreviewed changes to %s despite ancestry and green exact-main CI', async (file) => {
    await changedCandidate(file, (changedSha) => {
      expect(git('merge-base', '--is-ancestor', reviewedSha, changedSha)).toBe('');
      expect(() => assertReviewedExecutionClosure(reviewedSha, changedSha, { cwd })).toThrow('T21RC2_REVIEW_BINDING_REJECTED');
      expect(() => validateT21RC2Gate(candidateInput(changedSha))).toThrow('T21RC2_REVIEW_BINDING_REJECTED');
    });
  });

  it('rejects a workflow delta that changes only one immutable Action pin', () => {
    git('checkout', '--quiet', '--detach', mainSha);
    try {
      const pinnedWorkflow = readFileSync(T21RC2_WORKFLOW_PATH, 'utf8');
      const reviewedPinsSha = commit(T21RC2_WORKFLOW_PATH, pinnedWorkflow, 'review immutable Action pins');
      const changedWorkflow = pinnedWorkflow.replace(/actions\/checkout@[a-f0-9]{40}/, `actions/checkout@${'f'.repeat(40)}`);
      expect(changedWorkflow).not.toBe(pinnedWorkflow);
      const changedPinSha = commit(T21RC2_WORKFLOW_PATH, changedWorkflow, 'change one immutable pin');
      expect(git('merge-base', '--is-ancestor', reviewedPinsSha, changedPinSha)).toBe('');
      expect(() => assertReviewedExecutionClosure(reviewedPinsSha, changedPinSha, { cwd })).toThrow('T21RC2_REVIEW_BINDING_REJECTED');
    } finally {
      git('checkout', '--quiet', 'main');
    }
  });

  it('rejects equality, unresolved SHAs and shell-like arguments without exposing them', () => {
    expect(() => validateT21RC2Gate(gateInput({ reviewedSha: mainSha }))).toThrow('T21RC2_REVIEW_BINDING_REJECTED');
    for (const invalid of [mainSha, '0'.repeat(40), 'main; PRIVATE_PHYSICAL_ID_123', mainSha.toUpperCase()]) {
      let error;
      try { assertReviewedExecutionClosure(invalid, mainSha, { cwd }); } catch (caught) { error = caught; }
      expect(error?.code).toBe('T21RC2_REVIEW_BINDING_REJECTED');
      const failure = buildT21RC2FailureReceipt(error);
      expect(failure.reason).toBe('T21RC2_REVIEW_BINDING_REJECTED');
      expect(JSON.stringify(failure)).not.toContain('PRIVATE_PHYSICAL_ID_123');
    }
    expect(Object.isFrozen(T21RC2_REVIEW_BOUND_PATHS)).toBe(true);
    expect(new Set(T21RC2_REVIEW_BOUND_PATHS).size).toBe(T21RC2_REVIEW_BOUND_PATHS.length);
  });

  it('rejects a missing mandatory reviewed file even when both commit snapshots omit it', () => {
    git('checkout', '--quiet', '--detach', mainSha);
    try {
      git('rm', '--quiet', '--', T21RC2_WORKFLOW_PATH);
      git('commit', '--quiet', '-m', 'missing reviewed workflow');
      const missingReviewedSha = git('rev-parse', 'HEAD');
      const candidate = commit('unrelated-doc.md', 'only documentation\n', 'unrelated docs');
      expect(() => assertReviewedExecutionClosure(missingReviewedSha, candidate, { cwd })).toThrow('T21RC2_REVIEW_BINDING_REJECTED');
    } finally {
      git('checkout', '--quiet', 'main');
    }
  });

  it('allows an absent optional config but rejects introducing an unreviewed auto-loaded config', () => {
    git('checkout', '--quiet', '--detach', mainSha);
    try {
      git('rm', '--quiet', '--', '.npmrc');
      git('commit', '--quiet', '-m', 'reviewed configuration absence');
      const reviewedWithoutConfig = git('rev-parse', 'HEAD');
      const docsOnly = commit('unrelated-doc.md', 'documentation only\n', 'unrelated docs');
      expect(() => assertReviewedExecutionClosure(reviewedWithoutConfig, docsOnly, { cwd })).not.toThrow();
      const configAdded = commit('.npmrc', 'unreviewed configuration\n', 'unreviewed config addition');
      expect(() => assertReviewedExecutionClosure(reviewedWithoutConfig, configAdded, { cwd })).toThrow('T21RC2_REVIEW_BINDING_REJECTED');
    } finally {
      git('checkout', '--quiet', 'main');
    }
  });

  it('rejects adding a later migration anywhere in the reviewed migration tree', async () => {
    await changedCandidate('migrations/0040_unreviewed_fixture.sql', (sha) => {
      expect(() => validateT21RC2Gate(candidateInput(sha))).toThrow('T21RC2_REVIEW_BINDING_REJECTED');
    });
  });

  it('blocks the gate before production approval and before emitting a candidate output', async () => {
    await changedCandidate(T21RC2_WORKFLOW_PATH, async (sha) => {
      const env = candidateContext(sha, 'bound-gate');
      const api = candidateApi(sha);
      await expect(runT21RC2ApprovalCommand('gate', { env, cwd, fetchImpl: api.fetchImpl, sourceValidator })).rejects.toThrow('T21RC2_REVIEW_BINDING_REJECTED');
      expect(api.calls.some(({ url }) => url.pathname.includes('/environments/') || url.pathname.endsWith('/approvals'))).toBe(false);
      expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe('');
    });
  });

  it('blocks capture reauthorization before any Cloudflare subprocess when reviewed bytes changed', async () => {
    const stored = authorizationProof();
    await changedCandidate('scripts/t21rc2-production-capture.mjs', async (sha) => {
      const env = candidateContext(sha, 'bound-capture');
      writePrivateJson('authorization.json', { ...stored, mainSha: sha, ci: { ...stored.ci, headSha: sha } }, env, cwd);
      const api = candidateApi(sha);
      const cloudflareCalls = [];
      const execute = (command, args, options) => {
        if (command === 'pnpm') {
          cloudflareCalls.push(args);
          throw new Error('Cloudflare execution forbidden in this regression');
        }
        return execFileSync(command, args, options);
      };
      await expect(runT21RC2CaptureCommand('capture', {
        env, cwd, execute,
        authorize: (options) => authorizeProductionRun({ ...options, fetchImpl: api.fetchImpl, sourceValidator }),
      })).rejects.toThrow('T21RC2_REVIEW_BINDING_REJECTED');
      expect(cloudflareCalls).toHaveLength(0);
      expect(existsSync(path.join(env.RUNNER_TEMP, 't21rc2', 'capture-a.json'))).toBe(false);
    });
  });

  it('rechecks byte binding again before producing final authorization for aggregate publication', async () => {
    const stored = authorizationProof();
    await changedCandidate('scripts/t21rc2-production-approval.mjs', async (sha) => {
      const env = candidateContext(sha, 'bound-final');
      writePrivateJson('authorization.json', { ...stored, mainSha: sha, ci: { ...stored.ci, headSha: sha } }, env, cwd);
      const api = candidateApi(sha);
      await expect(runT21RC2ApprovalCommand('recheck', { env, cwd, fetchImpl: api.fetchImpl, sourceValidator })).rejects.toThrow('T21RC2_REVIEW_BINDING_REJECTED');
      expect(existsSync(path.join(env.RUNNER_TEMP, 't21rc2', 'authorization-final.json'))).toBe(false);
    });
  });
});

describe('normal production environment approval', () => {
  it('accepts the independent configured User reviewer and returns only digests', () => {
    expect(approvalEntry()).not.toHaveProperty('id');
    const proof = validateProductionApproval({
      history: [approvalEntry()],
      environment: approvalEnvironment(),
      actor: TEST_ACTOR,
      triggeringActor: TEST_ACTOR,
    });
    expect(proof).toMatchObject({
      environment: 'production',
      state: 'approved',
      reviewer: EXPECTED_PRODUCTION_REVIEWER,
      actor: TEST_ACTOR,
    });
    expect(proof.historySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(proof.policySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(proof)).not.toContain('SECRET_APPROVAL_COMMENT');
  });

  it('accepts either admin-bypass availability setting and includes it in the policy digest', () => {
    const enabled = validateProductionApproval({
      history: [approvalEntry()],
      environment: approvalEnvironment({ can_admins_bypass: true }),
      actor: TEST_ACTOR,
      triggeringActor: TEST_ACTOR,
    });
    const disabled = validateProductionApproval({
      history: [approvalEntry()],
      environment: approvalEnvironment({ can_admins_bypass: false }),
      actor: TEST_ACTOR,
      triggeringActor: TEST_ACTOR,
    });
    expect(enabled.state).toBe('approved');
    expect(disabled.state).toBe('approved');
    expect(enabled.policySha256).not.toBe(disabled.policySha256);
  });

  it.each([
    ['missing history', { history: [] }],
    ['skipped history', { history: [approvalEntry({ state: 'skipped' })] }],
    ['wrong reviewer', { history: [approvalEntry({ user: { id: 901, type: 'User', login: 'other-user' } })] }],
    ['wrong reviewer account id', { history: [approvalEntry({ user: { id: 999, type: 'User', login: EXPECTED_PRODUCTION_REVIEWER } })] }],
    ['wrong environment name', { history: [approvalEntry({ environments: [{ id: 801, name: 'staging' }] })] }],
    ['wrong environment id', { history: [approvalEntry({ environments: [{ id: 999, name: 'production' }] })] }],
    ['wrong environment policy', { environment: approvalEnvironment({ name: 'staging' }) }],
    ['extra required reviewer', {
      environment: approvalEnvironment({
        protection_rules: [
          ...approvalEnvironment().protection_rules,
          { id: 804, type: 'required_reviewers', prevent_self_review: true, reviewers: [] },
        ],
      }),
    }],
    ['team reviewer policy', {
      environment: approvalEnvironment({
        protection_rules: [{
          id: 802,
          type: 'required_reviewers',
          prevent_self_review: false,
          reviewers: [{ type: 'Team', reviewer: { id: 803, login: EXPECTED_PRODUCTION_REVIEWER } }],
        }],
      }),
    }],
    ['approval bypass marker', { history: [approvalEntry({ bypassed: true })] }],
    ['admin bypass history marker', { history: [approvalEntry({ admin_bypass: true })] }],
    ['multiple approval records', { history: [approvalEntry(), approvalEntry()] }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => validateProductionApproval({
      history: overrides.history ?? [approvalEntry()],
      environment: overrides.environment ?? approvalEnvironment(),
      actor: TEST_ACTOR,
      triggeringActor: TEST_ACTOR,
    })).toThrow('T21RC2_APPROVAL_REJECTED');
  });

  it.each(['actor', 'triggeringActor'])('rejects approval by the workflow %s', (field) => {
    expect(() => validateProductionApproval({
      history: [approvalEntry()],
      environment: approvalEnvironment(),
      actor: field === 'actor' ? EXPECTED_PRODUCTION_REVIEWER : TEST_ACTOR,
      triggeringActor: field === 'triggeringActor' ? EXPECTED_PRODUCTION_REVIEWER : TEST_ACTOR,
    })).toThrow('T21RC2_APPROVAL_REJECTED');
  });

  it('changes the policy digest if the configured reviewer identity changes', () => {
    const original = validateProductionApproval({
      history: [approvalEntry()],
      environment: approvalEnvironment(),
      actor: TEST_ACTOR,
      triggeringActor: TEST_ACTOR,
    });
    const changedEnvironment = approvalEnvironment({
      protection_rules: [{
        ...approvalEnvironment().protection_rules[0],
        reviewers: [{
          type: 'User',
          reviewer: { id: 999, login: EXPECTED_PRODUCTION_REVIEWER },
        }],
      }],
    });
    const changed = validateProductionApproval({
      history: [approvalEntry({ user: { id: 999, type: 'User', login: EXPECTED_PRODUCTION_REVIEWER } })],
      environment: changedEnvironment,
      actor: TEST_ACTOR,
      triggeringActor: TEST_ACTOR,
    });
    expect(changed.policySha256).not.toBe(original.policySha256);
  });

  it('changes the policy digest when admin-bypass availability changes without rejecting approval', () => {
    const original = validateProductionApproval({
      history: [approvalEntry()],
      environment: approvalEnvironment({ can_admins_bypass: true }),
      actor: TEST_ACTOR,
      triggeringActor: TEST_ACTOR,
    });
    const changed = validateProductionApproval({
      history: [approvalEntry()],
      environment: approvalEnvironment({ can_admins_bypass: false }),
      actor: TEST_ACTOR,
      triggeringActor: TEST_ACTOR,
    });
    expect(original.state).toBe('approved');
    expect(changed.state).toBe('approved');
    expect(changed.policySha256).not.toBe(original.policySha256);
  });
});

describe('stored authorization binding', () => {
  it('binds an approved proof to the exact Actions context and main CI SHA', () => {
    const env = actionContext();
    const proof = authorizationProof();
    expect(requireStoredAuthorizationBinding(proof, env)).toBe(proof);
  });

  it('validates stored proof without requiring a GitHub token in credential-free consumers', () => {
    const env = actionContext();
    delete env.GH_TOKEN;
    expect(requireStoredAuthorizationBinding(authorizationProof(), env).mainSha).toBe(mainSha);
  });

  it.each([
    ['repository id', { GITHUB_REPOSITORY_ID: '1' }],
    ['repository name', { GITHUB_REPOSITORY: 'vn-tako4/other' }],
  ])('rejects a stored proof in another Actions %s', (_label, override) => {
    expect(() => requireStoredAuthorizationBinding(authorizationProof(), {
      ...actionContext(),
      ...override,
    })).toThrow('T21RC2_GATE_REJECTED');
  });

  it.each([
    ['different run', (proof) => ({ ...proof, runId: '99999' }), 'T21RC2_GATE_REJECTED'],
    ['different ref', (proof) => ({ ...proof, mainSha: reviewedSha }), 'T21RC2_GATE_REJECTED'],
    ['different reviewed SHA', (proof) => ({ ...proof, reviewedSha: mainSha }), 'T21RC2_GATE_REJECTED'],
    ['non-main CI', (proof) => ({ ...proof, ci: { ...proof.ci, headSha: reviewedSha } }), 'T21RC2_GATE_REJECTED'],
    ['invalid history digest', (proof) => ({ ...proof, approval: { ...proof.approval, historySha256: 'unsafe' } }), 'T21RC2_APPROVAL_REJECTED'],
    ['self reviewer', (proof) => ({
      ...proof,
      actor: EXPECTED_PRODUCTION_REVIEWER,
      triggeringActor: EXPECTED_PRODUCTION_REVIEWER,
      approval: { ...proof.approval, actor: EXPECTED_PRODUCTION_REVIEWER },
    }), 'T21RC2_GATE_REJECTED'],
  ])('rejects a stored proof with %s', (_label, mutate, code) => {
    expect(() => requireStoredAuthorizationBinding(mutate(authorizationProof()), actionContext())).toThrow(
      code,
    );
  });
});

describe('read-only GitHub authorization flow', () => {
  it('binds run metadata, exact-main CI and normal approval using mocked GETs only', async () => {
    const env = actionContext();
    const api = apiFetch();
    const gitCalls = [];
    const execute = (file, args, options) => {
      gitCalls.push({ file, args });
      return execFileSync(file, args, options);
    };
    const authorization = await authorizeProductionRun({
      env,
      cwd,
      fetchImpl: api.fetchImpl,
      execute,
      sourceValidator,
    });
    expect(authorization).toMatchObject({
      mainSha,
      reviewedSha,
      runId: RUN_ID,
      runAttempt: '1',
      approval: { reviewer: EXPECTED_PRODUCTION_REVIEWER, state: 'approved' },
    });
    expect(Object.keys(authorization.ci)).toEqual(['id', 'attempt', 'headSha']);
    expect(api.calls.map(({ url }) => url.pathname)).toEqual([
      `/repos/${T21RC2_REPOSITORY}/commits/main`,
      `/repos/${T21RC2_REPOSITORY}/actions/runs/${RUN_ID}`,
      `/repos/${T21RC2_REPOSITORY}/actions/workflows/ci.yml/runs`,
      `/repos/${T21RC2_REPOSITORY}/environments/production`,
      `/repos/${T21RC2_REPOSITORY}/actions/runs/${RUN_ID}/approvals`,
    ]);
    expect(api.calls.every(({ options }) => options.method === 'GET' && options.redirect === 'error')).toBe(true);
    expect(api.calls.every(({ options }) => options.headers.Authorization === `Bearer ${env.GH_TOKEN}`)).toBe(true);
    expect(gitCalls).toEqual([{
      file: 'git',
      args: ['rev-parse', '--verify', '--end-of-options', 'refs/remotes/origin/main^{commit}'],
    }]);
    expect(JSON.stringify(authorization)).not.toContain(env.GH_TOKEN);
  });

  it('omits approval endpoints when called as the credential-free gate', async () => {
    const env = actionContext('gate-only');
    const api = apiFetch();
    const result = await authorizeProductionRun({
      env,
      cwd,
      fetchImpl: api.fetchImpl,
      sourceValidator,
      requireApproval: false,
    });
    expect(result).not.toHaveProperty('approval');
    expect(api.calls.map(({ url }) => url.pathname)).toEqual([
      `/repos/${T21RC2_REPOSITORY}/commits/main`,
      `/repos/${T21RC2_REPOSITORY}/actions/runs/${RUN_ID}`,
      `/repos/${T21RC2_REPOSITORY}/actions/workflows/ci.yml/runs`,
    ]);
  });

  it('rejects remote main advancing beyond cached origin/main before run checks', async () => {
    expect(git('rev-parse', 'refs/remotes/origin/main')).toBe(mainSha);
    expect(git('merge-base', '--is-ancestor', mainSha, advancedMainSha)).toBe('');
    const env = actionContext('advanced-main');
    const api = apiFetch({ currentMainSha: advancedMainSha });
    const gitCalls = [];
    const execute = (file, args, options) => {
      gitCalls.push({ file, args });
      return execFileSync(file, args, options);
    };

    await expect(authorizeProductionRun({
      env,
      cwd,
      fetchImpl: api.fetchImpl,
      execute,
      sourceValidator,
    })).rejects.toMatchObject({ message: 'T21RC2_GATE_REJECTED' });
    expect(api.calls.map(({ url }) => url.pathname)).toEqual([
      `/repos/${T21RC2_REPOSITORY}/commits/main`,
    ]);
    expect(gitCalls).toEqual([{
      file: 'git',
      args: ['rev-parse', '--verify', '--end-of-options', 'refs/remotes/origin/main^{commit}'],
    }]);
  });

  it('rejects a malformed fresh-main response before run checks', async () => {
    const env = actionContext('malformed-main');
    const api = apiFetch({ responseOverrides: { main: jsonResponse({ sha: 'not-a-full-sha' }) } });
    await expect(authorizeProductionRun({
      env,
      cwd,
      fetchImpl: api.fetchImpl,
      sourceValidator,
      requireApproval: false,
    })).rejects.toMatchObject({ message: 'T21RC2_GATE_REJECTED' });
    expect(api.calls.map(({ url }) => url.pathname)).toEqual([
      `/repos/${T21RC2_REPOSITORY}/commits/main`,
    ]);
  });

  it.each([
    ['non-main workflow ref', { GITHUB_REF: 'refs/heads/other' }],
    ['non-manual event', { GITHUB_EVENT_NAME: 'push' }],
    ['mismatched event SHA', { GITHUB_SHA: reviewedSha }],
    ['rerun attempt', { GITHUB_RUN_ATTEMPT: '2' }],
    ['missing confirmation', { CONFIRM_T21RC_READ_ONLY_CAPTURE: 'false' }],
    ['missing API token', { GH_TOKEN: undefined }],
  ])('rejects %s before making API requests', async (_label, override) => {
    const env = { ...actionContext('bad-context'), ...override };
    const api = apiFetch();
    await expect(authorizeProductionRun({
      env,
      cwd,
      fetchImpl: api.fetchImpl,
      sourceValidator,
      requireApproval: false,
    })).rejects.toMatchObject({ message: 'T21RC2_GATE_REJECTED' });
    expect(api.calls).toHaveLength(0);
  });

  it('follows complete bounded CI pagination before selecting exact-main success', async () => {
    const env = actionContext('paged-ci');
    const pageOneRuns = Array.from({ length: 100 }, (_value, index) => ciRun(mainSha, {
      id: index + 1,
      updated_at: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`,
    }));
    const pageOne = {
      total_count: 101,
      workflow_runs: pageOneRuns,
      next: '<https://api.github.com/page=2>; rel="next", <https://api.github.com/page=2>; rel="last"',
    };
    const pageTwo = {
      total_count: 101,
      workflow_runs: [ciRun(mainSha, { id: 101, updated_at: '2026-01-01T00:01:00Z' })],
    };
    const api = apiFetch({ ciPages: [pageOne, pageTwo] });
    const result = await authorizeProductionRun({
      env,
      cwd,
      fetchImpl: api.fetchImpl,
      sourceValidator,
      requireApproval: false,
    });
    expect(result.ci.id).toBe(101);
    expect(api.calls.filter(({ url }) => url.pathname.endsWith('/ci.yml/runs')).map(
      ({ url }) => url.searchParams.get('page'),
    )).toEqual(['1', '2']);
  });

  it('fails closed when CI pagination is incomplete or inconsistent', async () => {
    const env = actionContext('incomplete-ci');
    const api = apiFetch({ ciPages: [{ total_count: 2, workflow_runs: [ciRun()] }] });
    await expect(authorizeProductionRun({
      env,
      cwd,
      fetchImpl: api.fetchImpl,
      sourceValidator,
      requireApproval: false,
    })).rejects.toMatchObject({ message: 'T21RC2_GATE_REJECTED' });
  });

  it('rejects malformed API JSON and approval history pagination', async () => {
    const env = actionContext('malformed-api');
    const malformedRun = apiFetch({
      responseOverrides: { run: new Response('{malformed', { status: 200 }) },
    });
    await expect(authorizeProductionRun({
      env,
      cwd,
      fetchImpl: malformedRun.fetchImpl,
      sourceValidator,
      requireApproval: false,
    })).rejects.toMatchObject({ message: 'T21RC2_GATE_REJECTED' });

    const pagedHistory = apiFetch({
      responseOverrides: {
        approvals: jsonResponse([approvalEntry()], {
          headers: { link: '<https://api.github.com/page=2>; rel="next"' },
        }),
      },
    });
    await expect(authorizeProductionRun({
      env,
      cwd,
      fetchImpl: pagedHistory.fetchImpl,
      sourceValidator,
    })).rejects.toMatchObject({ message: 'T21RC2_APPROVAL_REJECTED' });
  });

  it('rejects reruns, redirects, and API failures without exposing response data', async () => {
    const env = actionContext('hostile-api');
    const rerunApi = apiFetch({ run: runMetadata({ run_attempt: 2 }) });
    await expect(authorizeProductionRun({
      env,
      cwd,
      fetchImpl: rerunApi.fetchImpl,
      sourceValidator,
      requireApproval: false,
    })).rejects.toMatchObject({ message: 'T21RC2_GATE_REJECTED' });

    const redirectApi = apiFetch({
      responseOverrides: { run: new Response('SECRET_RESPONSE_BODY', { status: 302 }) },
    });
    await expect(authorizeProductionRun({
      env,
      cwd,
      fetchImpl: redirectApi.fetchImpl,
      sourceValidator,
      requireApproval: false,
    })).rejects.toMatchObject({ message: 'T21RC2_GATE_REJECTED' });

    const failureApi = async () => {
      throw new Error('SECRET_NETWORK_ERROR');
    };
    await expect(authorizeProductionRun({
      env,
      cwd,
      fetchImpl: failureApi,
      sourceValidator,
      requireApproval: false,
    })).rejects.toMatchObject({ message: 'T21RC2_GATE_REJECTED' });
  });

  it('does not accept a bypassed or malformed approval API response', async () => {
    const env = actionContext('approval-api-failure');
    const api = apiFetch({
      responseOverrides: {
        approvals: jsonResponse([approvalEntry({ state: 'skipped' })]),
      },
    });
    await expect(authorizeProductionRun({
      env,
      cwd,
      fetchImpl: api.fetchImpl,
      sourceValidator,
    })).rejects.toMatchObject({ message: 'T21RC2_APPROVAL_REJECTED' });
  });
});

describe('runner-local approval CLI lifecycle', () => {
  it('writes only candidate_sha for gate and keeps authorization private to approve/recheck', async () => {
    const env = actionContext('cli-lifecycle');
    const api = apiFetch();
    const result = await runT21RC2ApprovalCommand('gate', {
      env,
      cwd,
      fetchImpl: api.fetchImpl,
      sourceValidator,
    });
    expect(result).toEqual({ candidateSha: mainSha });
    expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe(`candidate_sha=${mainSha}\n`);
    expect(existsSync(path.join(env.RUNNER_TEMP, 't21rc2'))).toBe(false);

    const approveApi = apiFetch();
    await runT21RC2ApprovalCommand('approve', {
      env,
      cwd,
      fetchImpl: approveApi.fetchImpl,
      sourceValidator,
    });
    const authorization = readPrivateJson('authorization.json', env, cwd);
    expect(authorization.approval.reviewer).toBe(EXPECTED_PRODUCTION_REVIEWER);
    const authPath = path.join(env.RUNNER_TEMP, 't21rc2', 'authorization.json');
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
    const authorizationBytes = readFileSync(authPath, 'utf8');

    const recheckApi = apiFetch();
    await runT21RC2ApprovalCommand('recheck', {
      env,
      cwd,
      fetchImpl: recheckApi.fetchImpl,
      sourceValidator,
    });
    const finalAuthorization = readPrivateJson('authorization-final.json', env, cwd);
    expect(JSON.stringify(finalAuthorization)).toBe(JSON.stringify(authorization));
    expect(readFileSync(authPath, 'utf8')).toBe(authorizationBytes);
    expect(finalAuthorization.approval.historySha256).toBe(authorization.approval.historySha256);
    expect(finalAuthorization.approval.policySha256).toBe(authorization.approval.policySha256);
  });

  it('blocks recheck if review history is skipped', async () => {
    const env = actionContext('changed-history');
    await runT21RC2ApprovalCommand('approve', {
      env,
      cwd,
      fetchImpl: apiFetch().fetchImpl,
      sourceValidator,
    });
    const changedApi = apiFetch({ history: [approvalEntry({ state: 'skipped' })] });
    await expect(runT21RC2ApprovalCommand('recheck', {
      env,
      cwd,
      fetchImpl: changedApi.fetchImpl,
      sourceValidator,
    })).rejects.toMatchObject({ message: 'T21RC2_APPROVAL_REJECTED' });
    expect(existsSync(path.join(env.RUNNER_TEMP, 't21rc2', 'authorization-final.json'))).toBe(false);
  });

  it('blocks recheck when environment reviewer policy changes', async () => {
    const env = actionContext('changed-policy');
    await runT21RC2ApprovalCommand('approve', {
      env,
      cwd,
      fetchImpl: apiFetch().fetchImpl,
      sourceValidator,
    });
    const changedEnvironment = approvalEnvironment({
      protection_rules: [{
        ...approvalEnvironment().protection_rules[0],
        prevent_self_review: true,
      }],
    });
    await expect(runT21RC2ApprovalCommand('recheck', {
      env,
      cwd,
      fetchImpl: apiFetch({ environment: changedEnvironment }).fetchImpl,
      sourceValidator,
    })).rejects.toMatchObject({ message: 'T21RC2_APPROVAL_REJECTED' });
    expect(existsSync(path.join(env.RUNNER_TEMP, 't21rc2', 'authorization-final.json'))).toBe(false);
  });

  it('detects admin-bypass availability changes through the policy digest', async () => {
    const env = actionContext('changed-admin-bypass-availability');
    await runT21RC2ApprovalCommand('approve', {
      env,
      cwd,
      fetchImpl: apiFetch({ environment: approvalEnvironment({ can_admins_bypass: true }) }).fetchImpl,
      sourceValidator,
    });
    const recheck = apiFetch({ environment: approvalEnvironment({ can_admins_bypass: false }) });
    await expect(runT21RC2ApprovalCommand('recheck', {
      env,
      cwd,
      fetchImpl: recheck.fetchImpl,
      sourceValidator,
    })).rejects.toMatchObject({ message: 'T21RC2_APPROVAL_REJECTED' });
    expect(existsSync(path.join(env.RUNNER_TEMP, 't21rc2', 'authorization-final.json'))).toBe(false);
  });
});
