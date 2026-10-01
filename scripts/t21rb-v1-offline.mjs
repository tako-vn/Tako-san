#!/usr/bin/env node
// Offline only: consume a saved five-statement catalog read and emit aggregate evidence.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { compareV1IngredientSemantics } from './t21rb-v1-semantic.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--input' || !args[1]) {
  console.error('usage: node scripts/t21rb-v1-offline.mjs --input <saved-runtime-catalog.json>');
  process.exit(2);
}

const root = process.cwd();
const read = (file) => readFileSync(path.resolve(root, file), 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
let vite;
try {
  const spec = JSON.parse(read('docs/ai/recipe-catalog/T21RA_RUNTIME_CANONICAL_TARGET.json'));
  const manifestBytes = read('packages/recipes/src/import/catalog-release.current.json');
  if (spec.status !== 'T21RA_CANONICAL_TARGET_CERTIFIED'
      || spec.repository?.id !== 1385308553
      || sha256(manifestBytes) !== spec.target?.releaseManifestFileSha256) {
    throw new Error('T21R-A source proof failed');
  }
  const registryBytes = read('data/recipe-import/approved-batches.json');
  if (sha256(registryBytes) !== spec.target.approvedBatchesFileSha256) {
    throw new Error('Approved batch registry proof failed');
  }

  vite = await createServer({
    server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { ALL_RECIPES } = await vite.ssrLoadModule('/packages/recipes/src/data.ts');
  const factory = await vite.ssrLoadModule('/packages/recipes/src/import/index.ts');
  const approved = [];
  for (const entry of JSON.parse(registryBytes).batches) {
    const format = factory.importFormatForPath(entry.source);
    const compiled = await factory.compileImportBatch(
      new Uint8Array(readFileSync(path.resolve(root, entry.source))), format,
      { legacy: ALL_RECIPES, approvedBatches: approved },
    );
    if (!compiled.ok || compiled.header.batchId !== entry.batchId
        || compiled.recipes.length !== entry.recipeCount
        || read(path.join('migrations', entry.migration)) !== compiled.artifacts.get('migration.sql')) {
      throw new Error('Approved batch source or migration drift');
    }
    approved.push({ header: compiled.header, recipes: compiled.recipes });
  }
  const composed = await factory.composeCatalogRelease(ALL_RECIPES, approved);
  if (factory.serializeCatalogReleaseManifest(composed.manifest) !== manifestBytes
      || composed.manifest.releaseId !== spec.target.releaseId
      || composed.manifest.expectedRecipeCount !== spec.target.recipeCount
      || composed.manifest.expectedRuntimeFingerprint !== spec.target.expectedRuntimeFingerprint) {
    throw new Error('V1 release no longer matches T21R-A target');
  }

  const raw = JSON.parse(read(args[1]));
  const reconciliation = JSON.parse(read('data/recipe-refresh/v2/ingredient-reconciliation.json'));
  const comparison = await compareV1IngredientSemantics({
    targetRecipes: composed.recipes,
    runtimeResults: raw,
    releaseManifest: composed.manifest,
    reconciliation,
  });
  console.log(JSON.stringify({
    schemaVersion: 1,
    certification: 'NOT_A_RELEASE_CERTIFICATION',
    targetManifestSha256: sha256(manifestBytes),
    ...comparison,
  }, null, 2));
} catch {
  console.error('t21rb=BLOCKED_OFFLINE_INPUT_OR_AUTHORITY');
  process.exitCode = 1;
} finally {
  if (vite) await vite.close();
}
