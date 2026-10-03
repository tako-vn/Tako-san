import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertC4IReviewBinding,
  C4I_BOUND_PATHS,
  C4I_REPOSITORY,
  C4I_REPOSITORY_ID,
  C4I_WORKFLOW,
  requireExactMainCi,
  runC4IGate,
  verifyDiagnosticBinding,
} from '../../scripts/t21rc4-identity-gate.mjs';

let cwd;
let reviewedSha;
let mainSha;
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (message) => { git('add', '.'); git('commit', '-m', message); return git('rev-parse', 'HEAD'); };
const expectGateRejection = async (promise) => expect(promise).rejects.toThrow('T21RC4I_GATE_REJECTED');

beforeAll(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 't21rc4-gate-'));
  git('init');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  for (const file of C4I_BOUND_PATHS.filter((entry) => !['.npmrc', '.pnpmfile.cjs', 'pnpm-workspace.yaml'].includes(entry))) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), `reviewed ${file}\n`);
  }
  reviewedSha = commit('reviewed C4I');
  mkdirSync(path.join(cwd, 'docs'), { recursive: true });
  writeFileSync(path.join(cwd, 'docs', 'unrelated.md'), 'documentation only\n');
  mainSha = commit('unrelated documentation');
});
afterAll(() => { if (cwd) rmSync(cwd, { recursive: true }); });

const baseEnv = () => ({
  GITHUB_REPOSITORY: C4I_REPOSITORY,
  GITHUB_REPOSITORY_ID: C4I_REPOSITORY_ID,
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_RUN_ID: '8123',
  GITHUB_SHA: mainSha,
  C4I_REF: mainSha,
  C4I_REVIEWED_SHA: reviewedSha,
  CONFIRM_METADATA_IDENTITY_DIAGNOSTIC: 'true',
  GH_TOKEN: 'synthetic-github-token',
});
const validCi = () => ({
  id: 7342, event: 'push', head_branch: 'main', head_sha: mainSha,
  run_attempt: 1, status: 'completed', conclusion: 'success', path: '.github/workflows/ci.yml',
  repository: { full_name: C4I_REPOSITORY, id: Number(C4I_REPOSITORY_ID) },
  head_repository: { full_name: C4I_REPOSITORY, id: Number(C4I_REPOSITORY_ID) },
});
const api = ({ currentMain = mainSha, ciRuns = [validCi()], runPatch = {} } = {}) => async (url, options) => {
  expect(options.redirect).toBe('error');
  expect(options.headers.Authorization).toBe('Bearer synthetic-github-token');
  expect(options.headers['X-GitHub-Api-Version']).toBeTruthy();
  if (url.endsWith('/commits/main')) return new Response(JSON.stringify({ sha: currentMain }), { status: 200 });
  if (url.endsWith('/actions/runs/8123')) return new Response(JSON.stringify({
    id: 8123, run_attempt: 1, event: 'workflow_dispatch', head_branch: 'main', head_sha: mainSha,
    path: C4I_WORKFLOW,
    repository: { full_name: C4I_REPOSITORY, id: Number(C4I_REPOSITORY_ID) },
    head_repository: { full_name: C4I_REPOSITORY, id: Number(C4I_REPOSITORY_ID) },
    ...runPatch,
  }), { status: 200 });
  const parsed = new URL(url);
  expect(parsed.searchParams.get('event')).toBe('push');
  expect(parsed.searchParams.get('branch')).toBe('main');
  expect(parsed.searchParams.get('head_sha')).toBe(mainSha);
  return new Response(JSON.stringify({ total_count: ciRuns.length, workflow_runs: ciRuns }), { status: 200 });
};
const gate = (env = baseEnv(), options = {}) => runC4IGate({ env, cwd, fetchImpl: api(options) });

describe('C4I review-binding gate', () => {
  it('accepts reviewed C4I bytes followed by an unrelated documentation commit', async () => {
    expect(() => assertC4IReviewBinding(reviewedSha, mainSha, { cwd })).not.toThrow();
    await expect(gate()).resolves.toEqual({
      mainSha, reviewedSha, ciRunId: '7342', ciAttempt: 1, repositoryId: C4I_REPOSITORY_ID,
    });
  });
  it('rejects main moving after dispatch', async () => {
    await expectGateRejection(gate(baseEnv(), { currentMain: reviewedSha }));
  });
  it('rejects reviewed SHA equal to ref and a non-ancestor reviewed SHA', () => {
    expect(() => assertC4IReviewBinding(mainSha, mainSha, { cwd })).toThrow('T21RC4I_REVIEW_BINDING_REJECTED');
    git('checkout', '--detach', reviewedSha);
    mkdirSync(path.join(cwd, 'docs'), { recursive: true });
    writeFileSync(path.join(cwd, 'docs', 'unrelated.md'), 'branch sibling\n');
    const sibling = commit('sibling');
    expect(() => assertC4IReviewBinding(sibling, mainSha, { cwd })).toThrow('T21RC4I_REVIEW_BINDING_REJECTED');
    git('checkout', '--detach', mainSha);
  });
  it('rejects every changed C4I execution byte after review', () => {
    for (const file of C4I_BOUND_PATHS) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), `unreviewed ${file}\n`);
      const changed = commit(`change ${file}`);
      expect(() => assertC4IReviewBinding(reviewedSha, changed, { cwd })).toThrow('T21RC4I_REVIEW_BINDING_REJECTED');
    }
    git('checkout', '--detach', mainSha);
  });
  it('rejects missing, failed, PR-only, or rerun CI', () => {
    expect(() => requireExactMainCi([], mainSha)).toThrow('T21RC4I_GATE_REJECTED');
    for (const patch of [
      { conclusion: 'failure' }, { event: 'pull_request' }, { head_sha: reviewedSha },
      { run_attempt: 2 }, { head_branch: 'feature' },
    ]) expect(() => requireExactMainCi([{ ...validCi(), ...patch }], mainSha)).toThrow('T21RC4I_GATE_REJECTED');
  });
  it('rejects wrong repository identity, attempt, and event', async () => {
    for (const patch of [
      { GITHUB_REPOSITORY_ID: '1385308554' }, { GITHUB_REPOSITORY: 'other/Tako-san' },
      { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_EVENT_NAME: 'push' },
    ]) await expectGateRejection(gate({ ...baseEnv(), ...patch }));
  });
  it('binds the diagnostic checkout and gate outputs before credential use', () => {
    const env = { ...baseEnv(), C4I_GATE_MAIN_SHA: mainSha, C4I_GATE_REVIEWED_SHA: reviewedSha,
      C4I_GATE_CI_RUN_ID: '7342', C4I_GATE_CI_ATTEMPT: '1', C4I_GATE_REPOSITORY_ID: C4I_REPOSITORY_ID };
    expect(() => verifyDiagnosticBinding(env, { cwd })).not.toThrow();
    for (const patch of [{ C4I_GATE_MAIN_SHA: reviewedSha }, { C4I_GATE_REPOSITORY_ID: '1' },
      { C4I_GATE_CI_ATTEMPT: '2' }]) {
      expect(() => verifyDiagnosticBinding({ ...env, ...patch }, { cwd })).toThrow('T21RC4I_GATE_REJECTED');
    }
  });
});

describe('C4I GitHub response boundary', () => {
  it('rejects a chunked response exceeding the byte cap before JSON parsing', async () => {
    const fetchImpl = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    }), { status: 200 });
    await expectGateRejection(runC4IGate({ env: baseEnv(), cwd, fetchImpl }));
  });
  it('rejects a newer failed exact-main run even when an older run succeeded', () => {
    const older = { ...validCi(), id: 7342, updated_at: '2026-01-01T00:00:00Z' };
    const newer = { ...validCi(), id: 7343, updated_at: '2026-01-02T00:00:00Z', conclusion: 'failure' };
    expect(() => requireExactMainCi([older, newer], mainSha)).toThrow('T21RC4I_GATE_REJECTED');
  });
});

it('binds every C4I runtime authority file, including optional install hooks', () => {
  expect(C4I_BOUND_PATHS).toEqual([
    '.github/workflows/production-d1-identity-diagnostic.yml',
    '.github/workflows/ci.yml',
    'scripts/t21rc4-cloudflare-identity-diagnostic.mjs',
    'scripts/t21rc4-identity-gate.mjs',
    'scripts/t21rc4-identity-approval.mjs',
    'package.json', 'pnpm-lock.yaml', 'wrangler.jsonc',
    '.npmrc', '.pnpmfile.cjs', 'pnpm-workspace.yaml', '.gitattributes',
  ]);
});
