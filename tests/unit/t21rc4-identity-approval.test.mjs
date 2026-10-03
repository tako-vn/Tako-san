import { describe, expect, it } from 'vitest';
import {
  authorizeT21RC4IApproval, normalizeProductionPolicy, T21RC4I_APPROVAL_REJECTED,
  validateProductionApproval,
} from '../../scripts/t21rc4-identity-approval.mjs';

const REF = 'a'.repeat(40);
const REVIEWED = 'b'.repeat(40);
const POLICY = {
  id: 22649920074, name: 'production', can_admins_bypass: true,
  deployment_branch_policy: null,
  protection_rules: [{ id: 66577771, type: 'required_reviewers', prevent_self_review: false,
    reviewers: [{ type: 'User', reviewer: { login: 'vn-taphoanhatung', id: 329713999 } }] }],
};
const HISTORY = [{ state: 'approved', user: { type: 'User', login: 'vn-taphoanhatung', id: 329713999 },
  environments: [{ id: 22649920074, name: 'production' }] }];
const RUN = {
  id: 71, run_attempt: 1, event: 'workflow_dispatch', head_sha: REF, head_branch: 'main',
  path: '.github/workflows/production-d1-identity-diagnostic.yml',
  repository: { id: 1385308553, full_name: 'vn-tak/Tako-san' },
  head_repository: { id: 1385308553, full_name: 'vn-tak/Tako-san' },
  actor: { id: 10, login: 'release-operator' },
  triggering_actor: { id: 11, login: 'dispatch-operator' },
};
const ENV = {
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
  GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY_ID: '1385308553',
  GITHUB_REPOSITORY: 'vn-tak/Tako-san', GITHUB_SHA: REF,
  C4I_REF: REF, C4I_REVIEWED_SHA: REVIEWED,
  C4I_GATE_MAIN_SHA: REF, C4I_GATE_REVIEWED_SHA: REVIEWED,
  GITHUB_RUN_ID: '71', GITHUB_ACTOR: 'release-operator',
  GITHUB_TRIGGERING_ACTOR: 'dispatch-operator', GH_TOKEN: 'private-test-token',
};
const clone = (value) => structuredClone(value);
const approvalInputs = () => ({ environment: clone(POLICY), history: clone(HISTORY),
  actor: 'release-operator', triggeringActor: 'dispatch-operator', actorId: 10, triggeringActorId: 11 });
const rejected = (input) => expect(() => validateProductionApproval(input)).toThrow(T21RC4I_APPROVAL_REJECTED);

function apiFixture({ run = RUN, environment = POLICY, history = HISTORY, mainSha = REF,
  status = 200, redirected = false, link = null } = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const body = url.includes('/approvals?') ? history
      : url.endsWith('/environments/production') ? environment
        : url.endsWith('/commits/main') ? { sha: mainSha } : run;
    const response = new Response(JSON.stringify(body), {
      status, headers: link ? { link } : {},
    });
    if (redirected) Object.defineProperty(response, 'redirected', { value: true });
    return response;
  };
  return { requests, fetchImpl };
}

describe('C4I independent Environment approval', () => {
  it('accepts exactly one normal approval and hashes the pinned policy', () => {
    const proof = validateProductionApproval(approvalInputs());
    expect(proof).toMatchObject({ environment: 'production', state: 'approved',
      reviewer: 'vn-taphoanhatung', reviewerId: '329713999' });
    expect(proof.policySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(proof.historySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(proof)).not.toContain('release-operator');
    expect(normalizeProductionPolicy(POLICY).canAdminsBypass).toBe(true);
    expect(normalizeProductionPolicy({ ...POLICY, wait_timer: null })).toEqual(normalizeProductionPolicy(POLICY));
  });

  it('rejects wrong reviewer login or ID even if policy and approval agree', () => {
    for (const mutation of [
      (value) => { value.history[0].user.login = 'someone-else'; },
      (value) => { value.history[0].user.id = 123; },
      (value) => { value.environment.protection_rules[0].reviewers[0].reviewer.login = 'someone-else'; },
      (value) => { value.environment.protection_rules[0].reviewers[0].reviewer.id = 123; },
    ]) {
      const value = approvalInputs(); mutation(value); rejected(value);
    }
  });

  it.each(['skipped', 'rejected', 'pending'])('rejects %s approval state', (state) => {
    const value = approvalInputs(); value.history[0].state = state; rejected(value);
  });

  it('rejects actual bypass use while permitting policy availability', () => {
    const value = approvalInputs(); value.history[0].admin_bypass = true; rejected(value);
    const ruleValue = approvalInputs(); ruleValue.environment.protection_rules[0].bypass = true;
    rejected(ruleValue);
  });

  it('rejects reviewer as either workflow actor or triggering actor by login or ID', () => {
    for (const change of [
      { actor: 'vn-taphoanhatung' }, { triggeringActor: 'vn-taphoanhatung' },
      { actorId: 329713999 }, { triggeringActorId: 329713999 },
    ]) rejected({ ...approvalInputs(), ...change });
  });

  it('rejects wrong Environment, policy drift, ambiguous history and missing approval', () => {
    for (const mutation of [
      (value) => { value.environment.id = 999; },
      (value) => { value.environment.name = 'staging'; },
      (value) => { value.environment.can_admins_bypass = false; },
      (value) => { value.environment.wait_timer = 1; },
      (value) => { value.environment.deployment_branch_policy = { protected_branches: true }; },
      (value) => { value.environment.protection_rules[0].id = 1; },
      (value) => { value.environment.protection_rules[0].prevent_self_review = true; },
      (value) => { value.environment.protection_rules.push(clone(value.environment.protection_rules[0])); },
      (value) => { value.environment.protection_rules[0].reviewers.push(clone(value.environment.protection_rules[0].reviewers[0])); },
      (value) => { value.history[0].environments[0].name = 'staging'; },
      (value) => { value.history[0].environments[0].id = 999; },
      (value) => { value.history.push(clone(value.history[0])); },
      (value) => { value.history = []; },
    ]) {
      const value = approvalInputs(); mutation(value); rejected(value);
    }
  });

  it('validates this run, policy, history and current main via GitHub', async () => {
    const api = apiFixture();
    const proof = await authorizeT21RC4IApproval({ env: clone(ENV), fetchImpl: api.fetchImpl });
    expect(proof.state).toBe('approved');
    expect(api.requests).toHaveLength(4);
    expect(api.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      '/repos/vn-tak/Tako-san/actions/runs/71',
      '/repos/vn-tak/Tako-san/environments/production',
      '/repos/vn-tak/Tako-san/actions/runs/71/approvals',
      '/repos/vn-tak/Tako-san/commits/main',
    ]);
    for (const { options } of api.requests) {
      expect(options.redirect).toBe('error');
      expect(options.headers['X-GitHub-Api-Version']).toBe('2026-03-10');
      expect(options.headers.Authorization).toBe('Bearer private-test-token');
    }
  });

  it('rejects main moving while production Environment waits', async () => {
    const api = apiFixture({ mainSha: REVIEWED });
    await expect(authorizeT21RC4IApproval({ env: clone(ENV), fetchImpl: api.fetchImpl }))
      .rejects.toThrow(T21RC4I_APPROVAL_REJECTED);
    expect(api.requests).toHaveLength(4);
  });

  it('rejects wrong run metadata, actor identity and reruns', async () => {
    for (const mutation of [
      (run, env) => { run.run_attempt = 2; env.GITHUB_RUN_ATTEMPT = '2'; },
      (run) => { run.actor.id = 329713999; },
      (run) => { run.triggering_actor.id = 329713999; },
      (run) => { run.actor.login = 'vn-taphoanhatung'; },
      (run) => { run.head_sha = REVIEWED; },
      (run) => { run.path = '.github/workflows/other.yml'; },
      (run) => { run.repository.id = 1; },
      (run) => { run.head_repository.full_name = 'other/repo'; },
    ]) {
      const run = clone(RUN); const env = clone(ENV); mutation(run, env);
      const api = apiFixture({ run });
      await expect(authorizeT21RC4IApproval({ env, fetchImpl: api.fetchImpl }))
        .rejects.toThrow(T21RC4I_APPROVAL_REJECTED);
    }
  });

  it('rejects input/gate mismatch before making an API call', async () => {
    for (const change of [
      { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_REPOSITORY_ID: '1' },
      { GITHUB_REPOSITORY: 'other/repo' }, { C4I_GATE_MAIN_SHA: REVIEWED },
      { C4I_GATE_REVIEWED_SHA: REF }, { C4I_REF: REVIEWED },
      { C4I_REVIEWED_SHA: REF }, { GITHUB_SHA: REVIEWED },
      { GITHUB_ACTOR: 'vn-taphoanhatung' },
    ]) {
      const api = apiFixture();
      await expect(authorizeT21RC4IApproval({ env: { ...ENV, ...change }, fetchImpl: api.fetchImpl }))
        .rejects.toThrow(T21RC4I_APPROVAL_REJECTED);
      expect(api.requests).toHaveLength(0);
    }
  });

  it('fails closed on incomplete pagination, redirects and HTTP failure', async () => {
    for (const fixture of [
      { history: Array.from({ length: 100 }, () => clone(HISTORY[0])) },
      { link: '<https://api.github.com/next>; rel="next"' },
      { redirected: true }, { status: 403 },
    ]) {
      const api = apiFixture(fixture);
      await expect(authorizeT21RC4IApproval({ env: clone(ENV), fetchImpl: api.fetchImpl }))
        .rejects.toThrow(T21RC4I_APPROVAL_REJECTED);
    }
  });

  it('rejects responses over the byte limit without leaking provider data', async () => {
    const api = apiFixture({ environment: { ...POLICY, padding: 'sensitive'.repeat(150_000) } });
    await expect(authorizeT21RC4IApproval({ env: clone(ENV), fetchImpl: api.fetchImpl }))
      .rejects.toThrow(T21RC4I_APPROVAL_REJECTED);
  });
});
