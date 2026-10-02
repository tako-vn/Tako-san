import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { reviewedIngredientBridgePair } from './t21rb-v1-semantic.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export async function loadCertifiedV1Authority(root = process.cwd()) {
  const read = (file) => readFileSync(path.resolve(root, file), 'utf8');
  const contradiction = () => { throw new Error('T21RC_AUTHORITY_CONTRADICTION'); };
  const specBytes = read('docs/ai/recipe-catalog/T21RA_RUNTIME_CANONICAL_TARGET.json');
  const spec = JSON.parse(specBytes);
  const manifestBytes = read('packages/recipes/src/import/catalog-release.current.json');
  const registryBytes = read('data/recipe-import/approved-batches.json');
  if (spec.status !== 'T21RA_CANONICAL_TARGET_CERTIFIED'
      || spec.repository?.id !== 1385308553 || spec.runtimePositionAuthority !== false
      || sha256(manifestBytes) !== spec.target?.releaseManifestFileSha256
      || sha256(registryBytes) !== spec.target?.approvedBatchesFileSha256) contradiction();

  const vite = await createServer({
    root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { ALL_RECIPES } = await vite.ssrLoadModule('/packages/recipes/src/data.ts');
    const factory = await vite.ssrLoadModule('/packages/recipes/src/import/index.ts');
    const { CANONICAL_INGREDIENTS } = await vite.ssrLoadModule('/packages/domain/src/index.ts');
    const approved = [];
    for (const entry of JSON.parse(registryBytes).batches) {
      const compiled = await factory.compileImportBatch(
        new Uint8Array(readFileSync(path.resolve(root, entry.source))),
        factory.importFormatForPath(entry.source),
        { legacy: ALL_RECIPES, approvedBatches: approved },
      );
      if (!compiled.ok || compiled.header.batchId !== entry.batchId
          || compiled.recipes.length !== entry.recipeCount
          || read(path.join('migrations', entry.migration)) !== compiled.artifacts.get('migration.sql')) contradiction();
      approved.push({ header: compiled.header, recipes: compiled.recipes });
    }
    const composed = await factory.composeCatalogRelease(ALL_RECIPES, approved);
    if (factory.serializeCatalogReleaseManifest(composed.manifest) !== manifestBytes
        || composed.manifest.releaseId !== spec.target.releaseId
        || composed.manifest.expectedRecipeCount !== spec.target.recipeCount
        || composed.manifest.expectedRuntimeFingerprint !== spec.target.expectedRuntimeFingerprint
        || composed.recipes.reduce((sum, recipe) => sum + recipe.ingredients.length, 0)
          !== spec.target.historicalReplayIngredientLines) contradiction();

    const reconciliationBytes = read('data/recipe-refresh/v2/ingredient-reconciliation.json');
    const reconciliation = JSON.parse(reconciliationBytes);
    if (!Array.isArray(reconciliation)) contradiction();
    return {
      targetRecipes: composed.recipes,
      releaseManifest: composed.manifest,
      canonicalIngredientIds: CANONICAL_INGREDIENTS.map((ingredient) => ingredient.id).sort(),
      reconciliation,
      authorityProof: {
        canonicalTargetSha256: sha256(specBytes), releaseManifestSha256: sha256(manifestBytes),
        approvedBatchesSha256: sha256(registryBytes),
        canonicalRegistrySourceSha256: sha256(read('packages/domain/src/index.ts')),
        reconciliationSha256: sha256(reconciliationBytes),
        releaseId: composed.manifest.releaseId,
        runtimeFingerprint: composed.manifest.expectedRuntimeFingerprint,
        reviewedBridgeCount: reconciliation.filter((row) => reviewedIngredientBridgePair(row) !== null).length,
      },
    };
  } finally {
    await vite.close();
  }
}
