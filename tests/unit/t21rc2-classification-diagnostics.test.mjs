import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureDigest, classifyT21RC2Snapshot, executeFixedProductionSelect,
  runT21RC2CaptureCommand } from '../../scripts/t21rc2-production-capture.mjs';
import { validateT21RC2Manifest, validateT21RC2ManifestSchema, validateT21RC2ManifestAggregate,
  validateT21RC2ManifestDigests } from '../../scripts/t21rc2-production-receipt.mjs';
import { buildT21RC2FailureReceipt, recordT21RC2Failure, runnerPaths, safeT21RC2Error,
  T21RC2_CLASSIFICATION_STAGES, writePrivateJson } from '../../scripts/t21rc2-production-files.mjs';
import { loadCertifiedV1Authority } from '../../scripts/t21r-v1-authority.mjs';
import * as reconciliation from '../../scripts/t21rc-row-reconciliation.mjs';

const proof = {
  canonicalTargetSha256: 'a'.repeat(64), releaseManifestSha256: 'b'.repeat(64),
  approvedBatchesSha256: 'c'.repeat(64), canonicalRegistrySourceSha256: 'd'.repeat(64),
  reconciliationSha256: 'e'.repeat(64), releaseId: 'synthetic-release',
  runtimeFingerprint: 'f'.repeat(64), reviewedBridgeCount: 0,
};
const ingredient = (overrides = {}) => ({
  ingredientId: 'ING_ALPHA', name: 'Synthetic Alpha', requiredQuantity: 2, unit: 'g',
  ...overrides,
});
const row = (overrides = {}) => ({
  id: 'synthetic-row', recipe_id: 'synthetic-recipe', ingredient_id: 'ING_ALPHA',
  name: 'Synthetic Alpha', required_quantity: 2, unit: 'g', is_optional: 0, ...overrides,
});
function fixture({ rows = [row()], targetRecipes = [{ id: 'synthetic-recipe', ingredients: [ingredient()] }],
  canonicalIngredientIds = ['ING_ALPHA'], bridges = [] } = {}) {
  const authority = { targetRecipes, canonicalIngredientIds, reconciliation: bridges, authorityProof: proof };
  const input = {
    recipeIds: targetRecipes.map((recipe) => recipe.id), occurrences: rows,
    captureCounts: { recipeCount: targetRecipes.length, ingredientOccurrenceCount: rows.length },
  };
  const authorization = { source: 'synthetic-only' };
  const capture = {
    status: 'OBSERVED_STABLE_NON_ATOMIC', authorityProof: proof, counts: input.captureCounts,
    authorizationSha256: captureDigest(authorization), snapshotDigestSha256: captureDigest(input),
  };
  return { input, capture, authorization, authority };
}
function manifestFor(values = fixture()) {
  const { input, authority } = values;
  return {
    ...reconciliation.reconcileIngredientOccurrences({
      ...authority, productionRows: input.occurrences, productionRecipeIds: input.recipeIds,
      captureCounts: input.captureCounts,
    }),
    authorityProof: authority.authorityProof,
  };
}
function refreshClassificationDigest(manifest) {
  manifest.digests.classificationSha256 = captureDigest({
    captureEvidence: manifest.captureEvidence, production: manifest.production,
    target: manifest.target, recipes: manifest.recipes, summary: manifest.summary,
  });
}
const temporary = [];
const temp = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 't21rc2d-test-'));
  temporary.push(directory);
  return directory;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('T21R-C2D classifier/schema contract regressions', () => {
  it('accepts the intentional duplicate-physical-ID malformed classification in the closed schema', () => {
    const manifest = manifestFor(fixture({ rows: [row(), row()] }));
    expect(manifest.production.map((entry) => entry.reviewReason))
      .toEqual(['DUPLICATE_PHYSICAL_LINE_ID', 'DUPLICATE_PHYSICAL_LINE_ID']);
    expect(manifest.production.every((entry) => entry.classification === 'MALFORMED_OCCURRENCE')).toBe(true);
    expect(validateT21RC2Manifest(manifest)).toBe(true);
  });

  it.each([
    ['ingredient identity', { ingredient_id: 'invalid ingredient' }],
    ['unit', { unit: 'tablespoon' }],
    ['quantity', { required_quantity: '2' }],
    ['optional bit', { is_optional: true }],
    ['recipe reference', { recipe_id: 'uncaptured-recipe' }],
  ])('keeps malformed %s data classifiable without coercion', (_, overrides) => {
    const manifest = manifestFor(fixture({ rows: [row(overrides)] }));
    expect(manifest.production[0].classification).toBe('MALFORMED_OCCURRENCE');
    if (overrides.recipe_id) {
      expect(manifest.production[0].recipeId).toBe(null);
      expect(manifest.summary.unattributedProductionOccurrences).toBe(1);
      expect(manifest.recipes).toHaveLength(1);
    }
    expect(validateT21RC2Manifest(manifest)).toBe(true);
  });
});

describe('T21R-C2D closed schema and aggregate mutation stages', () => {
  it.each(['production', 'target'])('rejects cross-recipe %s candidates even with a recomputed digest', (side) => {
    const manifest = manifestFor(fixture({
      targetRecipes: ['synthetic-a', 'synthetic-b'].map((id) => ({ id, ingredients: [ingredient()] })),
      rows: ['synthetic-a', 'synthetic-b'].map((id) => row({ id: `row-${id}`, recipe_id: id })),
    }));
    if (side === 'production') {
      const entry = manifest.production[0];
      entry.candidateTargetOccurrenceKeys = [manifest.target.find((candidate) => candidate.recipeId !== entry.recipeId).occurrenceKey];
    } else {
      const entry = manifest.target[0];
      entry.candidateProductionOccurrenceKeys = [manifest.production.find((candidate) => candidate.recipeId !== entry.recipeId).occurrenceKey];
    }
    refreshClassificationDigest(manifest);
    expect(validateT21RC2ManifestSchema(manifest)).toBe(true);
    expect(() => validateT21RC2Manifest(manifest)).toThrow('T21RC2_CLASSIFICATION_AGGREGATE_REJECTED');
  });

  it.each([
    ['recipe status', (manifest) => { manifest.recipes[0].status = 'SEVERELY_DIVERGED'; }],
    ['largest drift index', (manifest) => { manifest.summary.largestDriftRecipes = [{ recipeId: manifest.recipes[0].recipeId, count: 99 }]; }],
    ['conflict index', (manifest) => { manifest.summary.idConflictOccurrenceKeys = [`p:${'0'.repeat(64)}:1`]; }],
  ])('rejects false derived %s even with a recomputed digest', (_, mutate) => {
    const manifest = manifestFor();
    mutate(manifest);
    refreshClassificationDigest(manifest);
    expect(validateT21RC2ManifestSchema(manifest)).toBe(true);
    expect(() => validateT21RC2Manifest(manifest)).toThrow('T21RC2_CLASSIFICATION_AGGREGATE_REJECTED');
  });

  it.each([
    ['production classification', (manifest) => { manifest.production[0].classification = 'INVALID'; }],
    ['target classification', (manifest) => { manifest.target[0].classification = 'INVALID'; }],
    ['review reason', (manifest) => { manifest.production[0].reviewReason = 'INVALID'; }],
    ['mapping', (manifest) => { manifest.production[0].mapping = 'INVALID'; }],
    ['confidence', (manifest) => { manifest.production[0].confidence = 'INVALID'; }],
    ['authority enum', (manifest) => { manifest.production[0].authority = ['INVALID']; }],
    ['identity population', (manifest) => { manifest.production[0].identityPopulation = 'INVALID'; }],
    ['drift kind', (manifest) => { manifest.production[0].driftKind = 'INVALID'; }],
    ['recipe status', (manifest) => { manifest.recipes[0].status = 'INVALID'; }],
    ['target key format', (manifest) => { manifest.target[0].occurrenceKey = 'invalid-key'; }],
    ['production key format', (manifest) => { manifest.production[0].occurrenceKey = 'invalid-key'; }],
    ['unexpected key', (manifest) => { manifest.production[0].privateMarker = 'PRIVATE_VALUE'; }],
    ['missing recipe key', (manifest) => { delete manifest.recipes[0].exactMatchCount; }],
    ['negative count', (manifest) => { manifest.summary.productionOccurrenceCount = -1; }],
    ['duplicate target candidate', (manifest) => { manifest.production[0].candidateTargetOccurrenceKeys.push(manifest.target[0].occurrenceKey); }],
    ['duplicate production candidate', (manifest) => { manifest.target[0].candidateProductionOccurrenceKeys.push(manifest.production[0].occurrenceKey); }],
  ])('rejects %s at the schema stage', (_, mutate) => {
    const manifest = manifestFor();
    mutate(manifest);
    expect(() => validateT21RC2Manifest(manifest)).toThrow('T21RC2_CLASSIFICATION_SCHEMA_REJECTED');
  });

  it.each([
    ['class sum', (manifest) => { manifest.summary.accounting.productionClassSum += 1; }],
    ['class counts', (manifest) => { manifest.summary.productionClassCounts.EXACT_V1_MATCH += 1; }],
    ['recipe ID set', (manifest) => { manifest.summary.recipeIdSetMatch = false; }],
    ['per-recipe count', (manifest) => { manifest.recipes[0].productionOccurrenceCount += 1; }],
    ['drift count', (manifest) => { manifest.summary.driftRecipeCount += 1; }],
    ['unattributed count', (manifest) => { manifest.summary.unattributedProductionOccurrences += 1; }],
    ['authority proof', (manifest) => { manifest.authorityProof = null; }],
    ['missing target candidate', (manifest) => { manifest.production[0].candidateTargetOccurrenceKeys = [`t:${'0'.repeat(64)}`]; }],
    ['missing production candidate', (manifest) => { manifest.target[0].candidateProductionOccurrenceKeys = [`p:${'0'.repeat(64)}:1`]; }],
  ])('accepts the schema but rejects inconsistent %s at the aggregate stage', (_, mutate) => {
    const manifest = manifestFor();
    mutate(manifest);
    expect(validateT21RC2ManifestSchema(manifest)).toBe(true);
    expect(() => validateT21RC2Manifest(manifest)).toThrow('T21RC2_CLASSIFICATION_AGGREGATE_REJECTED');
  });

  it('accepts the schema and aggregate but rejects a tampered classification digest', () => {
    const manifest = manifestFor();
    manifest.digests.classificationSha256 = '0'.repeat(64);
    expect(validateT21RC2ManifestSchema(manifest)).toBe(true);
    expect(validateT21RC2ManifestAggregate(manifest).recipeCount).toBe(1);
    expect(() => validateT21RC2ManifestDigests(manifest)).toThrow('T21RC2_CLASSIFICATION_DIGEST_REJECTED');
  });
});

function expectKeyIntegrity(manifest) {
  const pKeys = new Set(manifest.production.map((entry) => entry.occurrenceKey));
  const tKeys = new Set(manifest.target.map((entry) => entry.occurrenceKey));
  expect(pKeys.size).toBe(manifest.production.length);
  expect(tKeys.size).toBe(manifest.target.length);
  for (const entry of manifest.production) {
    expect(entry.occurrenceKey).toMatch(/^p:[0-9a-f]{64}:[1-9][0-9]*$/);
    expect(new Set(entry.candidateTargetOccurrenceKeys).size).toBe(entry.candidateTargetOccurrenceKeys.length);
    entry.candidateTargetOccurrenceKeys.forEach((key) => expect(tKeys.has(key)).toBe(true));
  }
  for (const entry of manifest.target) {
    expect(entry.occurrenceKey).toMatch(/^t:[0-9a-f]{64}$/);
    expect(new Set(entry.candidateProductionOccurrenceKeys).size).toBe(entry.candidateProductionOccurrenceKeys.length);
    entry.candidateProductionOccurrenceKeys.forEach((key) => expect(pKeys.has(key)).toBe(true));
  }
}

describe('T21R-C2D divergence is evidence, not a classification failure', () => {
  it('classifies a production-like mixture of content drift, known/new IDs, missing targets and conflicts', async () => {
    const cases = ['drift', 'known', 'new', 'missing', 'conflict', 'ambiguous'];
    const targetRecipes = cases.map((name) => ({ id: `synthetic-${name}`, ingredients: [ingredient()] }));
    const rows = [
      row({ id: 'row-drift', recipe_id: 'synthetic-drift', required_quantity: 3 }),
      row({ id: 'row-known', recipe_id: 'synthetic-known', ingredient_id: 'ING_KNOWN', name: 'Synthetic known-only' }),
      row({ id: 'row-new', recipe_id: 'synthetic-new', ingredient_id: 'SOURCE_NEW', name: 'Synthetic new-only' }),
      row({ id: 'row-conflict', recipe_id: 'synthetic-conflict', ingredient_id: 'ING_CONFLICT' }),
      row({ id: 'row-ambiguous', recipe_id: 'synthetic-ambiguous', ingredient_id: 'ING_ENR_UNREVIEWED', name: 'Synthetic unresolved' }),
    ];
    const values = fixture({ rows, targetRecipes, canonicalIngredientIds: ['ING_ALPHA', 'ING_KNOWN'],
      bridges: [{ sourceId: 'SOURCE_NEW', canonicalId: 'ING_ENR_NEW', resolution: 'reviewed_new_canonical_id',
        review: { basis: 'synthetic curated source', evidenceReference: 'synthetic:review' } }] });
    const { manifest } = await classifyT21RC2Snapshot(values);
    expect(manifest.summary.productionClassCounts).toMatchObject({ SAME_ID_CONTENT_DRIFT: 1,
      PRODUCTION_ONLY_KNOWN_ID: 1, PRODUCTION_ONLY_NEW_ID: 1, ID_CONFLICT_REVIEW_REQUIRED: 1, AMBIGUOUS: 1 });
    expect(manifest.target.find((entry) => entry.recipeId === 'synthetic-missing').classification).toBe('TARGET_ONLY_MISSING');
    expect(validateT21RC2Manifest(manifest)).toBe(true);
    expectKeyIntegrity(manifest);
  });

  it('classifies extreme divergence against unchanged offline certified 500/2702 authority', async () => {
    const authority = await loadCertifiedV1Authority();
    expect(authority.targetRecipes).toHaveLength(500);
    expect(authority.authorityProof.releaseId).toBe('rel-bd00a4f53fcaeee4');
    const spec = JSON.parse(readFileSync('docs/ai/recipe-catalog/T21RA_RUNTIME_CANONICAL_TARGET.json', 'utf8'));
    expect(authority.authorityProof.runtimeFingerprint).toBe(spec.target.expectedRuntimeFingerprint);
    const rows = authority.targetRecipes.flatMap((recipe) => recipe.ingredients.map((entry, index) => ({
      id: `synthetic-${recipe.id}-${index}`, recipe_id: recipe.id, ingredient_id: entry.ingredientId,
      name: `Synthetic divergent ${index}`, required_quantity: entry.requiredQuantity + 1,
      unit: entry.unit, is_optional: entry.isOptional === true ? 1 : 0,
    })));
    expect(rows).toHaveLength(2702);
    const values = fixture({ rows, targetRecipes: authority.targetRecipes });
    values.authority = authority;
    values.capture.authorityProof = authority.authorityProof;
    const { manifest } = await classifyT21RC2Snapshot(values);
    expect(manifest.summary.targetOccurrenceCount).toBe(2702);
    expect(manifest.summary.productionClassCounts.EXACT_V1_MATCH).toBe(0);
    expect(validateT21RC2ManifestSchema(manifest)).toBe(true);
    expect(validateT21RC2ManifestAggregate(manifest).productionOccurrenceCount).toBe(2702);
    expect(validateT21RC2ManifestDigests(manifest)).toBe(true);
    expectKeyIntegrity(manifest);
  });

  it.each([0, 1])('retains SQLite/D1 JSON numbers and integer optional bit %s without coercion', async (optional) => {
    const env = { RUNNER_TEMP: temp() };
    const payload = JSON.stringify([{ success: true,
      results: [row({ required_quantity: 2.125, is_optional: optional })], meta: { changes: 0, rows_written: 0 } }]);
    const rows = executeFixedProductionSelect('occurrences', { env, execute: () => payload });
    expect(typeof rows[0].required_quantity).toBe('number');
    expect(rows[0].is_optional).toBe(optional);
    expect((await classifyT21RC2Snapshot(fixture({ rows }))).manifest.production[0].classification)
      .not.toBe('MALFORMED_OCCURRENCE');
  });
});

const privateMarkers = ['PRIVATE_RECIPE_FIXTURE', 'ING_PRIVATE_FIXTURE', 'PRIVATE_PHYSICAL_FIXTURE',
  'PRIVATE_INGREDIENT_NAME', '987654.125', 'FAKE_API_TOKEN_DO_NOT_PUBLISH', 'private@example.invalid',
  'PRIVATE_ACCOUNT_NAME', '0123456789abcdef'.repeat(2), 'PRIVATE_PROVIDER_TEXT'];
const privateError = () => Object.assign(new Error(privateMarkers.join(' ')), {
  stdout: privateMarkers.join(' '), stderr: privateMarkers.join(' '),
  errors: [{ keyword: privateMarkers[0], schemaPath: privateMarkers[1], instancePath: privateMarkers[2],
    dataPath: privateMarkers[3], data: privateMarkers, params: { value: privateMarkers }, parentSchema: privateMarkers }],
});

describe('T21R-C2D diagnostic receipts reconstruct only static metadata', () => {
  it.each(Object.entries(T21RC2_CLASSIFICATION_STAGES))('redacts real %s failure context', async (code, stage) => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'),
      vi.spyOn(process.stdout, 'write'), vi.spyOn(process.stderr, 'write')];
    const values = fixture({ rows: [row({ id: privateMarkers[2], name: privateMarkers[3], required_quantity: 987654.125 })] });
    if (stage === 'capture_binding') values.capture.snapshotDigestSha256 = '0'.repeat(64);
    else if (stage === 'authority') {
      delete values.authority;
      values.loadAuthority = async () => { throw privateError(); };
    } else if (stage === 'reconciliation') {
      vi.spyOn(reconciliation, 'reconcileIngredientOccurrences').mockImplementation(() => { throw privateError(); });
    } else {
      const manifest = manifestFor(values);
      if (stage === 'schema') manifest[privateMarkers[0]] = privateMarkers;
      if (stage === 'aggregate') manifest.summary.productionClassCounts.EXACT_V1_MATCH += 1;
      if (stage === 'digest') manifest.digests.classificationSha256 = '0'.repeat(64);
      vi.spyOn(reconciliation, 'reconcileIngredientOccurrences').mockReturnValue(manifest);
    }
    let failure;
    try { await classifyT21RC2Snapshot(values); } catch (error) { failure = error; }
    expect(failure?.code).toBe(code);
    const env = { RUNNER_TEMP: temp() };
    recordT21RC2Failure(failure, env);
    const receipt = JSON.parse(readFileSync(runnerPaths(env).publicReceipt, 'utf8'));
    const diagnostic = { section: 'root', field: 'unknown', keyword: 'additionalProperties',
      code: 'ROOT_ADDITIONAL_PROPERTIES' };
    expect(receipt.classificationDiagnostic).toEqual({ schemaVersion: 1, status: code, stage,
      ...(stage === 'schema' ? { diagnostic } : {}) });
    const output = `${failure.message}\n${safeT21RC2Error(failure)}\n${JSON.stringify(receipt)}\n${JSON.stringify(spies.map((spy) => spy.mock.calls))}`;
    privateMarkers.forEach((marker) => expect(output).not.toContain(marker));
    for (const field of ['instancePath', 'dataPath', 'params', 'parentSchema', 'stdout', 'stderr', 'unit', 'manifest']) {
      expect(output).not.toContain(`"${field}"`);
    }
    if (stage === 'schema') {
      expect(spies[1]).toHaveBeenCalledExactlyOnceWith(`t21rc2_schema=${JSON.stringify(diagnostic)}`);
      [spies[0], spies[2], spies[3]].forEach((spy) => expect(spy).not.toHaveBeenCalled());
    } else {
      spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
    }
  });

  it('never trusts caller-provided Ajv metadata, stage, cause, or receipt extras', () => {
    const error = Object.assign(privateError(), { code: 'T21RC2_CLASSIFICATION_SCHEMA_REJECTED',
      stage: privateMarkers[0], classificationDiagnostic: { keyword: privateMarkers[1], data: privateMarkers } });
    const receipt = buildT21RC2FailureReceipt(error);
    expect(receipt.classificationDiagnostic).toEqual({ schemaVersion: 1,
      status: 'T21RC2_CLASSIFICATION_SCHEMA_REJECTED', stage: 'schema', diagnostic: {
        section: 'unknown', field: 'unknown', keyword: 'unknown', code: 'UNKNOWN_SCHEMA_CONTRACT',
      } });
    privateMarkers.forEach((marker) => expect(JSON.stringify(receipt)).not.toContain(marker));
    expect(buildT21RC2FailureReceipt({ code: privateMarkers[0] })).not.toHaveProperty('classificationDiagnostic');
  });

  it('snapshots allowlisted caller codes and redacts throwing code accessors', () => {
    let reads = 0;
    const changing = { get code() {
      return ++reads === 1 ? 'T21RC2_CLASSIFICATION_SCHEMA_REJECTED' : privateMarkers.join(' ');
    } };
    expect(safeT21RC2Error(changing)).toBe('T21RC2_CLASSIFICATION_SCHEMA_REJECTED');
    expect(reads).toBe(1);
    reads = 0;
    const receipt = buildT21RC2FailureReceipt(changing);
    expect(reads).toBe(1);
    expect(receipt.reason).toBe('T21RC2_CLASSIFICATION_SCHEMA_REJECTED');
    expect(receipt.classificationDiagnostic.diagnostic).toEqual({
      section: 'unknown', field: 'unknown', keyword: 'unknown', code: 'UNKNOWN_SCHEMA_CONTRACT',
    });
    const throwing = { get code() { throw new Error(privateMarkers.join(' ')); } };
    const env = { RUNNER_TEMP: temp() };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(safeT21RC2Error(throwing)).toBe('T21RC2_CAPTURE_INCOMPLETE');
    recordT21RC2Failure(throwing, env);
    expect(log).not.toHaveBeenCalled();
    const recorded = readFileSync(runnerPaths(env).publicReceipt, 'utf8');
    expect(JSON.parse(recorded).reason).toBe('T21RC2_CAPTURE_INCOMPLETE');
    privateMarkers.forEach((marker) => expect(`${JSON.stringify(receipt)}${recorded}`).not.toContain(marker));
  });
});

function storedFixture() {
  const values = fixture();
  const mainSha = 'a'.repeat(40), reviewedSha = 'b'.repeat(40), actor = 'synthetic-operator';
  values.authorization = { schemaVersion: 1, repositoryId: 1385308553, repository: 'vn-tak/Tako-san',
    mainSha, reviewedSha, actor, triggeringActor: actor, runId: '42', runAttempt: '1',
    ci: { id: 400, attempt: 1, headSha: mainSha },
    approval: { environment: 'production', state: 'approved', reviewer: 'vn-taphoanhatung', actor,
      historySha256: 'c'.repeat(64), policySha256: 'd'.repeat(64) } };
  values.capture.authorizationSha256 = captureDigest(values.authorization);
  const env = { PATH: process.env.PATH, RUNNER_TEMP: temp(),
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: mainSha,
    GITHUB_REPOSITORY: 'vn-tak/Tako-san', GITHUB_REPOSITORY_ID: '1385308553',
    GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', GITHUB_ACTOR: actor, GITHUB_TRIGGERING_ACTOR: actor,
    RELEASE_REF: mainSha, REVIEWED_SHA: reviewedSha, CONFIRM_T21RC_READ_ONLY_CAPTURE: 'true' };
  writePrivateJson('authorization.json', values.authorization, env);
  writePrivateJson('capture-verified.json', values.capture, env);
  writePrivateJson('classifier-input.json', values.input, env);
  return { values, env };
}

describe('T21R-C2D credential-free classify command boundaries', () => {
  it('maps a loader contradiction in the real command and never invokes a subprocess', async () => {
    const { env } = storedFixture();
    const execute = vi.fn();
    await expect(runT21RC2CaptureCommand('classify', { env, execute,
      loadAuthority: async () => { throw privateError(); } }))
      .rejects.toThrow('T21RC2_CLASSIFICATION_AUTHORITY_REJECTED');
    expect(execute).not.toHaveBeenCalled();
  });

  it('the real CLI logs only the specific binding code and records a sanitized failure receipt', () => {
    const { env } = storedFixture();
    const changed = JSON.parse(readFileSync(path.join(env.RUNNER_TEMP, 't21rc2', 'classifier-input.json'), 'utf8'));
    changed.occurrences[0].name = privateMarkers[3];
    rmSync(path.join(env.RUNNER_TEMP, 't21rc2', 'classifier-input.json'));
    writePrivateJson('classifier-input.json', changed, env);
    const child = spawnSync(process.execPath, ['scripts/t21rc2-production-capture.mjs', 'classify'], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(child.stderr.trim()).toBe('t21rc2=T21RC2_CLASSIFICATION_CAPTURE_BINDING_REJECTED');
    const receipt = readFileSync(runnerPaths(env).publicReceipt, 'utf8');
    expect(JSON.parse(receipt).classificationDiagnostic.stage).toBe('capture_binding');
    privateMarkers.forEach((marker) => expect(`${child.stdout}${child.stderr}${receipt}`).not.toContain(marker));
    expect(() => readFileSync(path.join(env.RUNNER_TEMP, 't21rc2', 'row-manifest.json'))).toThrow();
  });
});

describe('T21R-C2D classification failure stages', () => {
  it.each([
    ['status', (values) => { values.capture.status = 'INVALID'; }],
    ['authorization digest', (values) => { values.authorization.source = 'changed'; }],
    ['authority proof', (values) => { values.capture.authorityProof = { ...proof, reviewedBridgeCount: 1 }; }],
    ['capture counts', (values) => { values.capture.counts = { recipeCount: 1, ingredientOccurrenceCount: 2 }; }],
  ])('retains the %s capture-binding guard', async (_, mutate) => {
    const values = fixture();
    mutate(values);
    await expect(classifyT21RC2Snapshot(values))
      .rejects.toThrow('T21RC2_CLASSIFICATION_CAPTURE_BINDING_REJECTED');
  });

  it('reports capture binding rather than a generic classification rejection', async () => {
    const values = fixture();
    values.capture.snapshotDigestSha256 = '0'.repeat(64);
    await expect(classifyT21RC2Snapshot(values))
      .rejects.toThrow('T21RC2_CLASSIFICATION_CAPTURE_BINDING_REJECTED');
  });

  it('reports authority loader contradictions independently of reconciliation', async () => {
    const values = fixture();
    delete values.authority;
    values.loadAuthority = async () => { throw new Error('T21RC_AUTHORITY_CONTRADICTION'); };
    await expect(classifyT21RC2Snapshot(values))
      .rejects.toThrow('T21RC2_CLASSIFICATION_AUTHORITY_REJECTED');
  });

  it('rejects a missing authority-loader result at the authority stage', async () => {
    const values = fixture();
    delete values.authority;
    values.loadAuthority = async () => null;
    await expect(classifyT21RC2Snapshot(values))
      .rejects.toThrow('T21RC2_CLASSIFICATION_AUTHORITY_REJECTED');
  });

  it('preserves the authority category when reconciliation surfaces an authority contradiction', async () => {
    vi.spyOn(reconciliation, 'reconcileIngredientOccurrences').mockImplementation(() => {
      throw Object.assign(new Error('PRIVATE_AUTHORITY_CONTEXT'), { code: 'T21RC_AUTHORITY_CONTRADICTION' });
    });
    await expect(classifyT21RC2Snapshot(fixture()))
      .rejects.toThrow('T21RC2_CLASSIFICATION_AUTHORITY_REJECTED');
  });

  it('reports reconciliation exceptions without their raw context', async () => {
    const values = fixture({ rows: [row({ unexpected: 'PRIVATE_ROW_CONTEXT' })] });
    await expect(classifyT21RC2Snapshot(values))
      .rejects.toThrow('T21RC2_CLASSIFICATION_RECONCILIATION_REJECTED');
  });

  it.each([
    ['schema', (manifest) => { manifest.production[0].classification = 'invalid'; }],
    ['aggregate', (manifest) => { manifest.summary.productionClassCounts.EXACT_V1_MATCH += 1; }],
    ['digest', (manifest) => { manifest.digests.classificationSha256 = '0'.repeat(64); }],
  ])('reports the %s validator stage independently', async (stage, mutate) => {
    const values = fixture();
    const manifest = manifestFor(values);
    mutate(manifest);
    vi.spyOn(reconciliation, 'reconcileIngredientOccurrences').mockReturnValue(manifest);
    await expect(classifyT21RC2Snapshot(values))
      .rejects.toThrow(`T21RC2_CLASSIFICATION_${stage.toUpperCase()}_REJECTED`);
  });
});
