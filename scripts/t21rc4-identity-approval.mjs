#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const T21RC4I_APPROVAL_REJECTED = 'T21RC4I_APPROVAL_REJECTED';
export const T21RC4I_REPOSITORY = 'vn-tak/Tako-san';
export const T21RC4I_REPOSITORY_ID = 1385308553;
export const T21RC4I_REVIEWER = 'vn-taphoanhatung';
export const T21RC4I_REVIEWER_ID = '329713999';
const ENVIRONMENT_ID = '22649920074';
const REVIEWER_RULE_ID = '66577771';
const WORKFLOW_PATH = '.github/workflows/production-d1-identity-diagnostic.yml';
const API_BASE = `https://api.github.com/repos/${T21RC4I_REPOSITORY}`;
const API_VERSION = '2026-03-10';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const PAGE_SIZE = 100;
const FULL_SHA = /^[a-f0-9]{40}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

const reject = () => { throw new Error(T21RC4I_APPROVAL_REJECTED); };
const requireValue = (condition) => { if (!condition) reject(); };
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function id(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  requireValue(typeof value === 'string' && /^[1-9][0-9]*$/.test(value));
  requireValue(Number.isSafeInteger(Number(value)));
  return value;
}

function login(value) {
  requireValue(typeof value === 'string' && GITHUB_LOGIN.test(value));
  return value.toLowerCase();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function bypassUsed(record) {
  return Object.entries(record).some(([key, value]) =>
    /bypass/i.test(key) && value !== false && value !== null && value !== undefined && value !== 0 && value !== '');
}

export function normalizeProductionPolicy(environment) {
  try {
    requireValue(isRecord(environment) && environment.name === 'production');
    requireValue(id(environment.id) === ENVIRONMENT_ID);
    requireValue(environment.can_admins_bypass === true);
    requireValue(environment.wait_timer === undefined || environment.wait_timer === null);
    requireValue(environment.deployment_branch_policy === null);
    requireValue(Array.isArray(environment.protection_rules) && environment.protection_rules.length === 1);
    const rule = environment.protection_rules[0];
    requireValue(isRecord(rule) && !bypassUsed(rule));
    requireValue(rule.type === 'required_reviewers' && id(rule.id) === REVIEWER_RULE_ID);
    requireValue(rule.prevent_self_review === false);
    requireValue(Array.isArray(rule.reviewers) && rule.reviewers.length === 1);
    const entry = rule.reviewers[0];
    requireValue(isRecord(entry) && entry.type === 'User' && isRecord(entry.reviewer));
    requireValue(login(entry.reviewer.login) === T21RC4I_REVIEWER);
    requireValue(id(entry.reviewer.id) === T21RC4I_REVIEWER_ID);
    return {
      environmentId: ENVIRONMENT_ID, name: 'production', canAdminsBypass: true,
      waitTimer: null, deploymentBranchPolicy: null,
      protectionRules: [{ id: REVIEWER_RULE_ID, type: 'required_reviewers', preventSelfReview: false,
        reviewers: [{ type: 'User', id: T21RC4I_REVIEWER_ID, login: T21RC4I_REVIEWER }] }],
    };
  } catch {
    reject();
  }
}

export function validateProductionApproval({ environment, history, actor, triggeringActor,
  actorId, triggeringActorId } = {}) {
  try {
    const policy = normalizeProductionPolicy(environment);
    const workflowActor = login(actor);
    const triggerActor = login(triggeringActor);
    requireValue(workflowActor !== T21RC4I_REVIEWER && triggerActor !== T21RC4I_REVIEWER);
    requireValue(id(actorId) !== T21RC4I_REVIEWER_ID && id(triggeringActorId) !== T21RC4I_REVIEWER_ID);
    requireValue(Array.isArray(history) && history.length === 1);
    const approval = history[0];
    requireValue(isRecord(approval) && !bypassUsed(approval) && approval.state === 'approved');
    requireValue(isRecord(approval.user) && approval.user.type === 'User');
    requireValue(login(approval.user.login) === T21RC4I_REVIEWER);
    requireValue(id(approval.user.id) === T21RC4I_REVIEWER_ID);
    requireValue(Array.isArray(approval.environments) && approval.environments.length === 1);
    const approvedEnvironment = approval.environments[0];
    requireValue(isRecord(approvedEnvironment) && approvedEnvironment.name === 'production');
    requireValue(id(approvedEnvironment.id) === policy.environmentId);
    return { environment: 'production', state: 'approved', reviewer: T21RC4I_REVIEWER,
      reviewerId: T21RC4I_REVIEWER_ID, policySha256: digest(policy),
      historySha256: digest({ approval: {
        state: 'approved', reviewer: T21RC4I_REVIEWER, reviewerId: T21RC4I_REVIEWER_ID,
        environmentId: policy.environmentId,
      }, actor: workflowActor, actorId: id(actorId), triggeringActor: triggerActor,
      triggeringActorId: id(triggeringActorId) }) };
  } catch {
    reject();
  }
}

function actionContext(env) {
  requireValue(isRecord(env) && env.GITHUB_EVENT_NAME === 'workflow_dispatch');
  requireValue(env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_RUN_ATTEMPT === '1');
  requireValue(id(env.GITHUB_REPOSITORY_ID) === String(T21RC4I_REPOSITORY_ID));
  requireValue(env.GITHUB_REPOSITORY === T21RC4I_REPOSITORY);
  requireValue(FULL_SHA.test(env.C4I_REF ?? '') && env.GITHUB_SHA === env.C4I_REF);
  requireValue(FULL_SHA.test(env.C4I_REVIEWED_SHA ?? '') && env.C4I_REVIEWED_SHA !== env.C4I_REF);
  requireValue(env.C4I_GATE_MAIN_SHA === env.C4I_REF);
  requireValue(env.C4I_GATE_REVIEWED_SHA === env.C4I_REVIEWED_SHA);
  requireValue(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0
    && env.GH_TOKEN.trim() === env.GH_TOKEN);
  const actor = login(env.GITHUB_ACTOR);
  const triggeringActor = login(env.GITHUB_TRIGGERING_ACTOR);
  requireValue(actor !== T21RC4I_REVIEWER && triggeringActor !== T21RC4I_REVIEWER);
  return { runId: id(env.GITHUB_RUN_ID), actor, triggeringActor, ref: env.C4I_REF };
}

async function githubJson(fetchImpl, url, token) {
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION }, signal: AbortSignal.timeout(15_000) });
    requireValue(response?.status === 200 && response.ok === true && response.redirected === false);
    const length = response.headers?.get?.('content-length');
    if (length !== null && length !== undefined) {
      requireValue(/^\d+$/.test(length) && Number(length) <= MAX_RESPONSE_BYTES);
    }
    requireValue(typeof response.body?.getReader === 'function');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      requireValue(value instanceof Uint8Array);
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        reject();
      }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    return { body, link: response.headers.get('link') };
  } catch {
    reject();
  }
}

function validateRun(run, context) {
  requireValue(isRecord(run) && id(run.id) === context.runId);
  requireValue(run.run_attempt === 1 && run.event === 'workflow_dispatch');
  requireValue(run.head_sha === context.ref && run.head_branch === 'main');
  requireValue(run.path === WORKFLOW_PATH);
  for (const repository of [run.repository, run.head_repository]) {
    requireValue(isRecord(repository) && repository.full_name === T21RC4I_REPOSITORY);
    requireValue(id(repository.id) === String(T21RC4I_REPOSITORY_ID));
  }
  requireValue(isRecord(run.actor) && isRecord(run.triggering_actor));
  requireValue(login(run.actor.login) === context.actor);
  requireValue(login(run.triggering_actor.login) === context.triggeringActor);
  requireValue(id(run.actor.id) !== T21RC4I_REVIEWER_ID);
  requireValue(id(run.triggering_actor.id) !== T21RC4I_REVIEWER_ID);
  return { actorId: run.actor.id, triggeringActorId: run.triggering_actor.id };
}

export async function authorizeT21RC4IApproval({ env = process.env, fetchImpl = fetch } = {}) {
  try {
    const context = actionContext(env);
    requireValue(typeof fetchImpl === 'function');
    const token = env.GH_TOKEN;
    const { body: run } = await githubJson(fetchImpl,
      `${API_BASE}/actions/runs/${encodeURIComponent(context.runId)}`, token);
    const actorIds = validateRun(run, context);
    const { body: environment } = await githubJson(fetchImpl,
      `${API_BASE}/environments/production`, token);
    const historyUrl = new URL(`${API_BASE}/actions/runs/${encodeURIComponent(context.runId)}/approvals`);
    historyUrl.searchParams.set('per_page', String(PAGE_SIZE));
    historyUrl.searchParams.set('page', '1');
    const { body: history, link } = await githubJson(fetchImpl, historyUrl.href, token);
    requireValue(Array.isArray(history) && history.length < PAGE_SIZE && !link);
    const proof = validateProductionApproval({ environment, history, actor: context.actor,
      triggeringActor: context.triggeringActor, ...actorIds });
    const { body: main } = await githubJson(fetchImpl, `${API_BASE}/commits/main`, token);
    requireValue(isRecord(main) && FULL_SHA.test(main.sha ?? '') && main.sha === context.ref);
    return proof;
  } catch {
    reject();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    console.error(T21RC4I_APPROVAL_REJECTED);
    process.exitCode = 1;
  } else {
    authorizeT21RC4IApproval().then((proof) => {
      console.log(JSON.stringify(proof));
    }).catch(() => {
      console.error(T21RC4I_APPROVAL_REJECTED);
      process.exitCode = 1;
    });
  }
}
