import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureDigest } from '../../scripts/t21rc2-production-capture.mjs';
import {
  buildT21RC2FailureReceipt,
  runnerPaths,
  safeT21RC2SchemaDiagnostic,
  T21RC2_SCHEMA_DIAGNOSTIC_FIELDS,
  T21RC2_SCHEMA_DIAGNOSTIC_KEYWORDS,
  T21RC2_SCHEMA_DIAGNOSTIC_SECTIONS,
  writePrivateJson,
} from '../../scripts/t21rc2-production-files.mjs';
import { validateT21RC2ManifestSchema } from '../../scripts/t21rc2-production-receipt.mjs';
import * as reconciliation from '../../scripts/t21rc-row-reconciliation.mjs';

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCHEMA_URL = new URL('../../docs/ai/recipe-catalog/T21RC_ROW_RECONCILIATION_SCHEMA.json', import.meta.url);
const SCHEMA_REJECTION = 'T21RC2_CLASSIFICATION_SCHEMA_REJECTED';
const PRIVATE_MARKERS = [
  'PRIVATE_RECIPE_ID', 'PRIVATE_INGREDIENT_ID', 'PRIVATE_INGREDIENT_NAME', '987654.125',
  'private@example.invalid', 'FAKE_API_TOKEN', 'PRIVATE_ACCOUNT_NAME', 'PRIVATE_PHYSICAL_ROW',
];

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

const temporaryDirectories = [];
function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), 't21rc2-schema-diagnostic-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function schemaPropertyNames() {
  const schema = JSON.parse(readFileSync(SCHEMA_URL, 'utf8'));
  const fields = new Set();
  const visitedReferences = new Set();
  const schemaChildren = [
    'items', 'additionalProperties', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'contains',
  ];

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.$ref === 'string') {
      const reference = node.$ref;
      if (!reference.startsWith('#/definitions/') || visitedReferences.has(reference)) return;
      visitedReferences.add(reference);
      const target = reference.slice(2).split('/').reduce((value, part) => {
        const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
        return value?.[key];
      }, schema);
      visit(target);
      return;
    }
    for (const [field, child] of Object.entries(node.properties ?? {})) {
      fields.add(field);
      visit(child);
    }
    for (const keyword of schemaChildren) {
      const child = node[keyword];
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  }

  visit(schema);
  return fields;
}

function schemaFailure(mutate) {
  const manifest = manifestFor();
  expect(validateT21RC2ManifestSchema(manifest)).toBe(true);
  mutate(manifest);
  let error;
  try {
    validateT21RC2ManifestSchema(manifest);
  } catch (caught) {
    error = caught;
  }
  expect(typeof error).toBe('object');
  expect(error.message).toBe(SCHEMA_REJECTION);
  expect(error.code).toBe(SCHEMA_REJECTION);
  return { error, diagnostic: safeT21RC2SchemaDiagnostic(error) };
}

async function diagnosticFromValidatorError(ajvError) {
  vi.resetModules();
  const requireFromTest = createRequire(import.meta.url);
  const Ajv = createRequire(requireFromTest.resolve('eslint/package.json'))('ajv');
  const validator = () => false;
  validator.errors = [ajvError];
  const compile = vi.spyOn(Ajv.prototype, 'compile').mockReturnValue(validator);
  try {
    const files = await import('../../scripts/t21rc2-production-files.mjs');
    expect(files).not.toHaveProperty('t21rc2SchemaError');
    let error;
    try {
      files.validateT21RC2ManifestSchemaBoundary({});
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(SCHEMA_REJECTION);
    expect(error.code).toBe(SCHEMA_REJECTION);
    expect(compile).toHaveBeenCalledExactlyOnceWith(expect.any(Object));
    return { files, error, diagnostic: files.safeT21RC2SchemaDiagnostic(error) };
  } finally {
    compile.mockRestore();
    vi.resetModules();
  }
}

describe('T21RC2 schema diagnostic allowlists', () => {
  it('matches every reachable manifest property in the closed schema', () => {
    const reachableFields = schemaPropertyNames();
    expect(reachableFields.size).toBe(118);
    expect([...T21RC2_SCHEMA_DIAGNOSTIC_FIELDS].sort())
      .toEqual([...new Set([...reachableFields, 'unknown'])].sort());
    expect(T21RC2_SCHEMA_DIAGNOSTIC_FIELDS.length)
      .toBe(new Set(T21RC2_SCHEMA_DIAGNOSTIC_FIELDS).size);
    expect(T21RC2_SCHEMA_DIAGNOSTIC_FIELDS).toContain('unknown');
    expect(Object.isFrozen(T21RC2_SCHEMA_DIAGNOSTIC_FIELDS)).toBe(true);
  });

  it('keeps section and keyword vocabularies fixed', () => {
    expect(T21RC2_SCHEMA_DIAGNOSTIC_SECTIONS).toEqual([
      'root', 'captureEvidence', 'production', 'target', 'recipes', 'summary', 'authorityProof', 'digests', 'unknown',
    ]);
    expect(T21RC2_SCHEMA_DIAGNOSTIC_KEYWORDS).toEqual([
      'type', 'required', 'enum', 'pattern', 'minimum', 'maximum', 'minLength', 'maxLength',
      'minItems', 'maxItems', 'uniqueItems', 'additionalProperties', 'const', 'oneOf', 'anyOf',
      'allOf', 'if', 'contains', 'unknown',
    ]);
    expect(T21RC2_SCHEMA_DIAGNOSTIC_KEYWORDS).toHaveLength(19);
    expect(Object.isFrozen(T21RC2_SCHEMA_DIAGNOSTIC_SECTIONS)).toBe(true);
    expect(Object.isFrozen(T21RC2_SCHEMA_DIAGNOSTIC_KEYWORDS)).toBe(true);
  });
});

const schemaMutations = [
  {
    name: 'type in a production occurrence',
    mutate: (manifest) => { manifest.production[0].occurrenceKey = 7; },
    expected: { section: 'production', field: 'occurrenceKey', keyword: 'type', code: 'PRODUCTION_OCCURRENCE_KEY_TYPE' },
  },
  {
    name: 'required in a recipe summary',
    mutate: (manifest) => { delete manifest.recipes[0].status; },
    expected: { section: 'recipes', field: 'recipes', keyword: 'required', code: 'RECIPES_REQUIRED' },
  },
  {
    name: 'enum in a production classification',
    mutate: (manifest) => { manifest.production[0].classification = 'PRIVATE_ENUM_VALUE'; },
    expected: { section: 'production', field: 'classification', keyword: 'enum', code: 'PRODUCTION_CLASSIFICATION_ENUM' },
  },
  {
    name: 'pattern in a digest',
    mutate: (manifest) => { manifest.digests.classificationSha256 = 'not-a-sha256'; },
    expected: { section: 'digests', field: 'classificationSha256', keyword: 'pattern', code: 'DIGESTS_CLASSIFICATION_SHA256_PATTERN' },
  },
  {
    name: 'minimum in summary accounting',
    mutate: (manifest) => { manifest.summary.accounting.productionClassSum = -1; },
    expected: { section: 'summary', field: 'productionClassSum', keyword: 'minimum', code: 'SUMMARY_ACCOUNTING_PRODUCTION_CLASS_SUM_MINIMUM' },
  },
  {
    name: 'maximum in capture evidence',
    mutate: (manifest) => { manifest.captureEvidence.recipeCount = Number.MAX_SAFE_INTEGER + 1; },
    expected: { section: 'captureEvidence', field: 'recipeCount', keyword: 'maximum', code: 'CAPTURE_EVIDENCE_RECIPE_COUNT_MAXIMUM' },
  },
  {
    name: 'minimum length in a summary recipe reference',
    mutate: (manifest) => { manifest.summary.largestDriftRecipes = [{ recipeId: '', count: 1 }]; },
    expected: { section: 'summary', field: 'recipeId', keyword: 'minLength', code: 'SUMMARY_LARGEST_DRIFT_RECIPES_RECIPE_ID_MIN_LENGTH' },
  },
  {
    name: 'maximum length in a summary recipe reference',
    mutate: (manifest) => { manifest.summary.largestDriftRecipes = [{ recipeId: 'R'.repeat(101), count: 1 }]; },
    expected: { section: 'summary', field: 'recipeId', keyword: 'maxLength', code: 'SUMMARY_LARGEST_DRIFT_RECIPES_RECIPE_ID_MAX_LENGTH' },
  },
  {
    name: 'minimum item count in production authority sources',
    mutate: (manifest) => { manifest.production[0].authority = []; },
    expected: { section: 'production', field: 'authority', keyword: 'minItems', code: 'PRODUCTION_AUTHORITY_MIN_ITEMS' },
  },
  {
    name: 'maximum item count in summary drift recipes',
    mutate: (manifest) => {
      manifest.summary.largestDriftRecipes = Array.from({ length: 11 }, () => ({ recipeId: 'synthetic-recipe', count: 1 }));
    },
    expected: { section: 'summary', field: 'largestDriftRecipes', keyword: 'maxItems', code: 'SUMMARY_LARGEST_DRIFT_RECIPES_MAX_ITEMS' },
  },
  {
    name: 'unique target candidate occurrence keys',
    mutate: (manifest) => {
      const key = manifest.target[0].candidateProductionOccurrenceKeys[0];
      manifest.target[0].candidateProductionOccurrenceKeys = [key, key];
    },
    expected: {
      section: 'target', field: 'candidateProductionOccurrenceKeys', keyword: 'uniqueItems',
      code: 'TARGET_CANDIDATE_PRODUCTION_OCCURRENCE_KEYS_UNIQUE_ITEMS',
    },
  },
  {
    name: 'conditional maximum candidate count under target mapping UNIQUE',
    mutate: (manifest) => {
      manifest.target[0].candidateProductionOccurrenceKeys.push(`p:${'0'.repeat(64)}:1`);
    },
    expected: {
      section: 'target', field: 'candidateProductionOccurrenceKeys', keyword: 'maxItems',
      code: 'TARGET_CANDIDATE_PRODUCTION_OCCURRENCE_KEYS_MAX_ITEMS',
    },
  },
  {
    name: 'conditional minimum candidate count under production mapping UNIQUE',
    mutate: (manifest) => { manifest.production[0].candidateTargetOccurrenceKeys = []; },
    expected: {
      section: 'production', field: 'candidateTargetOccurrenceKeys', keyword: 'minItems',
      code: 'PRODUCTION_CANDIDATE_TARGET_OCCURRENCE_KEYS_MIN_ITEMS',
    },
  },
  {
    name: 'const in the root manifest',
    mutate: (manifest) => { manifest.schemaVersion = 2; },
    expected: { section: 'root', field: 'schemaVersion', keyword: 'const', code: 'ROOT_SCHEMA_VERSION_CONST' },
  },
  {
    name: 'additional root property',
    mutate: (manifest) => { manifest.PRIVATE_PHYSICAL_ROW = PRIVATE_MARKERS.join('|'); },
    expected: { section: 'root', field: 'unknown', keyword: 'additionalProperties', code: 'ROOT_ADDITIONAL_PROPERTIES' },
  },
  {
    name: 'nullable authority proof reports its first null-branch type error',
    mutate: (manifest) => { manifest.authorityProof = 'PRIVATE_ACCOUNT_NAME'; },
    expected: { section: 'authorityProof', field: 'authorityProof', keyword: 'type', code: 'AUTHORITY_PROOF_TYPE' },
  },
  {
    name: 'nullable review reason reports its first null-branch type error',
    mutate: (manifest) => { manifest.production[0].reviewReason = 'PRIVATE_REASON'; },
    expected: { section: 'production', field: 'reviewReason', keyword: 'type', code: 'PRODUCTION_REVIEW_REASON_TYPE' },
  },
];

describe('T21RC2 Ajv 6.15 schema diagnostic mapping', () => {
  it.each(schemaMutations)('$name', ({ mutate, expected }) => {
    const { diagnostic } = schemaFailure(mutate);
    expect(diagnostic).toEqual(expected);
    expect(Object.keys(diagnostic).sort()).toEqual(['code', 'field', 'keyword', 'section']);
  });

  it('maps a recognized anyOf schema location through the actual validator boundary', async () => {
    const { diagnostic } = await diagnosticFromValidatorError({
      keyword: 'anyOf', schemaPath: '#/properties/authorityProof/anyOf', dataPath: '/authorityProof',
      message: PRIVATE_MARKERS.join('|'), data: PRIVATE_MARKERS, params: { value: PRIVATE_MARKERS },
    });
    expect(diagnostic).toEqual({
      section: 'authorityProof', field: 'authorityProof', keyword: 'anyOf', code: 'AUTHORITY_PROOF_ANY_OF',
    });
  });

  it.each([
    ['allOf', '#/definitions/productionEvidence/allOf', '/production/0', 'PRODUCTION_ALL_OF', 'production', 'production'],
    ['if', '#/definitions/productionEvidence/allOf/0/if', '/production/0', 'PRODUCTION_IF', 'production', 'production'],
    ['contains', '#/definitions/productionEvidence/allOf/1/then/properties/authority/contains',
      '/production/0/authority', 'PRODUCTION_AUTHORITY_CONTAINS', 'production', 'authority'],
  ])('maps schema keyword %s via its visited schema path', async (keyword, schemaPath, dataPath, code, section, field) => {
    const { diagnostic } = await diagnosticFromValidatorError({ keyword, schemaPath, dataPath });
    expect(diagnostic).toEqual({ section, field, keyword, code });
  });

  it('snapshots Ajv keyword and paths exactly once before constructing a safe report', async () => {
    const reads = { keyword: 0, schemaPath: 0, dataPath: 0 };
    const ajvError = {
      get keyword() { return reads.keyword++ === 0 ? 'enum' : PRIVATE_MARKERS[0]; },
      get schemaPath() {
        return reads.schemaPath++ === 0 ? '#/definitions/productionClassification/enum' : PRIVATE_MARKERS[1];
      },
      get dataPath() {
        return reads.dataPath++ === 0 ? '/production/0/classification' : PRIVATE_MARKERS[2];
      },
      message: PRIVATE_MARKERS.join('|'),
    };
    const { diagnostic } = await diagnosticFromValidatorError(ajvError);
    expect(reads).toEqual({ keyword: 1, schemaPath: 1, dataPath: 1 });
    expect(diagnostic).toEqual({
      section: 'production', field: 'classification', keyword: 'enum', code: 'PRODUCTION_CLASSIFICATION_ENUM',
    });
  });

  it('preserves the first deterministic diagnostic for identical manifest bytes', () => {
    const manifest = manifestFor();
    manifest.PRIVATE_PHYSICAL_ROW = PRIVATE_MARKERS.join('|');
    const bytes = JSON.stringify(manifest);
    const validateBytes = () => {
      let error;
      try {
        validateT21RC2ManifestSchema(JSON.parse(bytes));
      } catch (caught) {
        error = caught;
      }
      return safeT21RC2SchemaDiagnostic(error);
    };
    expect(validateBytes()).toEqual({
      section: 'root', field: 'unknown', keyword: 'additionalProperties', code: 'ROOT_ADDITIONAL_PROPERTIES',
    });
    expect(validateBytes()).toEqual(validateBytes());
  });

  it('returns fresh diagnostics and receipts after callers mutate prior safe objects', () => {
    const { error, diagnostic } = schemaFailure((manifest) => { manifest.schemaVersion = 99; });
    const expected = { section: 'root', field: 'schemaVersion', keyword: 'const', code: 'ROOT_SCHEMA_VERSION_CONST' };
    expect(diagnostic).toEqual(expected);
    try {
      Object.assign(diagnostic, { section: 'PRIVATE_ACCOUNT_NAME', field: PRIVATE_MARKERS[0], code: PRIVATE_MARKERS[1] });
    } catch {
      // A frozen safe result is also acceptable.
    }
    expect(safeT21RC2SchemaDiagnostic(error)).toEqual(expected);

    const firstReceipt = buildT21RC2FailureReceipt(error);
    try {
      Object.assign(firstReceipt.classificationDiagnostic.diagnostic, { keyword: PRIVATE_MARKERS[2], code: PRIVATE_MARKERS[3] });
    } catch {
      // A frozen receipt diagnostic is also acceptable.
    }
    expect(buildT21RC2FailureReceipt(error).classificationDiagnostic.diagnostic).toEqual(expected);
  });
});

describe('T21RC2 diagnostic fail-closed mapping and privacy', () => {
  it.each([
    ['unknown schema path', {
      keyword: 'pattern', schemaPath: '#/definitions/notAStaticSchema/pattern', dataPath: '/production/0/classification',
    }, 'pattern'],
    ['unknown keyword', {
      keyword: 'PRIVATE_UNKNOWN_KEYWORD', schemaPath: '#/definitions/productionClassification/enum',
      dataPath: '/production/0/classification',
    }, 'unknown'],
    ['wrong keyword and schema path pairing', {
      keyword: 'pattern', schemaPath: '#/definitions/productionClassification/enum',
      dataPath: '/production/0/classification',
    }, 'pattern'],
    ['unknown property path', {
      keyword: 'additionalProperties', schemaPath: '#/additionalProperties', dataPath: '/production/0/PRIVATE_PHYSICAL_ROW',
    }, 'additionalProperties'],
    ['unreachable oneOf contract', {
      keyword: 'oneOf', schemaPath: '#/definitions/rawOccurrence/oneOf', dataPath: '/occurrences/0',
    }, 'oneOf'],
  ])('falls back safely for %s', async (_, ajvError, safeKeyword) => {
    const { diagnostic } = await diagnosticFromValidatorError({
      ...ajvError, message: PRIVATE_MARKERS.join('|'), params: { value: PRIVATE_MARKERS },
    });
    expect(diagnostic).toEqual({
      section: 'unknown', field: 'unknown', keyword: safeKeyword, code: 'UNKNOWN_SCHEMA_CONTRACT',
    });
  });

  it('redacts every Ajv source and publishes only the reconstructed safe diagnostic', async () => {
    const privateValue = PRIVATE_MARKERS.join('|');
    const ajvError = Object.assign(new Error(privateValue), {
      keyword: 'enum',
      schemaPath: '#/definitions/productionClassification/enum',
      dataPath: '/production/0/classification',
      message: privateValue,
      data: { value: privateValue, markers: PRIVATE_MARKERS },
      params: { allowedValues: PRIVATE_MARKERS, value: privateValue },
      instancePath: privateValue,
      parentSchema: { enum: PRIVATE_MARKERS },
      stdout: privateValue,
      stderr: privateValue,
      cause: { message: privateValue, data: PRIVATE_MARKERS },
      section: privateValue,
      field: privateValue,
      code: privateValue,
      path: privateValue,
      classificationDiagnostic: { section: privateValue, field: privateValue, keyword: privateValue, code: privateValue },
    });
    const { files, error, diagnostic } = await diagnosticFromValidatorError(ajvError);
    const expected = { section: 'production', field: 'classification', keyword: 'enum', code: 'PRODUCTION_CLASSIFICATION_ENUM' };
    expect(error.message).toBe(SCHEMA_REJECTION);
    expect(error.toString()).toBe(`Error: ${SCHEMA_REJECTION}`);
    expect(JSON.stringify(error)).toBe(`{"code":"${SCHEMA_REJECTION}"}`);
    expect(diagnostic).toEqual(expected);

    const directory = temporaryDirectory();
    const githubOutput = path.join(directory, 'github-output.txt');
    const env = { RUNNER_TEMP: directory, GITHUB_OUTPUT: githubOutput };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stdoutWrite = vi.spyOn(process.stdout, 'write');
    const stderrWrite = vi.spyOn(process.stderr, 'write');
    files.recordT21RC2Failure(error, env, REPOSITORY_ROOT);
    const receiptText = readFileSync(files.runnerPaths(env, REPOSITORY_ROOT).publicReceipt, 'utf8');
    const receipt = JSON.parse(receiptText);
    expect(receipt.classificationDiagnostic.diagnostic).toEqual(expected);
    expect(consoleError).toHaveBeenCalledExactlyOnceWith(`t21rc2_schema=${JSON.stringify(expected)}`);
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(existsSync(githubOutput)).toBe(false);

    const published = [error.message, error.toString(), error.stack, JSON.stringify(error), receiptText,
      JSON.stringify(consoleError.mock.calls), JSON.stringify(consoleLog.mock.calls),
      JSON.stringify(consoleWarn.mock.calls), JSON.stringify(stdoutWrite.mock.calls),
      JSON.stringify(stderrWrite.mock.calls)].join('\n');
    for (const marker of PRIVATE_MARKERS) expect(published).not.toContain(marker);
    for (const forbidden of ['instancePath', 'dataPath', 'schemaPath', 'parentSchema', 'params', 'stdout', 'stderr', 'cause']) {
      expect(receiptText).not.toContain(`"${forbidden}"`);
    }
  });

  it('does not trust caller metadata or a plain schema-coded Error', () => {
    const privateValue = PRIVATE_MARKERS.join('|');
    const callerError = Object.assign(new Error(privateValue), {
      code: SCHEMA_REJECTION,
      section: 'production', field: 'classification', keyword: 'enum',
      schemaPath: '#/definitions/productionClassification/enum', dataPath: '/production/0/classification',
      path: privateValue, classificationDiagnostic: { section: 'production', field: 'classification',
        keyword: 'enum', code: 'PRODUCTION_CLASSIFICATION_ENUM', data: PRIVATE_MARKERS },
    });
    const expected = { section: 'unknown', field: 'unknown', keyword: 'unknown', code: 'UNKNOWN_SCHEMA_CONTRACT' };
    expect(safeT21RC2SchemaDiagnostic(callerError)).toEqual(expected);
    const receipt = buildT21RC2FailureReceipt(callerError);
    expect(receipt.classificationDiagnostic.diagnostic).toEqual(expected);
    for (const marker of PRIVATE_MARKERS) expect(JSON.stringify(receipt)).not.toContain(marker);
  });

  it('does not brand an untrusted keyword, path, or caller diagnostic field', async () => {
    const privateValue = PRIVATE_MARKERS.join('|');
    const ajvError = Object.assign(new Error(privateValue), {
      keyword: PRIVATE_MARKERS[0], schemaPath: privateValue, dataPath: privateValue, instancePath: privateValue,
      message: privateValue, data: PRIVATE_MARKERS, params: { value: PRIVATE_MARKERS },
      parentSchema: { values: PRIVATE_MARKERS }, stdout: privateValue, stderr: privateValue,
      cause: { message: privateValue }, section: PRIVATE_MARKERS[1], field: PRIVATE_MARKERS[2],
      code: PRIVATE_MARKERS[3], path: privateValue,
    });
    const { files, error, diagnostic } = await diagnosticFromValidatorError(ajvError);
    const expected = { section: 'unknown', field: 'unknown', keyword: 'unknown', code: 'UNKNOWN_SCHEMA_CONTRACT' };
    expect(diagnostic).toEqual(expected);

    const directory = temporaryDirectory();
    const env = { RUNNER_TEMP: directory, GITHUB_OUTPUT: path.join(directory, 'github-output.txt') };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    files.recordT21RC2Failure(error, env, REPOSITORY_ROOT);
    const receiptText = readFileSync(files.runnerPaths(env, REPOSITORY_ROOT).publicReceipt, 'utf8');
    expect(JSON.parse(receiptText).classificationDiagnostic.diagnostic).toEqual(expected);
    const published = `${error.message}\n${JSON.stringify(error)}\n${receiptText}\n${JSON.stringify(consoleError.mock.calls)}`;
    for (const marker of PRIVATE_MARKERS) expect(published).not.toContain(marker);
    expect(existsSync(env.GITHUB_OUTPUT)).toBe(false);
  });
});

function storedFixture(values = fixture()) {
  const mainSha = 'a'.repeat(40), reviewedSha = 'b'.repeat(40), actor = 'synthetic-operator';
  values.authorization = { schemaVersion: 1, repositoryId: 1385308553, repository: 'vn-tak/Tako-san',
    mainSha, reviewedSha, actor, triggeringActor: actor, runId: '42', runAttempt: '1',
    ci: { id: 400, attempt: 1, headSha: mainSha },
    approval: { environment: 'production', state: 'approved', reviewer: 'vn-taphoanhatung', actor,
      historySha256: 'c'.repeat(64), policySha256: 'd'.repeat(64) } };
  values.capture.authorizationSha256 = captureDigest(values.authorization);
  const env = { PATH: process.env.PATH, RUNNER_TEMP: temporaryDirectory(),
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: mainSha,
    GITHUB_REPOSITORY: 'vn-tak/Tako-san', GITHUB_REPOSITORY_ID: '1385308553',
    GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', GITHUB_ACTOR: actor, GITHUB_TRIGGERING_ACTOR: actor,
    RELEASE_REF: mainSha, REVIEWED_SHA: reviewedSha, CONFIRM_T21RC_READ_ONLY_CAPTURE: 'true' };
  writePrivateJson('authorization.json', values.authorization, env, REPOSITORY_ROOT);
  writePrivateJson('capture-verified.json', values.capture, env, REPOSITORY_ROOT);
  writePrivateJson('classifier-input.json', values.input, env, REPOSITORY_ROOT);
  return { values, env };
}

function writeDiagnosticLoader(directory) {
  const loaderPath = path.join(directory, 't21rc2-diagnostic-loader.mjs');
  const preloadPath = path.join(directory, 't21rc2-diagnostic-preload.mjs');
  const authorityUrl = pathToFileURL(path.join(REPOSITORY_ROOT, 'scripts/t21r-v1-authority.mjs')).href;
  const reconciliationUrl = pathToFileURL(path.join(REPOSITORY_ROOT, 'scripts/t21rc-row-reconciliation.mjs')).href;
  const loaderSource = `
const authorityUrl = ${JSON.stringify(authorityUrl)};
const reconciliationUrl = ${JSON.stringify(reconciliationUrl)};

export async function load(url, context, nextLoad) {
  if (url === authorityUrl) {
    const encodedAuthority = JSON.stringify(process.env.T21RC2_TEST_AUTHORITY);
    return {
      format: 'module',
      shortCircuit: true,
      source: 'export async function loadCertifiedV1Authority() { return JSON.parse(' + encodedAuthority + '); }',
    };
  }

  const loaded = await nextLoad(url, context);
  if (url !== reconciliationUrl) return loaded;
  const sourceText = typeof loaded.source === 'string'
    ? loaded.source : Buffer.from(loaded.source).toString('utf8');
  const declaration = 'export function reconcileIngredientOccurrences({';
  if (!sourceText.includes(declaration)) throw new Error('T21RC2_TEST_RECONCILIATION_WRAP_REJECTED');
  const renamedSource = sourceText.replace(
    declaration,
    'function __t21rc2OriginalReconcileIngredientOccurrences({',
  );
  const wrapperSource = [
    '',
    'export function reconcileIngredientOccurrences(input) {',
    '  const manifest = __t21rc2OriginalReconcileIngredientOccurrences(input);',
    '  manifest["PRIVATE_PHYSICAL_ROW"] = process.env.T21RC2_TEST_PRIVATE_MARKERS;',
    '  return manifest;',
    '}',
    '',
  ].join(String.fromCharCode(10));
  const wrappedSource = renamedSource + wrapperSource;
  return { ...loaded, source: wrappedSource, shortCircuit: true };
}
`;
  writeFileSync(loaderPath, loaderSource);
  writeFileSync(preloadPath, [
    "import { register } from 'node:module';",
    `register(${JSON.stringify(pathToFileURL(loaderPath).href)}, import.meta.url);`,
    '',
  ].join(String.fromCharCode(10)));
  return preloadPath;
}

describe('T21RC2 real classify CLI schema-failure boundary', () => {
  it('prints and receipts only a safe diagnostic for a synthetic forced schema failure', () => {
    const privateName = [PRIVATE_MARKERS[2], PRIVATE_MARKERS[4], PRIVATE_MARKERS[5], PRIVATE_MARKERS[6]].join(' ');
    const item = ingredient({ ingredientId: PRIVATE_MARKERS[1], name: privateName, requiredQuantity: 987654.125 });
    const values = fixture({
      targetRecipes: [{ id: PRIVATE_MARKERS[0], ingredients: [item] }],
      rows: [row({ id: PRIVATE_MARKERS[7], recipe_id: PRIVATE_MARKERS[0], ingredient_id: PRIVATE_MARKERS[1],
        name: privateName, required_quantity: 987654.125 })],
      canonicalIngredientIds: [PRIVATE_MARKERS[1]],
    });
    const { env } = storedFixture(values);
    const preloadPath = writeDiagnosticLoader(env.RUNNER_TEMP);
    const githubOutput = path.join(env.RUNNER_TEMP, 'github-output.txt');
    const diagnostic = {
      section: 'root', field: 'unknown', keyword: 'additionalProperties', code: 'ROOT_ADDITIONAL_PROPERTIES',
    };
    const childEnv = {
      ...env,
      GITHUB_OUTPUT: githubOutput,
      NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
      T21RC2_TEST_AUTHORITY: JSON.stringify(values.authority),
      T21RC2_TEST_PRIVATE_MARKERS: PRIVATE_MARKERS.join('|'),
    };

    expect(childEnv).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
    expect(childEnv).not.toHaveProperty('CLOUDFLARE_ACCOUNT_ID');
    const child = spawnSync(process.execPath, ['scripts/t21rc2-production-capture.mjs', 'classify'], {
      cwd: REPOSITORY_ROOT, env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
    });
    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(child.stderr).toBe(
      `t21rc2_schema=${JSON.stringify(diagnostic)}\nt21rc2=${SCHEMA_REJECTION}\n`,
    );

    const paths = runnerPaths(childEnv, REPOSITORY_ROOT);
    const receiptText = readFileSync(paths.publicReceipt, 'utf8');
    const receipt = JSON.parse(receiptText);
    expect(receipt.classificationDiagnostic).toEqual({
      schemaVersion: 1, status: SCHEMA_REJECTION, stage: 'schema', diagnostic,
    });
    expect(existsSync(path.join(paths.privateDirectory, 'row-manifest.json'))).toBe(false);
    expect(existsSync(path.join(paths.privateDirectory, 'capture-proof.json'))).toBe(false);
    expect(existsSync(githubOutput)).toBe(false);
    for (const marker of PRIVATE_MARKERS) {
      expect(`${child.stdout}${child.stderr}${receiptText}`).not.toContain(marker);
    }
  });
});
