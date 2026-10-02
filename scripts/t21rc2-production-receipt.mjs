#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCTION_D1 } from './d1-migration-check.mjs';
import {
  PRODUCTION_CLASSES,
  TARGET_CLASSES,
  serializeReconciliationManifest,
} from './t21rc-row-reconciliation.mjs';
import {
  T21RC2_ERROR_CODES,
  readPrivateJson,
  recordT21RC2Failure,
  safeT21RC2Error,
  t21rc2Error,
  writePublicReceipt,
} from './t21rc2-production-files.mjs';

const nodeRequire = createRequire(import.meta.url);
const Ajv = createRequire(nodeRequire.resolve('eslint/package.json'))('ajv');
const REPOSITORY_ID = 1385308553;
const REPOSITORY = 'vn-tako4/Tako-san';
const REVIEWER = 'vn-taphoanhatung';
const LEDGER_COUNT = 38;
const LEDGER_TIP = '0038_auth_onboarding_completion.sql';
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const isSha256 = (value) => typeof value === 'string' && value.length === 64 && SHA256.test(value);
const isGitSha = (value) => typeof value === 'string' && value.length === 40 && GIT_SHA.test(value);
const IDENTITY_POPULATIONS = Object.freeze([
  'V1_ID', 'NON_V1_CANONICAL_ID', 'REVIEWED_NEW_ID', 'UNREVIEWED_ING_ENR', 'UNKNOWN_ID', 'MALFORMED',
]);
const DRIFT_KINDS = Object.freeze([
  'quantity_only', 'unit_only', 'optional_only', 'quantity_unit', 'quantity_optional',
  'unit_optional', 'multi_field', 'membership_only', 'membership_plus_content',
  'name_only', 'name_plus_semantics', 'indeterminate',
]);
const AUTHORIZATION_KEYS = Object.freeze([
  'schemaVersion', 'repositoryId', 'repository', 'mainSha', 'reviewedSha', 'runId', 'runAttempt',
  'actor', 'triggeringActor', 'ci', 'approval',
]);
const CI_KEYS = Object.freeze(['id', 'attempt', 'headSha']);
const APPROVAL_KEYS = Object.freeze([
  'environment', 'state', 'reviewer', 'actor', 'historySha256', 'policySha256',
]);
const AUTHORITY_PROOF_KEYS = Object.freeze([
  'canonicalTargetSha256', 'releaseManifestSha256', 'approvedBatchesSha256',
  'canonicalRegistrySourceSha256', 'reconciliationSha256', 'releaseId', 'runtimeFingerprint',
  'reviewedBridgeCount',
]);

const TARGET_SPEC_BYTES = readFileSync(new URL(
  '../docs/ai/recipe-catalog/T21RA_RUNTIME_CANONICAL_TARGET.json',
  import.meta.url,
));
let targetSpec;
try {
  targetSpec = JSON.parse(TARGET_SPEC_BYTES.toString('utf8'));
} catch {
  throw t21rc2Error('T21RC2_CLASSIFICATION_REJECTED');
}

const target = targetSpec?.target;
if (targetSpec?.status !== 'T21RA_CANONICAL_TARGET_CERTIFIED'
    || targetSpec?.repository?.id !== REPOSITORY_ID
    || targetSpec?.repository?.resolvedNameAtReview !== REPOSITORY
    || targetSpec?.runtimePositionAuthority !== false
    || targetSpec?.productionMutations !== 0
    || target?.recipeCount !== 500
    || target?.historicalReplayIngredientLines !== 2702
    || typeof target?.releaseId !== 'string'
    || !isSha256(target?.expectedRuntimeFingerprint)
    || !isSha256(target?.releaseManifestFileSha256)
    || !isSha256(target?.approvedBatchesFileSha256)
    || PRODUCTION_D1.name !== 'frigo-db'
    || typeof PRODUCTION_D1.id !== 'string'
    || PRODUCTION_D1.id.length === 0) {
  throw t21rc2Error('T21RC2_CLASSIFICATION_REJECTED');
}

const PINNED_TARGET = Object.freeze({
  canonicalTargetSha256: createHash('sha256').update(TARGET_SPEC_BYTES).digest('hex'),
  releaseManifestSha256: target.releaseManifestFileSha256,
  approvedBatchesSha256: target.approvedBatchesFileSha256,
  releaseId: target.releaseId,
  runtimeFingerprint: target.expectedRuntimeFingerprint,
  recipeCount: target.recipeCount,
  targetOccurrenceCount: target.historicalReplayIngredientLines,
});

const manifestSchema = JSON.parse(readFileSync(new URL(
  '../docs/ai/recipe-catalog/T21RC_ROW_RECONCILIATION_SCHEMA.json',
  import.meta.url,
), 'utf8'));
const validateManifestSchema = new Ajv({ allErrors: false, jsonPointers: true }).compile(manifestSchema);

const isPlainObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const safeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const githubLogin = (value) => typeof value === 'string'
  && value.length > 0 && value.length <= 39
  && value.trim() === value
  && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value)
  && !value.includes('--');
const runId = (value) => typeof value === 'string'
  && value.trim() === value && /^[1-9][0-9]*$/.test(value);
const reject = (code) => { throw t21rc2Error(code); };
const digest = (value) => createHash('sha256').update(value).digest('hex');
const canonicalJson = (value) => serializeReconciliationManifest(value).slice(0, -1);

function exactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertAuthorization(authorization) {
  if (!exactKeys(authorization, AUTHORIZATION_KEYS)
      || authorization.schemaVersion !== 1
      || authorization.repositoryId !== REPOSITORY_ID
      || authorization.repository !== REPOSITORY
      || !isGitSha(authorization.mainSha)
      || !isGitSha(authorization.reviewedSha)
      || !runId(authorization.runId)
      || authorization.runAttempt !== '1'
      || !githubLogin(authorization.actor)
      || !githubLogin(authorization.triggeringActor)) {
    reject('T21RC2_IDENTITY_REJECTED');
  }

  if (!exactKeys(authorization.ci, CI_KEYS)
      || !Number.isSafeInteger(authorization.ci.id) || authorization.ci.id <= 0
      || !Number.isSafeInteger(authorization.ci.attempt) || authorization.ci.attempt <= 0
      || authorization.ci.headSha !== authorization.mainSha) {
    reject('T21RC2_IDENTITY_REJECTED');
  }

  const approval = authorization.approval;
  if (!exactKeys(approval, APPROVAL_KEYS)
      || approval.environment !== 'production'
      || approval.state !== 'approved'
      || approval.reviewer !== REVIEWER
      || approval.actor !== authorization.actor
      || approval.reviewer === authorization.actor
      || approval.reviewer === authorization.triggeringActor
      || !isSha256(approval.historySha256)
      || !isSha256(approval.policySha256)) {
    reject('T21RC2_APPROVAL_REJECTED');
  }
}

export function authorizationDigest(authorization) {
  try {
    assertAuthorization(authorization);
    return digest(canonicalJson(authorization));
  } catch (error) {
    if (T21RC2_ERROR_CODES.includes(error?.code)) throw error;
    reject('T21RC2_APPROVAL_REJECTED');
  }
}

function assertAuthorityProof(proof, requirePinned = false) {
  if (!exactKeys(proof, AUTHORITY_PROOF_KEYS)
      || !isSha256(proof.canonicalTargetSha256)
      || !isSha256(proof.releaseManifestSha256)
      || !isSha256(proof.approvedBatchesSha256)
      || !isSha256(proof.canonicalRegistrySourceSha256)
      || !isSha256(proof.reconciliationSha256)
      || !isSha256(proof.runtimeFingerprint)
      || !safeInteger(proof.reviewedBridgeCount)) {
    reject('T21RC2_CLASSIFICATION_REJECTED');
  }
  if (requirePinned
      && (proof.canonicalTargetSha256 !== PINNED_TARGET.canonicalTargetSha256
        || proof.releaseManifestSha256 !== PINNED_TARGET.releaseManifestSha256
        || proof.approvedBatchesSha256 !== PINNED_TARGET.approvedBatchesSha256
        || proof.releaseId !== PINNED_TARGET.releaseId
        || proof.runtimeFingerprint !== PINNED_TARGET.runtimeFingerprint)) {
    reject('T21RC2_CLASSIFICATION_REJECTED');
  }
}

function emptyCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function countBy(records, key, keys) {
  const counts = emptyCounts(keys);
  for (const record of records) {
    if (!Object.hasOwn(counts, record[key])) reject('T21RC2_CLASSIFICATION_REJECTED');
    counts[record[key]] += 1;
  }
  return counts;
}

function sameCounts(actual, expected, keys) {
  return isPlainObject(actual)
    && Object.keys(actual).length === keys.length
    && keys.every((key) => actual[key] === expected[key]);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function occurrenceKeys(records) {
  const values = records.map((record) => record.occurrenceKey);
  return new Set(values).size === values.length ? new Set(values) : null;
}

function canonicalEqual(left, right) {
  try {
    return serializeReconciliationManifest(left) === serializeReconciliationManifest(right);
  } catch {
    return false;
  }
}

function classificationDigest(manifest) {
  return digest(canonicalJson({
    captureEvidence: manifest.captureEvidence,
    production: manifest.production,
    target: manifest.target,
    recipes: manifest.recipes,
    summary: manifest.summary,
  }));
}

function validateManifestAndAggregate(manifest) {
  try {
    if (!isPlainObject(manifest) || !validateManifestSchema(manifest)) {
      reject('T21RC2_CLASSIFICATION_REJECTED');
    }
    assertAuthorityProof(manifest.authorityProof);
    if (!isSha256(manifest.digests.occurrenceSha256)
        || !isSha256(manifest.digests.semanticSha256)
        || !isSha256(manifest.digests.classificationSha256)) {
      reject('T21RC2_CLASSIFICATION_REJECTED');
    }

    const { captureEvidence, production, target: targetRows, recipes, summary } = manifest;
    if (captureEvidence.completeness !== 'COUNT_CONSISTENT_OFFLINE_INPUT'
        || !safeInteger(captureEvidence.recipeCount)
        || !safeInteger(captureEvidence.ingredientOccurrenceCount)
        || captureEvidence.recipeCount !== recipes.length
        || captureEvidence.ingredientOccurrenceCount !== production.length
        || summary.productionOccurrenceCount !== production.length
        || summary.targetOccurrenceCount !== targetRows.length
        || summary.recipeIdSetMatch !== true
        || !summary.accounting.productionAccounted
        || !summary.accounting.targetAccounted
        || summary.accounting.productionClassSum !== production.length
        || summary.accounting.targetClassSum !== targetRows.length
        || !safeInteger(summary.unattributedProductionOccurrences)
        || !safeInteger(summary.driftRecipeCount)) {
      reject('T21RC2_CLASSIFICATION_REJECTED');
    }

    const productionKeys = occurrenceKeys(production);
    const targetKeys = occurrenceKeys(targetRows);
    if (!productionKeys || !targetKeys) reject('T21RC2_CLASSIFICATION_REJECTED');

    const productionClassCounts = countBy(production, 'classification', PRODUCTION_CLASSES);
    const targetClassCounts = countBy(targetRows, 'classification', TARGET_CLASSES);
    const identityPopulations = countBy(production, 'identityPopulation', IDENTITY_POPULATIONS);
    const populations = emptyCounts(['deterministic', 'reviewRequired', 'unknown']);
    const driftBreakdown = emptyCounts(DRIFT_KINDS);
    const recipeIds = new Set();
    const perRecipe = new Map();

    for (const recipe of recipes) {
      if (recipeIds.has(recipe.recipeId)) reject('T21RC2_CLASSIFICATION_REJECTED');
      recipeIds.add(recipe.recipeId);
      perRecipe.set(recipe.recipeId, {
        production: [], target: [],
      });
    }

    let unattributedProductionOccurrences = 0;
    for (const row of production) {
      if (row.confidence === 'DETERMINISTIC') populations.deterministic += 1;
      else if (row.confidence === 'REVIEW_REQUIRED') populations.reviewRequired += 1;
      else populations.unknown += 1;
      if (row.driftKind !== null) driftBreakdown[row.driftKind] += 1;
      if (row.recipeId === null) {
        unattributedProductionOccurrences += 1;
      } else {
        const group = perRecipe.get(row.recipeId);
        if (!group) reject('T21RC2_CLASSIFICATION_REJECTED');
        group.production.push(row);
      }
      for (const key of row.candidateTargetOccurrenceKeys) {
        if (!targetKeys.has(key)) reject('T21RC2_CLASSIFICATION_REJECTED');
      }
    }
    for (const row of targetRows) {
      const group = perRecipe.get(row.recipeId);
      if (!group) reject('T21RC2_CLASSIFICATION_REJECTED');
      group.target.push(row);
      for (const key of row.candidateProductionOccurrenceKeys) {
        if (!productionKeys.has(key)) reject('T21RC2_CLASSIFICATION_REJECTED');
      }
    }

    if (!sameCounts(summary.productionClassCounts, productionClassCounts, PRODUCTION_CLASSES)
        || !sameCounts(summary.targetClassCounts, targetClassCounts, TARGET_CLASSES)
        || !sameCounts(summary.identityPopulations, identityPopulations, IDENTITY_POPULATIONS)
        || !sameCounts(summary.populations, populations, ['deterministic', 'reviewRequired', 'unknown'])
        || !sameCounts(summary.driftBreakdown, driftBreakdown, DRIFT_KINDS)
        || summary.unattributedProductionOccurrences !== unattributedProductionOccurrences
        || sum(Object.values(productionClassCounts)) !== production.length
        || sum(Object.values(targetClassCounts)) !== targetRows.length) {
      reject('T21RC2_CLASSIFICATION_REJECTED');
    }

    let driftRecipeCount = 0;
    for (const recipe of recipes) {
      const group = perRecipe.get(recipe.recipeId);
      const pCounts = countBy(group.production, 'classification', PRODUCTION_CLASSES);
      const tCounts = countBy(group.target, 'classification', TARGET_CLASSES);
      const reviewRequiredCount = group.production.filter((row) => row.confidence === 'REVIEW_REQUIRED').length;
      if (recipe.productionOccurrenceCount !== group.production.length
          || recipe.targetOccurrenceCount !== group.target.length
          || !sameCounts(recipe.productionClassCounts, pCounts, PRODUCTION_CLASSES)
          || !sameCounts(recipe.targetClassCounts, tCounts, TARGET_CLASSES)
          || recipe.exactMatchCount !== pCounts.EXACT_V1_MATCH
          || recipe.deterministicCounterpartCount !== pCounts.DETERMINISTIC_V1_COUNTERPART
          || recipe.reviewedBridgeCount !== pCounts.REVIEWED_ID_BRIDGE
          || recipe.sameIdDriftCount !== pCounts.SAME_ID_CONTENT_DRIFT
          || recipe.productionOnlyCount !== pCounts.PRODUCTION_ONLY_KNOWN_ID + pCounts.PRODUCTION_ONLY_NEW_ID
          || recipe.targetOnlyCount !== tCounts.TARGET_ONLY_MISSING
          || recipe.ambiguousProductionCount !== pCounts.AMBIGUOUS
          || recipe.ambiguousTargetCount !== tCounts.AMBIGUOUS
          || recipe.reviewRequiredCount !== reviewRequiredCount) {
        reject('T21RC2_CLASSIFICATION_REJECTED');
      }
      if (recipe.sameIdDriftCount > 0) driftRecipeCount += 1;
    }

    if (summary.driftRecipeCount !== driftRecipeCount
        || manifest.digests.classificationSha256 !== classificationDigest(manifest)) {
      reject('T21RC2_CLASSIFICATION_REJECTED');
    }

    return {
      recipeCount: captureEvidence.recipeCount,
      productionOccurrenceCount: production.length,
      targetOccurrenceCount: targetRows.length,
      productionClassCounts,
      targetClassCounts,
      identityPopulations,
      populations,
      driftBreakdown,
      driftRecipeCount,
      unattributedProductionOccurrences,
      summary,
    };
  } catch (error) {
    if (T21RC2_ERROR_CODES.includes(error?.code)) throw error;
    reject('T21RC2_CLASSIFICATION_REJECTED');
  }
}

export function validateT21RC2Manifest(manifest) {
  validateManifestAndAggregate(manifest);
  return true;
}

function validateCapture({ authorization, authorizationSha256, capture, manifest, aggregate }) {
  if (!isPlainObject(capture) || capture.schemaVersion !== 1) {
    reject('T21RC2_CAPTURE_INCOMPLETE');
  }
  if (capture.status !== 'OBSERVED_STABLE_NON_ATOMIC') {
    reject('T21RC2_PRODUCTION_SNAPSHOT_UNSTABLE');
  }

  const database = capture.database;
  if (!isPlainObject(database)
      || database.name !== PRODUCTION_D1.name
      || database.id !== PRODUCTION_D1.id
      || database.accountVerified !== true) {
    reject('T21RC2_IDENTITY_REJECTED');
  }

  const ledger = capture.ledger;
  if (!isPlainObject(ledger)
      || ledger.count !== LEDGER_COUNT
      || ledger.tip !== LEDGER_TIP
      || !isSha256(ledger.namesSha256)) {
    reject('T21RC2_LEDGER_CHANGED');
  }

  const counts = capture.counts;
  if (!isPlainObject(counts)
      || counts.recipeCount !== PINNED_TARGET.recipeCount
      || !safeInteger(counts.ingredientOccurrenceCount)) {
    reject('T21RC2_RECIPE_ROSTER_CHANGED');
  }
  if (aggregate.recipeCount !== counts.recipeCount
      || aggregate.productionOccurrenceCount !== counts.ingredientOccurrenceCount
      || aggregate.recipeCount !== PINNED_TARGET.recipeCount
      || aggregate.targetOccurrenceCount !== PINNED_TARGET.targetOccurrenceCount) {
    reject('T21RC2_CLASSIFICATION_REJECTED');
  }

  assertAuthorityProof(capture.authorityProof, true);
  if (!canonicalEqual(capture.authorityProof, manifest.authorityProof)) {
    reject('T21RC2_CLASSIFICATION_REJECTED');
  }

  if (!isPlainObject(capture.digests)
      || !isSha256(capture.digests.occurrenceSha256)
      || !isSha256(capture.digests.semanticSha256)
      || capture.digests.occurrenceSha256 !== manifest.digests.occurrenceSha256
      || capture.digests.semanticSha256 !== manifest.digests.semanticSha256) {
    reject('T21RC2_CLASSIFICATION_REJECTED');
  }

  if (!isSha256(capture.snapshotDigestSha256)) {
    reject('T21RC2_CLASSIFICATION_REJECTED');
  }

  if (!isSha256(capture.authorizationSha256)
      || capture.authorizationSha256 !== authorizationSha256
      || authorization.actor !== authorization.approval.actor) {
    reject('T21RC2_APPROVAL_REJECTED');
  }
}

function receiptAuthorityProof(proof) {
  return {
    canonicalTargetSha256: proof.canonicalTargetSha256,
    releaseManifestSha256: proof.releaseManifestSha256,
    approvedBatchesSha256: proof.approvedBatchesSha256,
    canonicalRegistrySourceSha256: proof.canonicalRegistrySourceSha256,
    reconciliationSha256: proof.reconciliationSha256,
    releaseId: proof.releaseId,
    runtimeFingerprint: proof.runtimeFingerprint,
    reviewedBridgeCount: proof.reviewedBridgeCount,
  };
}

function buildReceipt({ authorization, capture, manifest }) {
  const authorizationSha256 = authorizationDigest(authorization);
  const aggregate = validateManifestAndAggregate(manifest);
  validateCapture({ authorization, authorizationSha256, capture, manifest, aggregate });

  const productionClassCounts = { ...aggregate.productionClassCounts };
  const targetClassCounts = { ...aggregate.targetClassCounts };

  return {
    schemaVersion: 1,
    status: 'OBSERVED_STABLE_NON_ATOMIC',
    certification: 'NOT_A_RELEASE_CERTIFICATION',
    repositoryId: REPOSITORY_ID,
    repository: REPOSITORY,
    mainSha: authorization.mainSha,
    reviewedSha: authorization.reviewedSha,
    run: {
      id: authorization.runId,
      attempt: authorization.runAttempt,
      actor: authorization.actor,
      triggeringActor: authorization.triggeringActor,
      ci: {
        id: authorization.ci.id,
        attempt: authorization.ci.attempt,
        headSha: authorization.ci.headSha,
      },
    },
    database: {
      name: PRODUCTION_D1.name,
      id: PRODUCTION_D1.id,
      accountVerified: true,
    },
    approval: {
      environment: 'production',
      state: 'approved',
      reviewer: REVIEWER,
      actor: authorization.actor,
      historySha256: authorization.approval.historySha256,
      policySha256: authorization.approval.policySha256,
    },
    authorizationSha256,
    ledger: {
      count: LEDGER_COUNT,
      tip: LEDGER_TIP,
      namesSha256: capture.ledger.namesSha256,
    },
    counts: {
      recipeCount: aggregate.recipeCount,
      productionOccurrenceCount: aggregate.productionOccurrenceCount,
      targetOccurrenceCount: aggregate.targetOccurrenceCount,
    },
    productionClassCounts,
    targetClassCounts,
    driftBreakdown: { ...aggregate.driftBreakdown },
    driftRecipeCount: aggregate.driftRecipeCount,
    populations: { ...aggregate.populations },
    identityPopulations: { ...aggregate.identityPopulations },
    ambiguity: {
      production: productionClassCounts.AMBIGUOUS,
      target: targetClassCounts.AMBIGUOUS,
      idConflictReviewRequired: productionClassCounts.ID_CONFLICT_REVIEW_REQUIRED,
    },
    accounting: {
      status: 'PASS',
      productionClassSum: aggregate.productionOccurrenceCount,
      targetClassSum: aggregate.targetOccurrenceCount,
      productionAccounted: true,
      targetAccounted: true,
      recipeIdSetMatch: true,
      unattributedProductionOccurrences: aggregate.unattributedProductionOccurrences,
    },
    sourceDigestProof: receiptAuthorityProof(manifest.authorityProof),
    digests: {
      occurrenceSha256: manifest.digests.occurrenceSha256,
      semanticSha256: manifest.digests.semanticSha256,
      classificationSha256: manifest.digests.classificationSha256,
    },
    productionMutations: 0,
    sqlWrites: 0,
    restores: 0,
    migrations: 0,
    applied0039: false,
    deploys: 0,
    runtimePositionAuthority: false,
    repairAuthorized: false,
    t21gStatus: 'T21G_NOT_READY',
    rowLevelEvidenceDelivery: 'UNCONFIGURED',
  };
}

export function buildT21RC2ProductionReceipt(input) {
  try {
    if (!isPlainObject(input)
        || !Object.hasOwn(input, 'authorization')
        || !Object.hasOwn(input, 'capture')
        || !Object.hasOwn(input, 'manifest')) {
      reject('T21RC2_RECEIPT_REJECTED');
    }
    return buildReceipt(input);
  } catch (error) {
    if (T21RC2_ERROR_CODES.includes(error?.code)) throw error;
    reject('T21RC2_RECEIPT_REJECTED');
  }
}

async function publishCli(args) {
  try {
    if (args.length !== 1 || args[0] !== 'publish') reject('T21RC2_RECEIPT_REJECTED');
    const authorization = readPrivateJson('authorization-final.json');
    const capture = readPrivateJson('capture-proof.json');
    const manifest = readPrivateJson('row-manifest.json');
    const { requireStoredAuthorizationBinding } = await import('./t21rc2-production-approval.mjs');
    requireStoredAuthorizationBinding(authorization);
    writePublicReceipt(buildT21RC2ProductionReceipt({ authorization, capture, manifest }));
  } catch (error) {
    recordT21RC2Failure(error);
    console.error(safeT21RC2Error(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await publishCli(process.argv.slice(2));
}
