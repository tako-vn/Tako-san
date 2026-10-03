import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const C4I_REPOSITORY = 'vn-tak/Tako-san';
export const C4I_REPOSITORY_ID = '1385308553';
export const C4I_WORKFLOW = '.github/workflows/production-d1-identity-diagnostic.yml';
export const C4I_BOUND_PATHS = Object.freeze([
  C4I_WORKFLOW,
  '.github/workflows/ci.yml',
  'scripts/t21rc4-cloudflare-identity-diagnostic.mjs',
  'scripts/t21rc4-identity-gate.mjs',
  'scripts/t21rc4-identity-approval.mjs',
  'package.json',
  'pnpm-lock.yaml',
  'wrangler.jsonc',
  '.npmrc',
  '.pnpmfile.cjs',
  'pnpm-workspace.yaml',
  '.gitattributes',
]);
const OPTIONAL_PATHS = new Set(['.npmrc', '.pnpmfile.cjs', 'pnpm-workspace.yaml', '.gitattributes']);
const SHA = /^[0-9a-f]{40}$/;
const POSITIVE_ID = /^[1-9][0-9]*$/;
const API_BASE = `https://api.github.com/repos/${C4I_REPOSITORY}`;
const PAGE_SIZE = 100;
const MAX_CI_RUNS = 1000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const gateError = () => new Error('T21RC4I_GATE_REJECTED');
const bindingError = () => new Error('T21RC4I_REVIEW_BINDING_REJECTED');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const check = (condition, error = gateError) => { if (!condition) throw error(); };
const id = (value) => {
  const normalized = String(value);
  check(POSITIVE_ID.test(normalized) && Number.isSafeInteger(Number(normalized)));
  return normalized;
};
const gitOptions = (cwd) => ({ cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });

export function assertC4IReviewBinding(reviewedSha, ref, { cwd = process.cwd(), execute = execFileSync } = {}) {
  try {
    check(SHA.test(reviewedSha ?? '') && SHA.test(ref ?? '') && reviewedSha !== ref, bindingError);
    for (const sha of [reviewedSha, ref]) {
      const actual = execute('git', ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`], gitOptions(cwd)).trim();
      check(actual === sha, bindingError);
    }
    execute('git', ['merge-base', '--is-ancestor', reviewedSha, ref], gitOptions(cwd));
    for (const file of C4I_BOUND_PATHS) {
      const reviewed = execute('git', ['ls-tree', reviewedSha, '--', file], gitOptions(cwd)).trim();
      const released = execute('git', ['ls-tree', ref, '--', file], gitOptions(cwd)).trim();
      check(reviewed === released, bindingError);
      if (!OPTIONAL_PATHS.has(file)) check(/^100(?:644|755) blob [0-9a-f]{40}\t/.test(reviewed), bindingError);
      else check(reviewed === '' || /^100(?:644|755) blob [0-9a-f]{40}\t/.test(reviewed), bindingError);
    }
  } catch {
    throw bindingError();
  }
}

async function githubJson(url, token, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    check(response?.status === 200 && response.ok === true && response.redirected === false);
    const length = response.headers?.get?.('content-length');
    if (length !== null && length !== undefined) check(/^\d+$/.test(length) && Number(length) <= MAX_RESPONSE_BYTES);
    check(typeof response.body?.getReader === 'function');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      check(value instanceof Uint8Array);
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw gateError();
      }
      chunks.push(value);
    }
    return { body: JSON.parse(Buffer.concat(chunks, size).toString('utf8')), link: response.headers?.get?.('link') };
  } catch {
    throw gateError();
  }
}

function nextPage(link) {
  return typeof link === 'string' && /;\s*rel\s*=\s*"?next"?/i.test(link);
}

async function completeCiRuns(ref, token, fetchImpl) {
  const runs = [];
  let total;
  let pages;
  for (let page = 1; page <= (pages ?? 1); page += 1) {
    const url = new URL(`${API_BASE}/actions/workflows/ci.yml/runs`);
    for (const [key, value] of Object.entries({ event: 'push', branch: 'main', head_sha: ref, per_page: String(PAGE_SIZE), page: String(page) })) {
      url.searchParams.set(key, value);
    }
    const { body, link } = await githubJson(url.href, token, fetchImpl);
    check(isRecord(body) && Array.isArray(body.workflow_runs));
    check(Number.isSafeInteger(body.total_count) && body.total_count >= 0);
    if (total === undefined) {
      total = body.total_count;
      check(total <= MAX_CI_RUNS);
      pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    } else check(body.total_count === total);
    const expected = Math.min(PAGE_SIZE, Math.max(0, total - (page - 1) * PAGE_SIZE));
    check(body.workflow_runs.length === expected && nextPage(link) === (page < pages));
    runs.push(...body.workflow_runs);
  }
  check(runs.length === total && new Set(runs.map((run) => id(run?.id))).size === runs.length);
  return runs;
}

export function requireExactMainCi(runs, ref) {
  check(Array.isArray(runs) && SHA.test(ref ?? ''));
  const matching = runs.filter((run) => {
    check(isRecord(run));
    id(run.id);
    return run.event === 'push' && run.head_branch === 'main' && run.head_sha === ref &&
      run.path === '.github/workflows/ci.yml' &&
      run.repository?.full_name === C4I_REPOSITORY && String(run.repository?.id) === C4I_REPOSITORY_ID &&
      run.head_repository?.full_name === C4I_REPOSITORY && String(run.head_repository?.id) === C4I_REPOSITORY_ID;
  });
  check(matching.length > 0);
  matching.sort((a, b) => {
    const updated = (run) => Date.parse(run.updated_at || run.run_started_at || run.created_at) || 0;
    return updated(b) - updated(a) || Number(b.id) - Number(a.id) || b.run_attempt - a.run_attempt;
  });
  const latest = matching[0];
  check(latest.run_attempt === 1 && latest.conclusion === 'success' && latest.status === 'completed');
  return { id: id(latest.id), attempt: 1 };
}

function validateContext(env) {
  check(env.GITHUB_REPOSITORY === C4I_REPOSITORY && env.GITHUB_REPOSITORY_ID === C4I_REPOSITORY_ID);
  check(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/main');
  check(env.GITHUB_RUN_ATTEMPT === '1' && env.CONFIRM_METADATA_IDENTITY_DIAGNOSTIC === 'true');
  check(SHA.test(env.C4I_REF ?? '') && SHA.test(env.C4I_REVIEWED_SHA ?? ''));
  check(env.GITHUB_SHA === env.C4I_REF && env.C4I_REF !== env.C4I_REVIEWED_SHA);
  id(env.GITHUB_RUN_ID);
}

export async function runC4IGate({ env = process.env, cwd = process.cwd(), fetchImpl = fetch, execute = execFileSync } = {}) {
  try {
    validateContext(env);
    check(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0 && env.GH_TOKEN.trim() === env.GH_TOKEN);
    const localHead = execute('git', ['rev-parse', '--verify', 'HEAD'], gitOptions(cwd)).trim();
    check(localHead === env.C4I_REF);
    const { body: main } = await githubJson(`${API_BASE}/commits/main`, env.GH_TOKEN, fetchImpl);
    check(isRecord(main) && main.sha === env.C4I_REF);
    const { body: run } = await githubJson(`${API_BASE}/actions/runs/${id(env.GITHUB_RUN_ID)}`, env.GH_TOKEN, fetchImpl);
    check(isRecord(run) && String(run.id) === env.GITHUB_RUN_ID && run.run_attempt === 1);
    check(run.event === 'workflow_dispatch' && run.head_branch === 'main' && run.head_sha === env.C4I_REF);
    check(run.path === C4I_WORKFLOW && run.repository?.full_name === C4I_REPOSITORY && String(run.repository?.id) === C4I_REPOSITORY_ID);
    check(run.head_repository?.full_name === C4I_REPOSITORY && String(run.head_repository?.id) === C4I_REPOSITORY_ID);
    assertC4IReviewBinding(env.C4I_REVIEWED_SHA, env.C4I_REF, { cwd, execute });
    const ci = requireExactMainCi(await completeCiRuns(env.C4I_REF, env.GH_TOKEN, fetchImpl), env.C4I_REF);
    return { mainSha: env.C4I_REF, reviewedSha: env.C4I_REVIEWED_SHA, ciRunId: ci.id, ciAttempt: ci.attempt, repositoryId: C4I_REPOSITORY_ID };
  } catch (error) {
    if (error?.message === 'T21RC4I_REVIEW_BINDING_REJECTED') throw error;
    throw gateError();
  }
}

export function verifyDiagnosticBinding(env = process.env, { cwd = process.cwd(), execute = execFileSync } = {}) {
  try {
    validateContext(env);
    check(env.C4I_GATE_MAIN_SHA === env.C4I_REF && env.C4I_GATE_REVIEWED_SHA === env.C4I_REVIEWED_SHA);
    check(env.C4I_GATE_REPOSITORY_ID === C4I_REPOSITORY_ID);
    check(id(env.C4I_GATE_CI_RUN_ID) === env.C4I_GATE_CI_RUN_ID && env.C4I_GATE_CI_ATTEMPT === '1');
    check(execute('git', ['rev-parse', '--verify', 'HEAD'], gitOptions(cwd)).trim() === env.C4I_REF);
  } catch {
    throw gateError();
  }
}

export async function runC4IGateCommand(command, options = {}) {
  if (command === 'gate') {
    const result = await runC4IGate(options);
    const output = options.env?.GITHUB_OUTPUT ?? process.env.GITHUB_OUTPUT;
    if (typeof output !== 'string' || !path.isAbsolute(output)) throw gateError();
    appendFileSync(output, `main_sha=${result.mainSha}\nreviewed_sha=${result.reviewedSha}\nci_run_id=${result.ciRunId}\nci_attempt=${result.ciAttempt}\nrepository_id=${result.repositoryId}\n`);
    return result;
  }
  if (command === 'bind') return verifyDiagnosticBinding(options.env ?? process.env, options);
  throw gateError();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runC4IGateCommand(process.argv[2]).catch((error) => {
    console.error(error?.message === 'T21RC4I_REVIEW_BINDING_REJECTED' ? error.message : 'T21RC4I_GATE_REJECTED');
    process.exitCode = 1;
  });
}
