import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { PRODUCTION_D1 } from '../../scripts/d1-migration-check.mjs';
import {
  authorizationDigest,
  buildT21RC2ProductionReceipt,
  validateT21RC2Manifest,
} from '../../scripts/t21rc2-production-receipt.mjs';
import { captureDigest } from '../../scripts/t21rc2-production-capture.mjs';
import { buildT21RC2FailureReceipt } from '../../scripts/t21rc2-production-files.mjs';
import { reconcileIngredientOccurrences } from '../../scripts/t21rc-row-reconciliation.mjs';

const PRIVATE_PHYSICAL_ID = 'PRIVATE_PHYSICAL_ID_123';
const PRIVATE_NAME = 'SECRET_PRODUCTION_NAME_ABC';
const PRIVATE_QUANTITY = 987654.125;
const TARGET_SPEC_BYTES = readFileSync(new URL(
  '../../docs/ai/recipe-catalog/T21RA_RUNTIME_CANONICAL_TARGET.json',
  import.meta.url,
));
const TARGET_SPEC = JSON.parse(TARGET_SPEC_BYTES.toString('utf8'));
const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RECEIPT_SCRIPT = fileURLToPath(new URL(
  '../../scripts/t21rc2-production-receipt.mjs',
  import.meta.url,
));

function authorityProof() {
  return {
    canonicalTargetSha256: createHash('sha256').update(TARGET_SPEC_BYTES).digest('hex'),
    releaseManifestSha256: TARGET_SPEC.target.releaseManifestFileSha256,
    approvedBatchesSha256: TARGET_SPEC.target.approvedBatchesFileSha256,
    canonicalRegistrySourceSha256: 'c'.repeat(64),
    reconciliationSha256: 'd'.repeat(64),
    releaseId: TARGET_SPEC.target.releaseId,
    runtimeFingerprint: TARGET_SPEC.target.expectedRuntimeFingerprint,
    reviewedBridgeCount: 0,
  };
}

function authorization() {
  const mainSha = 'a'.repeat(40);
  return {
    schemaVersion: 1,
    repositoryId: 1385308553,
    repository: 'vn-tako4/Tako-san',
    mainSha,
    reviewedSha: 'b'.repeat(40),
    runId: '1234567890',
    runAttempt: '1',
    actor: 'vn-tako4',
    triggeringActor: 'vn-tako4',
    ci: { id: 123456, attempt: 1, headSha: mainSha },
    approval: {
      environment: 'production',
      state: 'approved',
      reviewer: 'vn-taphoanhatung',
      actor: 'vn-tako4',
      historySha256: 'e'.repeat(64),
      policySha256: 'f'.repeat(64),
    },
  };
}

function tinyManifest() {
  const manifest = reconcileIngredientOccurrences({
    targetRecipes: [{
      id: 'fixture-recipe',
      ingredients: [{ ingredientId: 'ING_ALPHA', name: 'Alpha', requiredQuantity: 2, unit: 'g' }],
    }],
    productionRows: [{
      id: 'fixture-row',
      recipe_id: 'fixture-recipe',
      ingredient_id: 'ING_ALPHA',
      name: 'Alpha',
      required_quantity: 2,
      unit: 'g',
      is_optional: 0,
    }],
    productionRecipeIds: ['fixture-recipe'],
    canonicalIngredientIds: ['ING_ALPHA'],
    reconciliation: [],
    captureCounts: { recipeCount: 1, ingredientOccurrenceCount: 1 },
  });
  manifest.authorityProof = authorityProof();
  return manifest;
}

function productionManifest() {
  const recipeIds = [PRIVATE_NAME, ...Array.from({ length: 499 }, (_, index) => `recipe-${index + 1}`)];
  const targetRecipes = recipeIds.map((id, recipeIndex) => ({
    id,
    ingredients: Array.from({ length: recipeIndex < 202 ? 6 : 5 }, (_, ingredientIndex) => {
      if (recipeIndex === 0 && ingredientIndex === 0) {
        return {
          ingredientId: PRIVATE_PHYSICAL_ID,
          name: PRIVATE_NAME,
          requiredQuantity: PRIVATE_QUANTITY,
          unit: 'ml',
        };
      }
      return {
        ingredientId: `ING_${String(recipeIndex).padStart(3, '0')}_${ingredientIndex}`,
        name: `Fixture ingredient ${recipeIndex}-${ingredientIndex}`,
        requiredQuantity: 1,
        unit: 'g',
      };
    }),
  }));
  const productionRows = [{
    id: PRIVATE_PHYSICAL_ID,
    recipe_id: recipeIds[0],
    ingredient_id: PRIVATE_PHYSICAL_ID,
    name: PRIVATE_NAME,
    required_quantity: PRIVATE_QUANTITY,
    unit: 'ml',
    is_optional: 0,
  }];
  const canonicalIngredientIds = [...new Set(targetRecipes.flatMap((recipe) =>
    recipe.ingredients.map((ingredient) => ingredient.ingredientId)))];
  const manifest = reconcileIngredientOccurrences({
    targetRecipes,
    productionRows,
    productionRecipeIds: recipeIds,
    canonicalIngredientIds,
    reconciliation: [],
    captureCounts: { recipeCount: 500, ingredientOccurrenceCount: 1 },
  });
  manifest.authorityProof = authorityProof();
  return manifest;
}

function captureProof(auth, manifest) {
  return {
    schemaVersion: 1,
    status: 'OBSERVED_STABLE_NON_ATOMIC',
    database: { name: PRODUCTION_D1.name, id: PRODUCTION_D1.id, accountVerified: true },
    ledger: {
      count: 38,
      tip: '0038_auth_onboarding_completion.sql',
      namesSha256: '1'.repeat(64),
    },
    counts: { recipeCount: 500, ingredientOccurrenceCount: 1 },
    authorityProof: { ...manifest.authorityProof },
    digests: {
      occurrenceSha256: manifest.digests.occurrenceSha256,
      semanticSha256: manifest.digests.semanticSha256,
    },
    snapshotDigestSha256: '2'.repeat(64),
    authorizationSha256: captureDigest(auth),
    privateRows: [PRIVATE_PHYSICAL_ID, PRIVATE_NAME, PRIVATE_QUANTITY],
  };
}

function receiptInput(fixture) {
  return {
    authorization: structuredClone(fixture.authorization),
    capture: structuredClone(fixture.capture),
    manifest: structuredClone(fixture.manifest),
  };
}

function expectSafeRejection(operation, code) {
  let error;
  try {
    operation();
  } catch (caught) {
    error = caught;
  }
  expect(error?.code).toBe(code);
  expect(error?.message).toBe(code);
  expect(error?.message).not.toContain(PRIVATE_PHYSICAL_ID);
  expect(error?.message).not.toContain(PRIVATE_NAME);
  expect(error?.message).not.toContain(String(PRIVATE_QUANTITY));
}

function approvalEnvironment(auth, runnerTemp) {
  return {
    RUNNER_TEMP: runnerTemp,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: auth.mainSha,
    GITHUB_RUN_ATTEMPT: auth.runAttempt,
    GITHUB_REPOSITORY_ID: String(auth.repositoryId),
    GITHUB_REPOSITORY: auth.repository,
    GITHUB_RUN_ID: auth.runId,
    GITHUB_ACTOR: auth.actor,
    GITHUB_TRIGGERING_ACTOR: auth.triggeringActor,
    RELEASE_REF: auth.mainSha,
    REVIEWED_SHA: auth.reviewedSha,
    CONFIRM_T21RC_READ_ONLY_CAPTURE: 'true',
  };
}

let validFixture;

beforeAll(() => {
  const auth = authorization();
  const manifest = productionManifest();
  validFixture = { authorization: auth, capture: captureProof(auth, manifest), manifest };
});

describe('T21R-C2 aggregate production receipt', () => {
  it('validates the closed manifest schema, aggregate partitions, and capture metadata', () => {
    expect(validateT21RC2Manifest(tinyManifest())).toBe(true);

    const forgedClasses = tinyManifest();
    forgedClasses.summary.productionClassCounts.EXACT_V1_MATCH += 1;
    expectSafeRejection(() => validateT21RC2Manifest(forgedClasses), 'T21RC2_CLASSIFICATION_REJECTED');

    const forgedCapture = tinyManifest();
    forgedCapture.captureEvidence.ingredientOccurrenceCount += 1;
    expectSafeRejection(() => validateT21RC2Manifest(forgedCapture), 'T21RC2_CLASSIFICATION_REJECTED');

    const missingAuthority = tinyManifest();
    missingAuthority.authorityProof = null;
    expectSafeRejection(() => validateT21RC2Manifest(missingAuthority), 'T21RC2_CLASSIFICATION_REJECTED');

    const extraField = tinyManifest();
    extraField.privateMarker = PRIVATE_NAME;
    expectSafeRejection(() => validateT21RC2Manifest(extraField), 'T21RC2_CLASSIFICATION_REJECTED');
  });

  it('builds a pinned success receipt from the fixed V1/D1 proof and keeps only aggregate allowlisted fields', () => {
    const input = receiptInput(validFixture);
    input.capture.untrustedRawData = {
      id: PRIVATE_PHYSICAL_ID,
      name: PRIVATE_NAME,
      quantity: PRIVATE_QUANTITY,
      unit: 'ml',
      candidateGraph: [{ occurrence: PRIVATE_PHYSICAL_ID }],
    };
    const receipt = buildT21RC2ProductionReceipt(input);
    const serialized = JSON.stringify(receipt);

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      status: 'OBSERVED_STABLE_NON_ATOMIC',
      certification: 'NOT_A_RELEASE_CERTIFICATION',
      repositoryId: 1385308553,
      repository: 'vn-tako4/Tako-san',
      counts: { recipeCount: 500, productionOccurrenceCount: 1, targetOccurrenceCount: 2702 },
      database: { name: 'frigo-db', accountVerified: true },
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
    });
    expect(receipt.database.id).toBe(PRODUCTION_D1.id);
    expect(receipt.productionClassCounts.EXACT_V1_MATCH).toBe(1);
    expect(receipt.targetClassCounts.SATISFIED_EXACT).toBe(1);
    expect(receipt.sourceDigestProof.releaseId).toBe(TARGET_SPEC.target.releaseId);
    expect(receipt.sourceDigestProof.runtimeFingerprint).toBe(TARGET_SPEC.target.expectedRuntimeFingerprint);
    expect(receipt).not.toHaveProperty('production');
    expect(receipt).not.toHaveProperty('target');
    expect(receipt).not.toHaveProperty('recipes');
    expect(receipt).not.toHaveProperty('rows');
    expect(receipt).not.toHaveProperty('candidateGraphs');
    expect(serialized).not.toContain(PRIVATE_PHYSICAL_ID);
    expect(serialized).not.toContain(PRIVATE_NAME);
    expect(serialized).not.toContain(String(PRIVATE_QUANTITY));
  });

  it('distinguishes SELECT-only execution from unproven token permissions without accepting input claims', () => {
    const input = receiptInput(validFixture);
    input.capture.queryPathSelectOnly = false;
    input.capture.tokenScopeReadOnlyProven = true;
    const receipt = buildT21RC2ProductionReceipt(input);
    expect(receipt.queryPathSelectOnly).toBe(true);
    expect(receipt.tokenScopeReadOnlyProven).toBe(false);
    const failure = buildT21RC2FailureReceipt(new Error(PRIVATE_NAME));
    expect(failure).not.toHaveProperty('queryPathSelectOnly');
    expect(failure).not.toHaveProperty('tokenScopeReadOnlyProven');
    expect(JSON.stringify({ receipt, failure })).not.toContain(PRIVATE_NAME);
  });

  it('rejects forged authorization, identity, stability, ledger, digest, and source proof inputs', () => {
    const wrongReviewer = receiptInput(validFixture);
    wrongReviewer.authorization.approval.reviewer = 'unreviewed-user';
    expectSafeRejection(
      () => buildT21RC2ProductionReceipt(wrongReviewer),
      'T21RC2_APPROVAL_REJECTED',
    );

    const selfApproved = receiptInput(validFixture);
    selfApproved.authorization.approval.reviewer = selfApproved.authorization.actor;
    selfApproved.authorization.approval.actor = selfApproved.authorization.actor;
    expectSafeRejection(() => buildT21RC2ProductionReceipt(selfApproved), 'T21RC2_APPROVAL_REJECTED');

    const triggeringActorApproved = receiptInput(validFixture);
    triggeringActorApproved.authorization.triggeringActor = 'vn-taphoanhatung';
    expectSafeRejection(
      () => buildT21RC2ProductionReceipt(triggeringActorApproved),
      'T21RC2_APPROVAL_REJECTED',
    );

    const wrongDatabase = receiptInput(validFixture);
    wrongDatabase.capture.database.id = 'wrong-production-database';
    expectSafeRejection(() => buildT21RC2ProductionReceipt(wrongDatabase), 'T21RC2_IDENTITY_REJECTED');

    const wrongAccount = receiptInput(validFixture);
    wrongAccount.capture.database.accountVerified = false;
    expectSafeRejection(() => buildT21RC2ProductionReceipt(wrongAccount), 'T21RC2_IDENTITY_REJECTED');

    const unstable = receiptInput(validFixture);
    unstable.capture.status = 'OBSERVED_ATOMIC';
    expectSafeRejection(
      () => buildT21RC2ProductionReceipt(unstable),
      'T21RC2_PRODUCTION_SNAPSHOT_UNSTABLE',
    );

    const changedLedger = receiptInput(validFixture);
    changedLedger.capture.ledger.count = 39;
    expectSafeRejection(() => buildT21RC2ProductionReceipt(changedLedger), 'T21RC2_LEDGER_CHANGED');

    const paddedLedgerDigest = receiptInput(validFixture);
    paddedLedgerDigest.capture.ledger.namesSha256 += '\n';
    expectSafeRejection(
      () => buildT21RC2ProductionReceipt(paddedLedgerDigest),
      'T21RC2_LEDGER_CHANGED',
    );

    const paddedManifestDigest = receiptInput(validFixture);
    paddedManifestDigest.manifest.digests.semanticSha256 += '\n';
    expectSafeRejection(
      () => buildT21RC2ProductionReceipt(paddedManifestDigest),
      'T21RC2_CLASSIFICATION_REJECTED',
    );

    const forgedOccurrenceDigest = receiptInput(validFixture);
    forgedOccurrenceDigest.capture.digests.occurrenceSha256 = '9'.repeat(64);
    expectSafeRejection(
      () => buildT21RC2ProductionReceipt(forgedOccurrenceDigest),
      'T21RC2_CLASSIFICATION_REJECTED',
    );

    const malformedSnapshotDigest = receiptInput(validFixture);
    malformedSnapshotDigest.capture.snapshotDigestSha256 = 'not-a-sha256';
    expectSafeRejection(
      () => buildT21RC2ProductionReceipt(malformedSnapshotDigest),
      'T21RC2_CLASSIFICATION_REJECTED',
    );

    const forgedAuthorizationBinding = receiptInput(validFixture);
    forgedAuthorizationBinding.capture.authorizationSha256 = '8'.repeat(64);
    expectSafeRejection(
      () => buildT21RC2ProductionReceipt(forgedAuthorizationBinding),
      'T21RC2_APPROVAL_REJECTED',
    );

    const changedProof = receiptInput(validFixture);
    changedProof.capture.authorityProof.reviewedBridgeCount += 1;
    expectSafeRejection(
      () => buildT21RC2ProductionReceipt(changedProof),
      'T21RC2_CLASSIFICATION_REJECTED',
    );

    const unpinnedTarget = receiptInput(validFixture);
    unpinnedTarget.manifest.authorityProof.runtimeFingerprint = '0'.repeat(64);
    unpinnedTarget.capture.authorityProof.runtimeFingerprint = '0'.repeat(64);
    expectSafeRejection(
      () => buildT21RC2ProductionReceipt(unpinnedTarget),
      'T21RC2_CLASSIFICATION_REJECTED',
    );

    const wrongRepository = receiptInput(validFixture);
    wrongRepository.authorization.repositoryId += 1;
    expectSafeRejection(
      () => buildT21RC2ProductionReceipt(wrongRepository),
      'T21RC2_IDENTITY_REJECTED',
    );
  });

  it('rejects forged aggregate counts, count partitions, and pinned target sizes', () => {
    const forgedClasses = receiptInput(validFixture);
    forgedClasses.manifest.summary.productionClassCounts.EXACT_V1_MATCH += 1;
    expectSafeRejection(
      () => buildT21RC2ProductionReceipt(forgedClasses),
      'T21RC2_CLASSIFICATION_REJECTED',
    );

    const forgedPartition = receiptInput(validFixture);
    forgedPartition.manifest.summary.accounting.productionAccounted = false;
    expectSafeRejection(
      () => buildT21RC2ProductionReceipt(forgedPartition),
      'T21RC2_CLASSIFICATION_REJECTED',
    );

    const wrongTargetCount = receiptInput(validFixture);
    wrongTargetCount.manifest.target.pop();
    expectSafeRejection(
      () => buildT21RC2ProductionReceipt(wrongTargetCount),
      'T21RC2_CLASSIFICATION_REJECTED',
    );

    const wrongCaptureCount = receiptInput(validFixture);
    wrongCaptureCount.capture.counts.ingredientOccurrenceCount = 2;
    expectSafeRejection(
      () => buildT21RC2ProductionReceipt(wrongCaptureCount),
      'T21RC2_CLASSIFICATION_REJECTED',
    );

    const unknownAuthorizationField = receiptInput(validFixture);
    unknownAuthorizationField.authorization.privateMarker = PRIVATE_NAME;
    expectSafeRejection(
      () => buildT21RC2ProductionReceipt(unknownAuthorizationField),
      'T21RC2_IDENTITY_REJECTED',
    );
  });

  it('records only safe failure codes for rejected CLI input and never echoes arbitrary paths or raw text', () => {
    const runnerTemp = mkdtempSync(path.join(os.tmpdir(), 't21rc2-receipt-cli-'));
    try {
      const result = spawnSync(process.execPath, [RECEIPT_SCRIPT, 'publish', PRIVATE_NAME], {
        cwd: REPOSITORY_ROOT,
        env: { RUNNER_TEMP: runnerTemp },
        encoding: 'utf8',
      });
      const receiptPath = path.join(runnerTemp, 't21rc2-public-receipt.json');
      const failure = JSON.parse(readFileSync(receiptPath, 'utf8'));
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim()).toBe('T21RC2_RECEIPT_REJECTED');
      expect(failure).toMatchObject({
        status: 'T21RC2_CAPTURE_BLOCKED',
        reason: 'T21RC2_RECEIPT_REJECTED',
        certification: 'NOT_A_RELEASE_CERTIFICATION',
      });
      expect(JSON.stringify(failure)).not.toContain(PRIVATE_NAME);
      expect(result.stderr).not.toContain(PRIVATE_NAME);
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  it('publishes through the stored approval binding using only the fixed private inputs', () => {
    const input = receiptInput(validFixture);
    expect(authorizationDigest(input.authorization)).toBe(captureDigest(input.authorization));
    const runnerTemp = mkdtempSync(path.join(os.tmpdir(), 't21rc2-receipt-publish-'));
    const privateDirectory = path.join(runnerTemp, 't21rc2');
    mkdirSync(privateDirectory, { mode: 0o700 });
    chmodSync(privateDirectory, 0o700);
    for (const [name, value] of [
      ['authorization-final.json', input.authorization],
      ['capture-proof.json', input.capture],
      ['row-manifest.json', input.manifest],
    ]) {
      writeFileSync(path.join(privateDirectory, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
    }
    try {
      const result = spawnSync(process.execPath, [RECEIPT_SCRIPT, 'publish'], {
        cwd: REPOSITORY_ROOT,
        env: approvalEnvironment(input.authorization, runnerTemp),
        encoding: 'utf8',
      });
      const receipt = JSON.parse(readFileSync(path.join(runnerTemp, 't21rc2-public-receipt.json'), 'utf8'));
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(receipt).toMatchObject({
        status: 'OBSERVED_STABLE_NON_ATOMIC',
        counts: { recipeCount: 500, productionOccurrenceCount: 1, targetOccurrenceCount: 2702 },
        approval: { environment: 'production', state: 'approved', reviewer: 'vn-taphoanhatung' },
      });
      expect(JSON.stringify(receipt)).not.toContain(PRIVATE_PHYSICAL_ID);
      expect(JSON.stringify(receipt)).not.toContain(PRIVATE_NAME);
      expect(JSON.stringify(receipt)).not.toContain(String(PRIVATE_QUANTITY));
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  it('redacts malformed fixed private-file errors in CLI output and the failure receipt', () => {
    const runnerTemp = mkdtempSync(path.join(os.tmpdir(), 't21rc2-receipt-private-'));
    const privateDirectory = path.join(runnerTemp, 't21rc2');
    mkdirSync(privateDirectory, { mode: 0o700 });
    chmodSync(privateDirectory, 0o700);
    writeFileSync(
      path.join(privateDirectory, 'authorization-final.json'),
      `{"raw":"${PRIVATE_PHYSICAL_ID} ${PRIVATE_NAME} ${PRIVATE_QUANTITY}"`,
      { mode: 0o600 },
    );
    try {
      const result = spawnSync(process.execPath, [RECEIPT_SCRIPT, 'publish'], {
        cwd: REPOSITORY_ROOT,
        env: { RUNNER_TEMP: runnerTemp },
        encoding: 'utf8',
      });
      const failure = JSON.parse(readFileSync(path.join(runnerTemp, 't21rc2-public-receipt.json'), 'utf8'));
      const publicText = JSON.stringify(failure);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim()).toBe('T21RC2_PRIVATE_PATH_REJECTED');
      expect(publicText).not.toContain(PRIVATE_PHYSICAL_ID);
      expect(publicText).not.toContain(PRIVATE_NAME);
      expect(publicText).not.toContain(String(PRIVATE_QUANTITY));
      expect(result.stderr).not.toContain(PRIVATE_PHYSICAL_ID);
      expect(result.stderr).not.toContain(PRIVATE_NAME);
      expect(result.stderr).not.toContain(String(PRIVATE_QUANTITY));
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });
});
