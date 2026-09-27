import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readRecipeContent } from '../../packages/db/src/recipe-content';
import { assessD1Readiness, currentCatalogRelease, StaticRecipeAuthority } from '../../packages/recipes/src/recipe-authority';
import { hydrateRuntimeRecipes } from '../../packages/recipes/src/runtime-hydration';
import { APPROVED_BATCHES_REGISTRY } from '../../scripts/d1-migration-check.mjs';
import { migrationManifest } from '../../scripts/release-check.mjs';
import {
  STAGING_D1,
  STATUS,
  StagingRuntimeReadinessError,
  catalogReadQuery,
  certify,
  provenanceQuery,
  splitSqlStatements,
} from '../../scripts/staging-d1-runtime-readiness-check.mjs';
import { SqliteD1 } from '../helpers/sqlite-d1';

const dirs = [];
const temporary = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'staging-runtime-int-'));
  dirs.push(dir);
  return dir;
};
const write = (dir, name, data) => {
  const file = path.join(dir, name);
  writeFileSync(file, typeof data === 'string' ? data : `${JSON.stringify(data)}\n`);
  return file;
};
const result = (rows) => [{ success: true, results: rows }];

function dropRecipe(snapshot, id) {
  return {
    recipes: snapshot.recipes.filter((row) => row.id !== id),
    requirements: snapshot.requirements.filter((line) => line.recipeId !== id),
    steps: snapshot.steps.filter((step) => step.recipeId !== id),
    nutritionRecipeIds: snapshot.nutritionRecipeIds.filter((recipeId) => recipeId !== id),
    runtimeFields: snapshot.runtimeFields.filter((row) => row.recipeId !== id),
  };
}

function renameRecipe(snapshot, from, to) {
  const swap = (id) => (id === from ? to : id);
  return {
    recipes: snapshot.recipes.map((row) => (row.id === from ? { ...row, id: to } : row)),
    requirements: snapshot.requirements.map((line) => ({ ...line, recipeId: swap(line.recipeId) })),
    steps: snapshot.steps.map((step) => ({ ...step, recipeId: swap(step.recipeId) })),
    nutritionRecipeIds: snapshot.nutritionRecipeIds.map(swap),
    runtimeFields: snapshot.runtimeFields.map((row) => ({ ...row, recipeId: swap(row.recipeId) })),
  };
}

function swapRuntimeOrder(snapshot, left, right) {
  const leftRow = snapshot.runtimeFields.find((row) => row.recipeId === left);
  const rightRow = snapshot.runtimeFields.find((row) => row.recipeId === right);
  if (!leftRow || !rightRow) throw new Error('missing runtime fields');
  return {
    ...snapshot,
    runtimeFields: snapshot.runtimeFields.map((row) => {
      if (row.recipeId === left) return { ...row, runtimeOrder: rightRow.runtimeOrder };
      if (row.recipeId === right) return { ...row, runtimeOrder: leftRow.runtimeOrder };
      return row;
    }),
  };
}

function retitle(snapshot, id) {
  return {
    ...snapshot,
    recipes: snapshot.recipes.map((row) => (row.id === id ? { ...row, title: `${row.title} (edited)` } : row)),
  };
}

function stripSteps(snapshot, id) {
  return { ...snapshot, steps: snapshot.steps.filter((step) => step.recipeId !== id) };
}

describe('staging D1 runtime readiness catalog contract', () => {
  let db;
  let snapshot;
  let provenance;
  let catalog;
  let schema;
  let ledger;
  let pipeline;

  beforeAll(async () => {
    db = new SqliteD1();
    snapshot = await readRecipeContent(db);
    provenance = result(db.query(provenanceQuery()));
    catalog = splitSqlStatements(catalogReadQuery()).map((sql) => ({ success: true, results: db.query(sql) }));
    schema = migrationManifest(process.cwd(), execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
    ledger = result(schema.migrations.map((migration) => ({ name: migration.name })));
    pipeline = {
      hydrateRuntimeRecipes,
      assessD1Readiness,
      StaticRecipeAuthority,
      currentCatalogRelease,
      close: async () => {},
    };
  });

  afterAll(() => {
    db.close();
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function receiptFile() {
    return write(temporary(), 'receipt.json', {
      cloudflare: { accountAuthenticated: true },
      schema,
      database: STAGING_D1,
      repository: { id: 1385308553, sha: schema.sha256 },
    });
  }

  async function runCertify(overrides = {}) {
    return certify(receiptFile(), {
      ledger,
      provenance,
      foreignKeys: result([]),
      quickCheck: result([{ quick_check: 'ok' }]),
      catalog,
      snapshot,
      registry: JSON.parse(readFileSync(APPROVED_BATCHES_REGISTRY, 'utf8')),
      ...overrides,
    }, { pipeline });
  }

  it('A. exact valid 500 catalog is CERTIFIED by assessD1Readiness', async () => {
    const receipt = await runCertify();
    const release = currentCatalogRelease();
    expect(receipt.status).toBe(STATUS.CERTIFIED);
    expect(receipt.catalog).toMatchObject({
      recipeCount: 500,
      idSetMatch: true,
      orderMatch: true,
      hydrationFailures: 0,
      legacyBaselineMatch: true,
      runtimeFingerprintMatch: true,
    });
    expect(receipt.release).toMatchObject({
      releaseId: release.releaseId,
      expectedRecipeCount: 500,
      expectedRuntimeFingerprint: release.expectedRuntimeFingerprint,
    });
    expect(receipt.provenance.approvedBatchesMatch).toBe(true);
    expect(receipt.health).toEqual({ foreignKeyCheck: 'PASS', quickCheck: 'PASS' });
    expect(receipt.readiness).toEqual({ status: 'ready', code: null });
    expect(JSON.stringify(receipt)).not.toMatch(/household|CLOUDFLARE|instruction/);
  });

  it('B. count 499 → COUNT_DRIFT', async () => {
    const imported = currentCatalogRelease().orderedRecipeIds.at(-1);
    await expect(runCertify({ snapshot: dropRecipe(snapshot, imported), catalog: undefined }))
      .rejects.toMatchObject({ status: STATUS.COUNT_DRIFT });
  });

  it('C. correct count but missing+extra ID → ID_DRIFT', async () => {
    const imported = currentCatalogRelease().orderedRecipeIds.at(-1);
    await expect(runCertify({
      snapshot: renameRecipe(snapshot, imported, 'imp-not-in-release'),
      catalog: undefined,
    })).rejects.toMatchObject({ status: STATUS.ID_DRIFT });
  });

  it('D. exact IDs reordered → ORDER_DRIFT', async () => {
    const ids = currentCatalogRelease().orderedRecipeIds;
    await expect(runCertify({
      snapshot: swapRuntimeOrder(snapshot, ids.at(-1), ids.at(-2)),
      catalog: undefined,
    })).rejects.toMatchObject({ status: STATUS.ORDER_DRIFT });
  });

  it('E. legacy recipe field changed → LEGACY_BASELINE_DRIFT', async () => {
    await expect(runCertify({ snapshot: retitle(snapshot, 'vn-canh-01'), catalog: undefined }))
      .rejects.toMatchObject({ status: STATUS.LEGACY_BASELINE_DRIFT });
  });

  it('F. imported recipe runtime field changed → FINGERPRINT_DRIFT', async () => {
    const imported = currentCatalogRelease().orderedRecipeIds.at(-1);
    await expect(runCertify({ snapshot: retitle(snapshot, imported), catalog: undefined }))
      .rejects.toMatchObject({ status: STATUS.FINGERPRINT_DRIFT });
  });

  it('G. hydration failure → CATALOG_DIAGNOSTICS', async () => {
    const imported = currentCatalogRelease().orderedRecipeIds.at(-1);
    await expect(runCertify({ snapshot: stripSteps(snapshot, imported), catalog: undefined }))
      .rejects.toMatchObject({ status: STATUS.CATALOG_DIAGNOSTICS });
  });

  it('H. approved batch hash mismatch → PROVENANCE_DRIFT', async () => {
    const release = currentCatalogRelease();
    const drifted = {
      ...release,
      approvedImportBatches: release.approvedImportBatches.map((batch, index) => (
        index === 0 ? { ...batch, batchHash: 'f'.repeat(64) } : batch
      )),
    };
    await expect(runCertify({ release: drifted })).rejects.toMatchObject({ status: STATUS.PROVENANCE_DRIFT });
  });

  it('writes the blocked status onto the receipt', async () => {
    const file = receiptFile();
    try {
      await certify(file, {
        ledger,
        provenance,
        foreignKeys: result([]),
        quickCheck: result([{ quick_check: 'ok' }]),
        snapshot: dropRecipe(snapshot, currentCatalogRelease().orderedRecipeIds.at(-1)),
      }, { pipeline });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(StagingRuntimeReadinessError);
      expect(JSON.parse(readFileSync(file, 'utf8')).status).toBe(STATUS.COUNT_DRIFT);
    }
  });
});
