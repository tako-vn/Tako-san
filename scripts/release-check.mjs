import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The operator-approved final hardening SHA must descend from this reviewed floor.
export const REVIEWED_HARDENING_BASE = 'af661af467ba8620ba6b2919ee958195d179380c';
const SHA = /^[a-f0-9]{40}$/;
export const PRODUCTION_WORKER_IDENTITY = Object.freeze({
  scriptName: 'frigo',
  d1BindingName: 'DB',
  d1DatabaseId: 'f975ec39-b2c8-4a2a-80e1-0366054599d3',
});
/**
 * T19B — reviewed release states for recipe catalog authority (ADR-026). Runtime accepts broader
 * values; only these combinations may be DEPLOYED:
 *
 *   STATIC  mode=static  canaryPercent=0                cutover=false  (rollback baseline)
 *   SHADOW  mode=shadow  canaryPercent=0                cutover=false  (static served, D1 compared off-response)
 *   CANARY  mode=canary  canaryPercent∈{1,2,5,25}       cutover=true   (deterministic household cohort served D1)
 *   D1      mode=d1      canaryPercent=0                cutover=true   (every household served verified D1)
 *
 * Cutover is derived, never an input, so a typo cannot flip authority. Any other combination is
 * rejected here and again at deployment (`recheck`).
 */
export const RELEASE_RECIPE_CATALOG_MODES = ['static', 'shadow', 'canary', 'd1'];
export const RELEASE_CANARY_PERCENT_OPTIONS = [1, 2, 5, 25];
export const RELEASE_CANARY_PERCENT_INPUTS = ['0', ...RELEASE_CANARY_PERCENT_OPTIONS.map(String)];

// T20: one normalized value drives both the Worker var and the build-time UI flag.
// Only an explicit dispatch opt-in enables it; pushes and any other value stay off.
export function resolveMealCompositionV2Release({ eventName, input }) {
  return eventName === 'workflow_dispatch' && input === 'true' ? 'true' : 'false';
}
const USER_VISIBLE_D1_MODES = ['canary', 'd1'];

export function validateRecipeCatalogMode(value) {
  if (!RELEASE_RECIPE_CATALOG_MODES.includes(value)) {
    throw new Error('Release recipe catalog mode must be static, shadow, canary, or d1');
  }
  return value;
}

function normalizeReleaseCanaryPercent(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value))
      throw new Error('Release recipe catalog canary percent must be a canonical integer');
    value = String(value);
  }
  if (typeof value !== 'string' || !/^(0|[1-9]|[1-9][0-9])$/.test(value)) {
    throw new Error('Release recipe catalog canary percent must be a canonical integer');
  }
  const percent = Number(value);
  if (percent > 100)
    throw new Error('Release recipe catalog canary percent must be between 0 and 100');
  return percent;
}

/** Runtime supports broader values; this function is the narrower reviewed deploy authorization. */
export function validateRecipeCatalogRollout({ mode, canaryPercent }) {
  validateRecipeCatalogMode(mode);
  const percent = normalizeReleaseCanaryPercent(canaryPercent);
  if (mode !== 'canary' && percent !== 0) {
    throw new Error(`${mode} release requires canary percent 0`);
  }
  if (mode === 'canary' && !RELEASE_CANARY_PERCENT_OPTIONS.includes(percent)) {
    throw new Error(
      `Canary release percent must be one of ${RELEASE_CANARY_PERCENT_OPTIONS.join(', ')}`,
    );
  }
  return Object.freeze({
    mode,
    canaryPercent: percent,
    cutoverEnabled: USER_VISIBLE_D1_MODES.includes(mode),
  });
}

export function validateRecipeCatalogManifestPolicy(manifest) {
  if (typeof manifest !== 'object' || manifest === null)
    throw new Error('Release manifest is invalid');
  const rollout = validateRecipeCatalogRollout({
    mode: manifest.recipeCatalogMode,
    canaryPercent: manifest.recipeCatalogCanaryPercent,
  });
  if (manifest.recipeCatalogCutoverEnabled !== rollout.cutoverEnabled) {
    throw new Error('Release manifest cutover policy does not match its mode');
  }
  if (
    manifest.recipeCatalogRollbackConfirmed !== undefined &&
    typeof manifest.recipeCatalogRollbackConfirmed !== 'boolean'
  ) {
    throw new Error('Release manifest rollback confirmation must be boolean');
  }
  return rollout;
}

function rolloutState(value) {
  return value.mode === 'canary' ? `canary-${value.canaryPercent}` : value.mode;
}

const FORWARD_RECIPE_CATALOG_TRANSITIONS = new Map([
  ['static', ['shadow']],
  ['shadow', ['canary-1']],
  ['canary-1', ['canary-2', 'canary-5']],
  ['canary-2', ['canary-5']],
  ['canary-5', ['canary-25']],
  ['canary-25', ['d1']],
  ['d1', []],
]);

/** Serial deployment preflight: stale jobs cannot skip or reverse an already deployed stage. */
export function validateRecipeCatalogTransition(manifest, currentEvidence, release, options = {}) {
  if (!SHA.test(manifest?.sha || ''))
    throw new Error('Target release SHA must be a canonical full Git SHA');
  const target = validateRecipeCatalogManifestPolicy(manifest);
  const targetState = rolloutState(target);
  if (currentEvidence?.unavailable === true) {
    if (!['static', 'shadow'].includes(target.mode)) {
      throw new Error(
        'Recipe authority evidence is unavailable; only static or shadow bootstrap is allowed',
      );
    }
    if (manifest.recipeCatalogRollbackConfirmed !== true) {
      throw new Error(
        'Unavailable recipe authority evidence requires explicit rollback/bootstrap confirmation',
      );
    }
    return { from: 'unavailable', to: targetState, kind: 'bootstrap' };
  }
  if (
    typeof currentEvidence !== 'object' ||
    currentEvidence === null ||
    currentEvidence.schemaVersion !== 1
  ) {
    throw new Error('Current recipe authority evidence is invalid');
  }
  if (
    currentEvidence.environment !== manifest.environment ||
    !SHA.test(currentEvidence.commit || '')
  ) {
    throw new Error(
      'Current recipe authority evidence has the wrong environment or commit identity',
    );
  }
  if (currentEvidence.commit !== manifest.sha) {
    const isAncestor =
      options.isAncestor ??
      ((ancestor, descendant) => {
        try {
          git(options.cwd ?? process.cwd(), 'merge-base', '--is-ancestor', ancestor, descendant);
          return true;
        } catch {
          return false;
        }
      });
    if (!isAncestor(currentEvidence.commit, manifest.sha)) {
      throw new Error('Candidate release SHA would move the deployed Worker code backwards');
    }
  }
  const current = validateRecipeCatalogRollout({
    mode: currentEvidence.configuredMode,
    canaryPercent: currentEvidence.canaryPercent,
  });
  if (currentEvidence.cutoverEnabled !== current.cutoverEnabled) {
    throw new Error('Current recipe authority evidence has a contradictory cutover state');
  }
  const currentState = rolloutState(current);
  const currentManifest = {
    sha: currentEvidence.commit,
    environment: manifest.environment,
    recipeCatalogMode: current.mode,
    recipeCatalogCanaryPercent: current.canaryPercent,
    recipeCatalogCutoverEnabled: current.cutoverEnabled,
  };
  if (currentState === targetState) {
    if (USER_VISIBLE_D1_MODES.includes(target.mode) && currentEvidence.commit !== manifest.sha) {
      throw new Error('A new release SHA must restart recipe authority rollout in shadow');
    }
    verifyRecipeAuthorityEvidence(currentManifest, currentEvidence, release);
    return {
      from: currentState,
      to: targetState,
      kind: currentEvidence.commit === manifest.sha ? 'idempotent' : 'release_start',
    };
  }

  const rollback =
    target.mode === 'static' ||
    (target.mode === 'shadow' && !['static', 'shadow'].includes(current.mode));
  if (rollback) {
    if (manifest.recipeCatalogRollbackConfirmed !== true) {
      throw new Error(
        `Recipe authority rollback ${currentState} -> ${targetState} requires explicit confirmation`,
      );
    }
    return { from: currentState, to: targetState, kind: 'rollback' };
  }

  if (current.mode === 'static' && target.mode === 'shadow') {
    verifyRecipeAuthorityEvidence(currentManifest, currentEvidence, release);
    return { from: currentState, to: targetState, kind: 'release_start' };
  }

  if (currentEvidence.commit !== manifest.sha) {
    throw new Error('A new release SHA must restart recipe authority rollout in shadow');
  }
  verifyRecipeAuthorityEvidence(currentManifest, currentEvidence, release);
  if (!(FORWARD_RECIPE_CATALOG_TRANSITIONS.get(currentState) ?? []).includes(targetState)) {
    throw new Error(
      `Recipe authority transition ${currentState} -> ${targetState} is not the next reviewed promotion`,
    );
  }
  return { from: currentState, to: targetState, kind: 'promotion' };
}

export function verifyStableWorkerDeployment(evidence) {
  const versions = evidence?.versions;
  if (
    typeof evidence?.id !== 'string' ||
    evidence.id.length === 0 ||
    !Array.isArray(versions) ||
    versions.length !== 1 ||
    versions[0]?.percentage !== 100 ||
    typeof versions[0]?.version_id !== 'string' ||
    versions[0].version_id.length === 0
  ) {
    throw new Error('Worker must have exactly one stable version at 100% before deployment');
  }
  return {
    versionId: versions[0].version_id,
    deploymentId: evidence.id,
    capturedAt: new Date().toISOString(),
  };
}

export function verifyWorkerD1Binding(
  versionEvidence,
  expected = PRODUCTION_WORKER_IDENTITY,
) {
  if (
    typeof versionEvidence?.id !== 'string' ||
    versionEvidence.id.length === 0 ||
    !Array.isArray(versionEvidence?.resources?.bindings)
  ) {
    throw new Error('Worker version evidence is missing its identity or bindings');
  }
  const d1Bindings = versionEvidence.resources.bindings.filter((binding) => binding?.type === 'd1');
  if (
    d1Bindings.length !== 1 ||
    d1Bindings[0]?.name !== expected.d1BindingName ||
    d1Bindings[0]?.id !== expected.d1DatabaseId
  ) {
    throw new Error('Worker version D1 binding does not match the pinned production database');
  }
  return {
    versionId: versionEvidence.id,
    bindingName: expected.d1BindingName,
    databaseId: expected.d1DatabaseId,
    checkedAt: new Date().toISOString(),
  };
}

export function verifyRollbackTarget(manifest, versionEvidence) {
  const binding = verifyWorkerD1Binding(versionEvidence);
  if (binding.versionId !== manifest.previousDeployment?.versionId) {
    throw new Error('Rollback target binding evidence is not for the exact previous Worker version');
  }
  if (
    manifest.cloudflare?.databaseId !== PRODUCTION_WORKER_IDENTITY.d1DatabaseId ||
    manifest.cloudflare?.databaseName !== 'frigo-db'
  ) {
    throw new Error('Rollback target cannot be joined to the certified production D1 identity');
  }
  return binding;
}

/**
 * A pre-T19 Worker has no `/health/recipe-authority` route, and its global auth middleware answers
 * 401 before routing instead of 404. Accept that 401 as "endpoint unavailable" only when the exact
 * snapshotted Worker version's GIT_COMMIT is an ancestor of the release and provably lacks the route.
 */
export function classifyLegacyRecipeAuthorityEndpoint(
  manifest,
  versionEvidence,
  responseBody,
  options = {},
) {
  if (responseBody?.code === 'RELEASE_VERIFY_UNAUTHORIZED') {
    throw new Error('Recipe authority endpoint rejected RELEASE_VERIFY_TOKEN; token mismatch');
  }
  const binding = verifyWorkerD1Binding(versionEvidence);
  if (!SHA.test(manifest?.sha || '') || binding.versionId !== manifest.previousDeployment?.versionId) {
    throw new Error('Legacy authority classification requires the exact snapshotted Worker version');
  }
  const commit = versionEvidence.resources.bindings.find(
    (entry) => entry?.type === 'plain_text' && entry?.name === 'GIT_COMMIT',
  )?.text;
  if (!SHA.test(commit || '')) {
    throw new Error('Previous Worker GIT_COMMIT must be a canonical full SHA');
  }
  const cwd = options.cwd ?? process.cwd();
  const isAncestor =
    options.isAncestor ??
    ((ancestor, descendant) => {
      try {
        git(cwd, 'merge-base', '--is-ancestor', ancestor, descendant);
        return true;
      } catch {
        return false;
      }
    });
  if (!isAncestor(commit, manifest.sha)) {
    throw new Error('Previous Worker commit is not an ancestor of the release');
  }
  const readHealthRoutes =
    options.readHealthRoutes ??
    ((sha) => {
      try {
        return git(cwd, 'show', `${sha}:src/worker/routes/health.ts`);
      } catch {
        return '';
      }
    });
  if (readHealthRoutes(commit).includes('/health/recipe-authority')) {
    throw new Error('Previous Worker serves the recipe authority endpoint; a 401 is not a legacy gap');
  }
  return { unavailable: true, httpStatus: 401, legacyWorkerCommit: commit };
}

export function verifyDeployedWorker(manifest, deploymentEvidence, versionEvidence) {
  const deployment = verifyStableWorkerDeployment(deploymentEvidence);
  const binding = verifyWorkerD1Binding(versionEvidence);
  if (binding.versionId !== deployment.versionId) {
    throw new Error('Worker binding evidence is not for the active 100% version');
  }
  if (deployment.deploymentId === manifest.previousDeployment?.deploymentId) {
    throw new Error('Deployment proof still identifies the previous deployment');
  }
  if (manifest.cloudflare?.databaseId !== binding.databaseId) {
    throw new Error('Deployed Worker D1 binding does not match the certified production identity');
  }
  return { ...deployment, binding };
}

/**
 * Recipe authority evidence fields that identify one Worker version's served state. `checkedAt`
 * and `counters` vary per request and are excluded.
 */
export const STABLE_RECIPE_AUTHORITY_EVIDENCE_FIELDS = Object.freeze([
  'schemaVersion',
  'environment',
  'commit',
  'configuredMode',
  'cutoverEnabled',
  'canaryPercent',
  'globalSource',
  'releaseId',
  'expectedRecipeCount',
  'selectedSource',
  'actualSource',
  'servedRecipeCount',
  'servedFingerprint',
  'expectedRuntimeFingerprint',
  'fingerprintMatchesRelease',
  'd1Readiness',
  'd1ReadinessCode',
  'fallbackReason',
]);

export function verifyRecipeCatalogRollback(
  manifest,
  deploymentEvidence,
  authorityEvidence,
  versionEvidence,
  mutationEvidence,
) {
  const deployment = verifyStableWorkerDeployment(deploymentEvidence);
  if (deployment.versionId !== manifest.previousDeployment?.versionId) {
    throw new Error('Rollback did not restore the exact previous Worker version');
  }
  if (
    deployment.deploymentId === manifest.previousDeployment?.deploymentId ||
    deployment.deploymentId === manifest.deployedWorker?.deploymentId
  ) {
    throw new Error('Rollback proof must identify a new deployment');
  }
  const binding = verifyWorkerD1Binding(versionEvidence);
  if (binding.versionId !== deployment.versionId) {
    throw new Error('Rollback binding evidence is not for the restored Worker version');
  }
  if (
    mutationEvidence?.versionId !== deployment.versionId ||
    (mutationEvidence.deploymentId !== null &&
      mutationEvidence.deploymentId !== deployment.deploymentId)
  ) {
    throw new Error('Rollback mutation receipt does not match the restored deployment');
  }
  const previous = manifest.previousRecipeAuthority;
  if (previous?.unavailable === true) {
    if (authorityEvidence?.unavailable !== true)
      throw new Error('Rollback did not restore the previous unavailable authority endpoint');
  } else {
    for (const key of STABLE_RECIPE_AUTHORITY_EVIDENCE_FIELDS) {
      if (!Object.hasOwn(previous ?? {}, key))
        throw new Error(`Previous rollback authority evidence is incomplete at ${key}`);
      if (authorityEvidence?.[key] !== previous?.[key])
        throw new Error(`Rollback authority evidence differs at ${key}`);
    }
  }
  return {
    result: 'restored',
    versionId: deployment.versionId,
    deploymentId: deployment.deploymentId,
    binding,
    checkedAt: new Date().toISOString(),
  };
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitIsAncestor(cwd) {
  return (ancestor, descendant) => {
    try {
      git(cwd, 'merge-base', '--is-ancestor', ancestor, descendant);
      return true;
    } catch {
      return false;
    }
  };
}

function requireAncestor(cwd, ancestor, descendant, message) {
  try {
    git(cwd, 'merge-base', '--is-ancestor', ancestor, descendant);
  } catch {
    throw new Error(message);
  }
}

export function validateReleaseSource({
  ref,
  hardenedSha,
  cwd = process.cwd(),
  baselineSha = REVIEWED_HARDENING_BASE,
}) {
  if (!SHA.test(hardenedSha || '') || !SHA.test(baselineSha)) {
    throw new Error('An exact approved hardening SHA is required');
  }
  if (!SHA.test(ref || '') && !/^refs\/tags\/v[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ref || '')) {
    throw new Error('Release ref must be a full SHA or refs/tags/v* release tag, never a branch');
  }
  if (!SHA.test(ref)) git(cwd, 'check-ref-format', ref);
  const sha = git(cwd, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
  const mainSha = git(cwd, 'rev-parse', '--verify', 'refs/remotes/origin/main^{commit}');
  requireAncestor(
    cwd,
    baselineSha,
    hardenedSha,
    'Approved hardening SHA predates the reviewed security baseline',
  );
  requireAncestor(
    cwd,
    hardenedSha,
    sha,
    'Release does not contain the exact approved hardening commit',
  );
  requireAncestor(cwd, sha, mainSha, 'Release is not contained in main');
  if (sha !== mainSha) throw new Error('Release SHA is stale; it must equal current origin/main');
  return { requestedRef: ref, sha, mainSha, hardenedSha, reviewedHardeningBase: baselineSha };
}

export function migrationManifest(cwd, sha) {
  if (!SHA.test(sha)) throw new Error('Migration manifest requires an exact SHA');
  const files = git(cwd, 'ls-tree', '-r', '--name-only', sha, '--', 'migrations')
    .split('\n')
    .filter((file) => file.endsWith('.sql'))
    .sort();
  if (files.length === 0) throw new Error('No migrations found at release SHA');
  const migrations = files.map((file, index) => {
    const name = file.replace(/^migrations\//, '');
    if (!/^\d{4}_[A-Za-z0-9_-]+\.sql$/.test(name) || Number(name.slice(0, 4)) !== index + 1) {
      throw new Error('Migration sequence is malformed, duplicated, or has a gap');
    }
    const bytes = execFileSync('git', ['show', `${sha}:${file}`], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { name, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  return {
    version: migrations.at(-1).name,
    count: migrations.length,
    sha256: createHash('sha256').update(JSON.stringify(migrations)).digest('hex'),
    migrations,
  };
}

export function requireSuccessfulCi(runs, { sha, repository }) {
  if (!Array.isArray(runs)) throw new Error('Hosted CI response is invalid');
  const matching = runs.filter(
    (run) =>
      run.head_sha === sha &&
      run.head_branch === 'main' &&
      run.event === 'push' &&
      run.path === '.github/workflows/ci.yml' &&
      run.repository?.full_name === repository &&
      run.head_repository?.full_name === repository,
  );
  const activityTime = (run) =>
    Date.parse(run.updated_at || run.run_started_at || run.created_at) || 0;
  const latest = matching.sort(
    (a, b) => activityTime(b) - activityTime(a) || b.id - a.id || b.run_attempt - a.run_attempt,
  )[0];
  if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') {
    throw new Error('Latest exact-SHA CI push run on main must be completed and successful');
  }
  return {
    id: latest.id,
    attempt: latest.run_attempt,
    url: latest.html_url,
    headSha: latest.head_sha,
    checkedAt: new Date().toISOString(),
  };
}

async function hostedCi(sha, repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !process.env.GH_TOKEN) {
    throw new Error('Repository-scoped hosted CI read access is required');
  }
  const query = new URLSearchParams({
    event: 'push',
    branch: 'main',
    head_sha: sha,
    per_page: '100',
  });
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs?${query}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    },
  );
  if (!response.ok) throw new Error(`Hosted CI lookup failed (HTTP ${response.status})`);
  return requireSuccessfulCi((await response.json()).workflow_runs, { sha, repository });
}

export function verifyMigrationLedger(schema, statements) {
  if (
    !Array.isArray(statements) ||
    statements.length !== 1 ||
    statements[0]?.success !== true ||
    !Array.isArray(statements[0].results)
  ) {
    throw new Error('Migration ledger query did not return one successful result');
  }
  const names = statements[0].results.map((row) => row.name).sort();
  const expected = schema.migrations.map((migration) => migration.name).sort();
  // Unknown later migrations require an explicit compatibility review, not a blind rollback.
  if (JSON.stringify(names) !== JSON.stringify(expected))
    throw new Error(
      'D1 migration ledger differs from the release; migration/rollback owner review required',
    );
  return { version: schema.version, names, checkedAt: new Date().toISOString() };
}

export const RELEASE_PROPAGATION_PENDING = 'RELEASE_PROPAGATION_PENDING';

/**
 * Exact deployment proof. `readiness.commit` must be a canonical full Git SHA (40 lowercase hex);
 * anything else (missing, short, uppercase, non-string) fails closed. A healthy body in the right
 * environment that reports a *different valid* SHA is the only retryable outcome (the edge may still
 * answer from another release during deployment convergence); `error.code ===
 * RELEASE_PROPAGATION_PENDING` marks it. Nothing here proves which release that SHA belongs to.
 */
export function verifyDeployedRelease(manifest, readiness) {
  if (typeof readiness !== 'object' || readiness === null)
    throw new Error('Readiness response is not an object');
  if (readiness.environment !== manifest.environment) {
    throw new Error('Readiness does not identify the exact approved release SHA/environment');
  }
  if (
    !['ok', 'degraded'].includes(readiness.status) ||
    readiness.services?.database !== 'ok' ||
    readiness.config?.ok !== true
  ) {
    throw new Error('Deployed release is not ready');
  }
  if (typeof readiness.commit !== 'string' || !SHA.test(readiness.commit)) {
    throw new Error('Readiness commit is not a canonical full Git SHA');
  }
  if (readiness.commit !== manifest.sha) {
    const error = new Error(
      'Readiness does not identify the exact approved release SHA/environment',
    );
    error.code = RELEASE_PROPAGATION_PENDING;
    error.observedSha = readiness.commit;
    throw error;
  }
  // Same-SHA promotions only change Worker vars, so the commit cannot tell old and new versions
  // apart; the approved authority state must also be served before the release counts as deployed.
  if (manifest.recipeCatalogMode !== undefined) {
    const authority = readiness.recipeAuthority;
    if (typeof authority !== 'object' || authority === null)
      throw new Error('Readiness recipeAuthority summary is missing');
    const observed = {
      mode: authority.configuredMode,
      canaryPercent: authority.canaryPercent,
      cutoverEnabled: authority.cutoverEnabled,
    };
    const target = {
      mode: manifest.recipeCatalogMode,
      canaryPercent: manifest.recipeCatalogCanaryPercent,
      cutoverEnabled: manifest.recipeCatalogCutoverEnabled,
    };
    if (!sameAuthorityState(observed, target)) {
      if (!isPreviousAuthorityState(manifest, readiness.commit, observed)) {
        throw new Error(
          `Readiness recipe authority ${describeAuthorityState(observed)} is not the approved ${describeAuthorityState(target)} or the pre-deploy state`,
        );
      }
      const error = new Error('Readiness still serves the pre-deploy recipe authority state');
      error.code = RELEASE_PROPAGATION_PENDING;
      error.observedSha = readiness.commit;
      error.observedState = describeAuthorityState(observed);
      throw error;
    }
  }
  return {
    sha: readiness.commit,
    environment: readiness.environment,
    checkedAt: new Date().toISOString(),
  };
}

function sameAuthorityState(a, b) {
  return (
    a.mode === b.mode && a.canaryPercent === b.canaryPercent && a.cutoverEnabled === b.cutoverEnabled
  );
}

function describeAuthorityState(state) {
  return state.mode === 'canary' ? `canary-${state.canaryPercent}` : String(state.mode);
}

/**
 * True only when `observed` is a valid rollout state equal to the state captured by the production
 * preflight for this exact commit (the old Worker version is still answering). Without preflight
 * evidence (staging), any valid state on the approved SHA is treated as not yet converged; the
 * bounded deadline still fails a Worker that never serves the approved state.
 */
function isPreviousAuthorityState(manifest, commit, observed) {
  try {
    const valid = validateRecipeCatalogRollout({
      mode: observed.mode,
      canaryPercent: observed.canaryPercent,
    });
    if (valid.cutoverEnabled !== observed.cutoverEnabled) return false;
  } catch {
    return false;
  }
  const previous = manifest.previousRecipeAuthority;
  if (previous === undefined || previous === null) return true;
  if (previous.unavailable === true || previous.commit !== commit) return false;
  return sameAuthorityState(observed, {
    mode: previous.configuredMode,
    canaryPercent: previous.canaryPercent,
    cutoverEnabled: previous.cutoverEnabled,
  });
}

/**
 * Pre-deploy proof of the Worker currently answering the protected recipe-authority endpoint
 * (staging `previous-authority`). The evidence must be complete, carry a canonical commit that is
 * the release SHA or a Git ancestor of it, and validate against the reviewed catalog release
 * shipped at that same commit. Only this proof lets the post-deploy wait retry evidence from a
 * different commit; it never makes such evidence acceptable.
 */
export function verifyPreviousRecipeAuthority(manifest, evidence, options = {}) {
  if (!SHA.test(manifest?.sha || ''))
    throw new Error('Target release SHA must be a canonical full Git SHA');
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence))
    throw new Error('Previous recipe authority evidence is not an object');
  if (evidence.unavailable === true)
    throw new Error('Previous recipe authority evidence is unavailable');
  if (evidence.schemaVersion !== 1)
    throw new Error('Previous recipe authority evidence schema is not supported');
  if (evidence.environment !== manifest.environment)
    throw new Error('Previous recipe authority evidence is for the wrong environment');
  if (typeof evidence.commit !== 'string' || !SHA.test(evidence.commit))
    throw new Error('Previous recipe authority commit is not a canonical full Git SHA');
  for (const key of STABLE_RECIPE_AUTHORITY_EVIDENCE_FIELDS) {
    if (!Object.hasOwn(evidence, key))
      throw new Error(`Previous recipe authority evidence is incomplete at ${key}`);
  }
  const state = validateRecipeCatalogRollout({
    mode: evidence.configuredMode,
    canaryPercent: evidence.canaryPercent,
  });
  if (evidence.cutoverEnabled !== state.cutoverEnabled)
    throw new Error('Previous recipe authority evidence has a contradictory cutover state');
  const cwd = options.cwd ?? process.cwd();
  const relation = evidence.commit === manifest.sha ? 'same' : 'ancestor';
  if (relation === 'ancestor' && !(options.isAncestor ?? gitIsAncestor(cwd))(evidence.commit, manifest.sha))
    throw new Error('Previous Worker commit is not an ancestor of the release');
  const readRelease = options.readRelease ?? ((sha) => readCatalogReleaseAt(cwd, sha));
  const release = readRelease(evidence.commit);
  const proof = {
    commit: evidence.commit,
    relation,
    configuredMode: state.mode,
    canaryPercent: state.canaryPercent,
    cutoverEnabled: state.cutoverEnabled,
    release: {
      releaseId: release?.releaseId,
      expectedRecipeCount: release?.expectedRecipeCount,
      expectedRuntimeFingerprint: release?.expectedRuntimeFingerprint,
      legacyBaselineCount: release?.legacyBaselineCount,
      legacyBaselineFingerprint: release?.legacyBaselineFingerprint,
    },
  };
  verifyRecipeAuthorityEvidence(previousAuthorityManifest(manifest, proof), evidence, proof.release);
  return { ...proof, checkedAt: new Date().toISOString() };
}

function readCatalogReleaseAt(cwd, sha) {
  let text;
  try {
    text = git(cwd, 'show', `${sha}:${CATALOG_RELEASE_MANIFEST_PATH}`);
  } catch {
    throw new Error('Previous Worker commit has no reviewed catalog release manifest');
  }
  return JSON.parse(text);
}

function previousAuthorityManifest(manifest, proof) {
  return {
    sha: proof.commit,
    environment: manifest.environment,
    recipeCatalogMode: proof.configuredMode,
    recipeCatalogCanaryPercent: proof.canaryPercent,
    recipeCatalogCutoverEnabled: proof.cutoverEnabled,
  };
}

/**
 * Convergence class 2: evidence that is exactly the pre-deploy capture, still answered by the
 * previous Worker version. Returns what to log while retrying, or null to fail closed. Evidence
 * from another commit additionally needs the preflight ancestry/content proof for that commit, and
 * must still validate against that commit's release. Same-SHA evidence (var-only promotion) must
 * serve the captured state, which differs from the target state.
 */
function previousWorkerStillAnswering(manifest, evidence) {
  const previous = manifest.previousRecipeAuthority;
  if (typeof previous !== 'object' || previous === null || previous.unavailable === true) return null;
  if (typeof evidence !== 'object' || evidence === null) return null;
  if (typeof previous.commit !== 'string' || !SHA.test(previous.commit)) return null;
  if (evidence.commit !== previous.commit) return null;
  for (const key of STABLE_RECIPE_AUTHORITY_EVIDENCE_FIELDS) {
    if (!Object.hasOwn(previous, key) || evidence[key] !== previous[key]) return null;
  }
  const observed = {
    mode: evidence.configuredMode,
    canaryPercent: evidence.canaryPercent,
    cutoverEnabled: evidence.cutoverEnabled,
  };
  try {
    const valid = validateRecipeCatalogRollout(observed);
    if (valid.cutoverEnabled !== observed.cutoverEnabled) return null;
  } catch {
    return null;
  }
  const sameCommit = previous.commit === manifest.sha;
  if (sameCommit && sameAuthorityState(observed, targetAuthorityState(manifest))) return null;
  const proof = manifest.previousRecipeAuthorityProof;
  if (proof === undefined || proof === null) {
    if (!sameCommit) return null;
  } else {
    if (proof.commit !== previous.commit || proof.relation !== (sameCommit ? 'same' : 'ancestor'))
      return null;
    try {
      verifyRecipeAuthorityEvidence(previousAuthorityManifest(manifest, proof), evidence, proof.release);
    } catch {
      return null;
    }
  }
  return {
    state: describeAuthorityState(observed),
    from: sameCommit ? '' : ` from previous Worker ${previous.commit.slice(0, 8)}`,
  };
}

function targetAuthorityState(manifest) {
  return {
    mode: manifest.recipeCatalogMode,
    canaryPercent: manifest.recipeCatalogCanaryPercent,
    cutoverEnabled: manifest.recipeCatalogCutoverEnabled,
  };
}

/**
 * Polls the protected authority evidence until it proves the approved state (class 1: exact
 * target commit and every approved field). Evidence that is exactly the preflight-captured previous
 * Worker (class 2, see `previousWorkerStillAnswering`) is retried within a bounded deadline and is
 * never accepted; every other mismatch (class 3) fails immediately.
 */
export async function waitForRecipeAuthorityEvidence(manifest, release, {
  fetchEvidence,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  deadlineMs = 90_000,
  intervalMs = 3_000,
  log = console.log,
}) {
  const startedAt = now();
  const target = describeAuthorityState(targetAuthorityState(manifest));
  const targetSha = String(manifest?.sha ?? '').slice(0, 8);
  for (let attempt = 1; ; attempt += 1) {
    const evidence = await fetchEvidence();
    try {
      return verifyRecipeAuthorityEvidence(manifest, evidence, release);
    } catch (error) {
      const stale = previousWorkerStillAnswering(manifest, evidence);
      if (!stale) throw error;
      if (now() - startedAt + intervalMs > deadlineMs) {
        throw new Error(
          `Recipe authority still served ${stale.state}${stale.from} instead of ${target} after ${deadlineMs} ms (${attempt} attempts)`,
        );
      }
      log(
        `attempt ${attempt}: recipe authority still ${stale.state}${stale.from} (pre-deploy state), expected ${target} at ${targetSha}; propagation pending, retrying`,
      );
      await sleep(intervalMs);
    }
  }
}

function writeManifest(file, manifest) {
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * T19D — post-deploy recipe authority proof. `evidence` is the body of the protected
 * `GET /api/v1/health/recipe-authority` endpoint; `release` is the reviewed catalog release manifest
 * shipped at the deployed SHA. Every claim of the deployment (mode, cutover, percent, release ID,
 * expected count) must be echoed by the Worker, and the served content must be exactly what the
 * state promises:
 *   static        → static content, no fallback;
 *   shadow        → users remain on static while the protected probe proves VERIFIED D1;
 *   canary        → probe (forced in-cohort) served VERIFIED D1 == release fingerprint;
 *   d1            → every request served VERIFIED D1 == release fingerprint, fallbackReason null.
 * A D1 fallback while D1 was selected is a HOLD/ROLLBACK signal, never a pass.
 */
export function verifyRecipeAuthorityEvidence(manifest, evidence, release) {
  if (!SHA.test(manifest?.sha || ''))
    throw new Error('Target release SHA must be a canonical full Git SHA');
  if (typeof evidence !== 'object' || evidence === null)
    throw new Error('Recipe authority evidence is not an object');
  if (evidence.schemaVersion !== 1)
    throw new Error('Recipe authority evidence schema is not supported');
  const problems = [];
  const expect = (label, actual, expected) => {
    if (actual !== expected)
      problems.push(`${label} ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  };
  expect('environment', evidence.environment, manifest.environment);
  expect('commit', evidence.commit, manifest.sha);
  expect('configuredMode', evidence.configuredMode, manifest.recipeCatalogMode);
  expect('cutoverEnabled', evidence.cutoverEnabled, manifest.recipeCatalogCutoverEnabled);
  expect('canaryPercent', evidence.canaryPercent, manifest.recipeCatalogCanaryPercent);
  expect('releaseId', evidence.releaseId, release.releaseId);
  expect('expectedRecipeCount', evidence.expectedRecipeCount, release.expectedRecipeCount);
  expect(
    'expectedRuntimeFingerprint',
    evidence.expectedRuntimeFingerprint,
    release.expectedRuntimeFingerprint,
  );
  const d1ProbeState = manifest.recipeCatalogMode !== 'static';
  if (d1ProbeState) {
    expect('selectedSource', evidence.selectedSource, 'd1');
    expect('actualSource', evidence.actualSource, 'd1');
    expect('fallbackReason', evidence.fallbackReason, null);
    expect('d1Readiness', evidence.d1Readiness, 'ready');
    expect('d1ReadinessCode', evidence.d1ReadinessCode, null);
    expect('servedRecipeCount', evidence.servedRecipeCount, release.expectedRecipeCount);
    expect('servedFingerprint', evidence.servedFingerprint, release.expectedRuntimeFingerprint);
    expect('fingerprintMatchesRelease', evidence.fingerprintMatchesRelease, true);
    expect(
      'globalSource',
      evidence.globalSource,
      manifest.recipeCatalogMode === 'd1'
        ? 'd1'
        : manifest.recipeCatalogMode === 'canary'
          ? 'mixed'
          : 'static',
    );
  } else {
    expect('selectedSource', evidence.selectedSource, 'static');
    expect('actualSource', evidence.actualSource, 'static');
    expect('fallbackReason', evidence.fallbackReason, null);
    expect('d1Readiness', evidence.d1Readiness, 'not_evaluated');
    expect('d1ReadinessCode', evidence.d1ReadinessCode, null);
    expect('servedRecipeCount', evidence.servedRecipeCount, release.legacyBaselineCount);
    expect('servedFingerprint', evidence.servedFingerprint, release.legacyBaselineFingerprint);
    expect('fingerprintMatchesRelease', evidence.fingerprintMatchesRelease, false);
    expect('globalSource', evidence.globalSource, 'static');
  }
  if (problems.length)
    throw new Error(
      `Deployed recipe authority does not match the approved release state: ${problems.join('; ')}`,
    );
  return {
    configuredMode: evidence.configuredMode,
    cutoverEnabled: evidence.cutoverEnabled,
    canaryPercent: evidence.canaryPercent,
    actualSource: evidence.actualSource,
    globalSource: evidence.globalSource,
    servedRecipeCount: evidence.servedRecipeCount,
    servedFingerprint: evidence.servedFingerprint,
    releaseId: evidence.releaseId,
    d1Readiness: evidence.d1Readiness,
    fallbackReason: evidence.fallbackReason,
    checkedAt: new Date().toISOString(),
  };
}

export const CATALOG_RELEASE_MANIFEST_PATH =
  'packages/recipes/src/import/catalog-release.current.json';

/**
 * Reads the protected evidence. Only HTTP 200 with a JSON object is evidence: a rejected
 * RELEASE_VERIFY_TOKEN, any other status, or a malformed body fails closed.
 */
export async function fetchRecipeAuthorityEvidence(origin, token, { fetchImpl = fetch } = {}) {
  if (!token || token.length < 32)
    throw new Error('RELEASE_VERIFY_TOKEN is required to read recipe authority evidence');
  const response = await fetchImpl(new URL('/api/v1/health/recipe-authority', origin), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  let body;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = undefined;
  }
  if (response.status === 401 && body?.code === 'RELEASE_VERIFY_UNAUTHORIZED')
    throw new Error('Recipe authority endpoint rejected RELEASE_VERIFY_TOKEN; token mismatch');
  if (response.status !== 200)
    throw new Error(`Recipe authority evidence lookup failed (HTTP ${response.status})`);
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new Error('Recipe authority evidence is not a JSON object');
  return body;
}

async function main() {
  const [
    command,
    file = 'release-manifest.json',
    evidenceFile,
    extraEvidenceFile,
    versionEvidenceFile,
    mutationEvidenceFile,
  ] =
    process.argv.slice(2);
  if (command === 'gate') {
    const environment = process.env.RELEASE_ENVIRONMENT;
    if (!['production', 'staging'].includes(environment))
      throw new Error('Invalid release environment');
    const rollout = validateRecipeCatalogRollout({
      mode: process.env.RECIPE_CATALOG_MODE,
      canaryPercent: process.env.RECIPE_CATALOG_D1_CANARY_PERCENT,
    });
    const mealCompositionV2Enabled = resolveMealCompositionV2Release({
      eventName: process.env.GITHUB_EVENT_NAME,
      input: process.env.MEAL_COMPOSITION_V2_ENABLED_INPUT,
    });
    const hardenedSha =
      process.env.HARDENED_SHA ||
      (environment === 'staging' && process.env.GITHUB_EVENT_NAME === 'workflow_run'
        ? REVIEWED_HARDENING_BASE
        : undefined);
    const source = validateReleaseSource({ ref: process.env.RELEASE_REF, hardenedSha });
    const repository = process.env.GITHUB_REPOSITORY;
    const manifest = {
      ...source,
      repository,
      environment,
      recipeCatalogMode: rollout.mode,
      recipeCatalogCanaryPercent: rollout.canaryPercent,
      recipeCatalogCutoverEnabled: rollout.cutoverEnabled,
      recipeCatalogRollbackConfirmed: process.env.RECIPE_CATALOG_ROLLBACK_CONFIRMED === 'true',
      mealCompositionV2Enabled: mealCompositionV2Enabled === 'true',
      ci: await hostedCi(source.sha, repository),
      schema: migrationManifest(process.cwd(), source.sha),
      workflowRunId: process.env.GITHUB_RUN_ID,
      workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
      createdAt: new Date().toISOString(),
    };
    writeManifest(file, manifest);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `deploy_sha=${source.sha}\nrecipe_catalog_mode=${rollout.mode}\nrecipe_catalog_d1_canary_percent=${rollout.canaryPercent}\nrecipe_catalog_cutover_enabled=${rollout.cutoverEnabled}\nmeal_composition_v2_enabled=${mealCompositionV2Enabled}\n`,
      );
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Approved release candidate\n\n- SHA: \`${source.sha}\`\n- Main: \`${source.mainSha}\`\n- Hardened ancestor: \`${source.hardenedSha}\`\n- Schema: \`${manifest.schema.version}\` (${manifest.schema.sha256})\n- Exact-head CI: ${manifest.ci.url}\n- Meal Composition V2 (server + UI): \`${mealCompositionV2Enabled}\`\n\nCandidate validation is not proof of deployment; see the deployment receipt artifact.\n`,
      );
  } else {
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (command === 'recheck') {
      validateRecipeCatalogManifestPolicy(manifest);
      if (git(process.cwd(), 'rev-parse', 'HEAD') !== manifest.sha)
        throw new Error('Checkout differs from approved release SHA');
      const source = validateReleaseSource({
        ref: manifest.sha,
        hardenedSha: manifest.hardenedSha,
      });
      if (migrationManifest(process.cwd(), source.sha).sha256 !== manifest.schema.sha256)
        throw new Error('Migration manifest changed');
      manifest.mainShaAtDeploymentGate = source.mainSha;
      manifest.ci = await hostedCi(source.sha, manifest.repository);
    } else if (command === 'schema') {
      manifest.observedMigrationLedger = verifyMigrationLedger(
        manifest.schema,
        JSON.parse(readFileSync(evidenceFile, 'utf8')),
      );
    } else if (command === 'deployed') {
      manifest.deployed = verifyDeployedRelease(
        manifest,
        JSON.parse(readFileSync(evidenceFile, 'utf8')),
      );
    } else if (command === 'transition') {
      const current = JSON.parse(readFileSync(evidenceFile, 'utf8'));
      const release = JSON.parse(readFileSync(CATALOG_RELEASE_MANIFEST_PATH, 'utf8'));
      manifest.recipeAuthorityTransition = {
        ...validateRecipeCatalogTransition(manifest, current, release, { cwd: process.cwd() }),
        checkedAt: new Date().toISOString(),
      };
      manifest.previousRecipeAuthority = current;
    } else if (command === 'deployment-snapshot') {
      manifest.previousDeployment = verifyStableWorkerDeployment(
        JSON.parse(readFileSync(evidenceFile, 'utf8')),
      );
    } else if (command === 'rollback-target') {
      manifest.previousDeployment.binding = verifyRollbackTarget(
        manifest,
        JSON.parse(readFileSync(evidenceFile, 'utf8')),
      );
    } else if (command === 'legacy-authority') {
      // Rewrites the captured 401 body with verified "unavailable" evidence for `transition`.
      let body = null;
      try {
        body = JSON.parse(readFileSync(extraEvidenceFile, 'utf8'));
      } catch {
        body = null;
      }
      const evidence = classifyLegacyRecipeAuthorityEndpoint(
        manifest,
        JSON.parse(readFileSync(evidenceFile, 'utf8')),
        body,
      );
      writeFileSync(extraEvidenceFile, `${JSON.stringify(evidence)}\n`);
    } else if (command === 'deployed-binding') {
      manifest.deployedWorker = verifyDeployedWorker(
        manifest,
        JSON.parse(readFileSync(evidenceFile, 'utf8')),
        JSON.parse(readFileSync(extraEvidenceFile, 'utf8')),
      );
    } else if (command === 'rollback') {
      const deployment = JSON.parse(readFileSync(evidenceFile, 'utf8'));
      const authority = JSON.parse(readFileSync(extraEvidenceFile, 'utf8'));
      const version = JSON.parse(readFileSync(versionEvidenceFile, 'utf8'));
      const mutation = JSON.parse(readFileSync(mutationEvidenceFile, 'utf8'));
      manifest.rollback = verifyRecipeCatalogRollback(
        manifest,
        deployment,
        authority,
        version,
        mutation,
      );
    } else if (command === 'previous-authority') {
      // Staging, before `command: deploy`: capture the live protected evidence (or an offline file)
      // and prove it before the post-deploy wait may use it to classify convergence.
      if (manifest.environment !== 'staging')
        throw new Error('previous-authority is the staging pre-deploy capture; production uses transition');
      const current = evidenceFile
        ? JSON.parse(readFileSync(evidenceFile, 'utf8'))
        : await fetchRecipeAuthorityEvidence(
            process.env.APP_SMOKE_URL,
            process.env.RELEASE_VERIFY_TOKEN,
          );
      manifest.previousRecipeAuthorityProof = verifyPreviousRecipeAuthority(manifest, current, {
        cwd: process.cwd(),
      });
      manifest.previousRecipeAuthority = current;
      console.log(
        `Previous recipe authority verified: commit=${current.commit} relation=${manifest.previousRecipeAuthorityProof.relation} mode=${current.configuredMode} release=${current.releaseId} served=${current.servedRecipeCount}`,
      );
    } else if (command === 'authority') {
      // Evidence file (offline) or live protected endpoint (APP_SMOKE_URL + RELEASE_VERIFY_TOKEN).
      const release = JSON.parse(readFileSync(CATALOG_RELEASE_MANIFEST_PATH, 'utf8'));
      manifest.recipeAuthority = evidenceFile
        ? verifyRecipeAuthorityEvidence(
            manifest,
            JSON.parse(readFileSync(evidenceFile, 'utf8')),
            release,
          )
        : await waitForRecipeAuthorityEvidence(manifest, release, {
            fetchEvidence: () =>
              fetchRecipeAuthorityEvidence(
                process.env.APP_SMOKE_URL,
                process.env.RELEASE_VERIFY_TOKEN,
              ),
          });
      console.log(
        `Recipe authority verified: mode=${manifest.recipeAuthority.configuredMode} source=${manifest.recipeAuthority.actualSource} served=${manifest.recipeAuthority.servedRecipeCount} release=${manifest.recipeAuthority.releaseId} fallback=${manifest.recipeAuthority.fallbackReason}`,
      );
    } else {
      throw new Error(
        'Usage: release-check.mjs <gate|recheck|schema|deployed|transition|previous-authority|deployment-snapshot|rollback-target|deployed-binding|rollback|authority> [manifest.json] [evidence...]',
      );
    }
    writeManifest(file, manifest);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Release check failed');
    process.exitCode = 1;
  });
}
