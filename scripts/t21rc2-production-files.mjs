import { constants, lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const T21RC2_CLASSIFICATION_STAGES = Object.freeze({
  T21RC2_CLASSIFICATION_CAPTURE_BINDING_REJECTED: 'capture_binding',
  T21RC2_CLASSIFICATION_AUTHORITY_REJECTED: 'authority',
  T21RC2_CLASSIFICATION_RECONCILIATION_REJECTED: 'reconciliation',
  T21RC2_CLASSIFICATION_SCHEMA_REJECTED: 'schema',
  T21RC2_CLASSIFICATION_AGGREGATE_REJECTED: 'aggregate',
  T21RC2_CLASSIFICATION_DIGEST_REJECTED: 'digest',
});

export const T21RC2_ERROR_CODES = Object.freeze([
  'T21RC2_GATE_REJECTED', 'T21RC2_REVIEW_BINDING_REJECTED', 'T21RC2_APPROVAL_REJECTED', 'T21RC2_IDENTITY_REJECTED',
  'T21RC2_QUERY_REJECTED', 'T21RC2_QUERY_FAILED', 'T21RC2_CAPTURE_INCOMPLETE',
  'T21RC2_RECIPE_ROSTER_CHANGED', 'T21RC2_LEDGER_CHANGED',
  'T21RC2_PRODUCTION_SNAPSHOT_UNSTABLE', 'T21RC2_CLASSIFICATION_REJECTED',
  ...Object.keys(T21RC2_CLASSIFICATION_STAGES),
  'T21RC2_RECEIPT_REJECTED', 'T21RC2_PRIVATE_PATH_REJECTED',
]);
const PRIVATE_FILES = new Set([
  'authorization.json', 'authorization-final.json', 'capture-a.json', 'capture-b.json',
  'capture-observations.json', 'capture-verified.json', 'capture-proof.json', 'classifier-input.json', 'row-manifest.json',
]);

export const T21RC2_SCHEMA_DIAGNOSTIC_SECTIONS = Object.freeze([
  'root', 'captureEvidence', 'production', 'target', 'recipes', 'summary', 'authorityProof', 'digests', 'unknown',
]);
export const T21RC2_SCHEMA_DIAGNOSTIC_FIELDS = Object.freeze([
  'AMBIGUOUS', 'DETERMINISTIC_V1_COUNTERPART', 'DUPLICATE_SEMANTIC_OCCURRENCE', 'EXACT_V1_MATCH',
  'ID_CONFLICT_REVIEW_REQUIRED', 'MALFORMED', 'MALFORMED_OCCURRENCE', 'NON_V1_CANONICAL_ID',
  'PRODUCTION_ONLY_KNOWN_ID', 'PRODUCTION_ONLY_NEW_ID', 'REVIEWED_ID_BRIDGE', 'REVIEWED_NEW_ID',
  'SAME_ID_CONTENT_DRIFT', 'SATISFIED_DETERMINISTICALLY', 'SATISFIED_EXACT', 'TARGET_ONLY_MISSING',
  'UNKNOWN_ID', 'UNREVIEWED_ING_ENR', 'V1_ID', 'accounting', 'ambiguousProductionCount',
  'ambiguousTargetCount', 'approvedBatchesSha256', 'authority', 'authorityProof', 'baselineComparison',
  'bridgeEvidenceSha256', 'bridgedTupleMatches', 'candidateProductionOccurrenceKeys',
  'candidateTargetOccurrenceKeys', 'canonicalIdentity', 'canonicalRegistrySourceSha256',
  'canonicalTargetSha256', 'captureEvidence', 'certification', 'classification', 'classificationSha256',
  'comparison', 'completeness', 'confidence', 'count', 'deterministic', 'deterministicCounterpartCount',
  'digests', 'driftBreakdown', 'driftKind', 'driftRecipeCount', 'exactMatchCount', 'exactTupleMatches',
  'idConflictOccurrenceKeys', 'idConflictReviewRequired', 'identityPopulation', 'identityPopulations',
  'indeterminate', 'ingredientId', 'ingredientOccurrenceCount', 'largestDriftRecipes', 'mapping',
  'membership', 'membership_only', 'membership_plus_content', 'mode', 'multi_field', 'name',
  'name_only', 'name_plus_semantics', 'occurrenceKey', 'occurrenceSha256', 'optional', 'optional_only',
  'populations', 'production', 'productionAccounted', 'productionClassCounts', 'productionClassSum',
  'productionIngredientId', 'productionOccurrenceCount', 'productionOnlyCount', 'quantity',
  'quantity_only', 'quantity_optional', 'quantity_unit', 'recipe', 'recipeCount', 'recipeId',
  'recipeIdSetMatch', 'recipes', 'reconciliationSha256', 'releaseId', 'releaseManifestSha256',
  'repairAuthorized', 'reviewReason', 'reviewRequired', 'reviewRequiredCount', 'reviewedBridgeCount',
  'runtimeFingerprint', 'runtimePositionAuthority', 'sameIdContentDrift', 'sameIdDriftCount',
  'schemaVersion', 'semanticSha256', 'status', 'summary', 't21gStatus', 'target', 'targetAccounted',
  'targetClassCounts', 'targetClassSum', 'targetIngredientId', 'targetOccurrenceCount', 'targetOnlyCount',
  'unattributedProductionOccurrences', 'unit', 'unit_only', 'unit_optional', 'unknown',
  'unmatchedProductionLines', 'unmatchedTargetLines',
]);
export const T21RC2_SCHEMA_DIAGNOSTIC_KEYWORDS = Object.freeze([
  'type', 'required', 'enum', 'pattern', 'minimum', 'maximum', 'minLength', 'maxLength',
  'minItems', 'maxItems', 'uniqueItems', 'additionalProperties', 'const', 'oneOf', 'anyOf',
  'allOf', 'if', 'contains', 'unknown',
]);
const schemaFailureCategories = new WeakMap();
let schemaDiagnosticRules;
let manifestSchema;
let validateManifestSchema;
const unknownSchemaDiagnostic = (keyword = 'unknown') => Object.freeze({
  section: 'unknown', field: 'unknown', keyword, code: 'UNKNOWN_SCHEMA_CONTRACT',
});
const staticCode = (value) => value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

function closedManifestSchema() {
  manifestSchema ??= JSON.parse(readFileSync(new URL(
    '../docs/ai/recipe-catalog/T21RC_ROW_RECONCILIATION_SCHEMA.json', import.meta.url,
  ), 'utf8'));
  return manifestSchema;
}

function knownSchemaDiagnosticRules() {
  if (schemaDiagnosticRules) return schemaDiagnosticRules;
  const schema = closedManifestSchema();
  const rules = new Map();
  function visit(node, locations, fields, dataPattern, references) {
    if (node.$ref) {
      if (!/^#\/definitions\/[A-Za-z0-9_]+$/.test(node.$ref) || references.has(node.$ref)) return;
      const definition = schema.definitions[node.$ref.slice('#/definitions/'.length)];
      // Ajv 6 also reports paths relative to a separately compiled referenced definition.
      visit(definition, [node.$ref, '#'], fields, dataPattern, new Set([...references, node.$ref]));
      return;
    }
    const section = T21RC2_SCHEMA_DIAGNOSTIC_SECTIONS.includes(fields[0]) ? fields[0] : 'root';
    const field = fields.at(-1) ?? 'unknown';
    const codeFields = section === 'root' ? fields : fields.slice(1);
    for (const keyword of T21RC2_SCHEMA_DIAGNOSTIC_KEYWORDS) {
      if (!Object.hasOwn(node, keyword) || keyword === 'unknown') continue;
      const diagnostic = Object.freeze({
        section, field, keyword, code: [section, ...codeFields, keyword].map(staticCode).join('_'),
      });
      for (const location of locations) {
        const key = `${location}/${keyword}`;
        if (!rules.has(key)) rules.set(key, []);
        rules.get(key).push({ keyword, dataPath: new RegExp(`^${dataPattern}$`), diagnostic });
      }
    }
    for (const [property, child] of Object.entries(node.properties ?? {})) {
      if (!T21RC2_SCHEMA_DIAGNOSTIC_FIELDS.includes(property)) continue;
      visit(child, locations.map((location) => `${location}/properties/${property}`),
        [...fields, property], `${dataPattern}/${property}`, references);
    }
    if (node.items) {
      visit(node.items, locations.map((location) => `${location}/items`), fields,
        `${dataPattern}/(?:0|[1-9][0-9]*)`, references);
    }
    if (node.contains) {
      visit(node.contains, locations.map((location) => `${location}/contains`), fields,
        `${dataPattern}/(?:0|[1-9][0-9]*)`, references);
    }
    for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
      (node[keyword] ?? []).forEach((child, index) => visit(child,
        locations.map((location) => `${location}/${keyword}/${index}`), fields, dataPattern, references));
    }
    for (const keyword of ['if', 'then', 'else']) {
      if (node[keyword]) visit(node[keyword], locations.map((location) => `${location}/${keyword}`),
        fields, dataPattern, references);
    }
  }
  visit(schema, ['#'], [], '', new Set());
  schemaDiagnosticRules = rules;
  return rules;
}

function t21rc2SchemaError(ajvError) {
  let category = unknownSchemaDiagnostic();
  try {
    const keywordValue = ajvError?.keyword;
    const keyword = T21RC2_SCHEMA_DIAGNOSTIC_KEYWORDS.includes(keywordValue) ? keywordValue : 'unknown';
    const schemaPath = ajvError?.schemaPath;
    const dataPath = ajvError?.dataPath;
    category = unknownSchemaDiagnostic(keyword);
    if (keyword !== 'unknown' && typeof schemaPath === 'string'
        && typeof dataPath === 'string' && !/[\r\n]/.test(dataPath)) {
      category = knownSchemaDiagnosticRules().get(schemaPath)
        ?.find((rule) => rule.keyword === keyword && rule.dataPath.test(dataPath))?.diagnostic ?? category;
    }
  } catch {
    category = unknownSchemaDiagnostic();
  }
  const error = t21rc2Error('T21RC2_CLASSIFICATION_SCHEMA_REJECTED');
  schemaFailureCategories.set(error, category);
  return error;
}

export function validateT21RC2ManifestSchemaBoundary(manifest) {
  let schemaError;
  try {
    if (manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
        && (Object.getPrototypeOf(manifest) === Object.prototype || Object.getPrototypeOf(manifest) === null)) {
      if (!validateManifestSchema) {
        const nodeRequire = createRequire(import.meta.url);
        const Ajv = createRequire(nodeRequire.resolve('eslint/package.json'))('ajv');
        validateManifestSchema = new Ajv({ allErrors: false, jsonPointers: true }).compile(closedManifestSchema());
      }
      if (validateManifestSchema(manifest)) return true;
      schemaError = validateManifestSchema.errors?.[0];
    }
  } catch {
    // Validator exceptions never become diagnostic context.
  }
  throw t21rc2SchemaError(schemaError);
}

export function safeT21RC2SchemaDiagnostic(error) {
  return { ...(schemaFailureCategories.get(error) ?? unknownSchemaDiagnostic()) };
}

export function t21rc2Error(code) {
  const safe = T21RC2_ERROR_CODES.includes(code) ? code : 'T21RC2_CAPTURE_INCOMPLETE';
  const error = new Error(safe);
  error.code = safe;
  return error;
}

export function safeT21RC2Error(error) {
  try {
    const code = error?.code;
    return T21RC2_ERROR_CODES.includes(code) ? code : 'T21RC2_CAPTURE_INCOMPLETE';
  } catch {
    return 'T21RC2_CAPTURE_INCOMPLETE';
  }
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
  const reason = safeT21RC2Error(error);
  return {
    schemaVersion: 1, status: 'T21RC2_CAPTURE_BLOCKED', reason,
    ...(Object.hasOwn(T21RC2_CLASSIFICATION_STAGES, reason) ? {
      classificationDiagnostic: {
        schemaVersion: 1, status: reason, stage: T21RC2_CLASSIFICATION_STAGES[reason],
        ...(reason === 'T21RC2_CLASSIFICATION_SCHEMA_REJECTED'
          ? { diagnostic: safeT21RC2SchemaDiagnostic(error) } : {}),
      },
    } : {}),
    certification: 'NOT_A_RELEASE_CERTIFICATION', readOnly: true,
    productionMutations: 0, sqlWrites: 0, restores: 0, migrations: 0,
    applied0039: false, deploys: 0, repairAuthorized: false, t21gStatus: 'T21G_NOT_READY',
    rowLevelEvidenceDelivery: 'UNCONFIGURED',
  };
}

export function recordT21RC2Failure(error, env = process.env, cwd = process.cwd()) {
  if (safeT21RC2Error(error) === 'T21RC2_CLASSIFICATION_SCHEMA_REJECTED') {
    console.error(`t21rc2_schema=${JSON.stringify(safeT21RC2SchemaDiagnostic(error))}`);
  }
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
