import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
const PRODUCTION_D1 = { name: 'frigo-db', id: 'f975ec39-b2c8-4a2a-80e1-0366054599d3' };
const CATALOG_RELEASE = 'packages/recipes/src/import/catalog-release.current.json';

function ledgerNames(statements) {
  if (!Array.isArray(statements) || statements.length !== 1 || statements[0]?.success !== true ||
      !Array.isArray(statements[0].results)) {
    throw new Error('Production migration ledger proof is incomplete');
  }
  const names = statements[0].results.map((row) => row?.name);
  if (names.some((name) => typeof name !== 'string') || new Set(names).size !== names.length) {
    throw new Error('Production migration ledger contains invalid names');
  }
  return names;
}

export function summarizeProductionD1({ manifest, release, before, after, runtime, pipeline, checkedAt = new Date().toISOString() }) {
  if (manifest?.environment !== 'production' || !SHA.test(manifest.sha || '') ||
      manifest.mainSha !== manifest.sha || manifest.cloudflare?.databaseId !== PRODUCTION_D1.id ||
      manifest.cloudflare?.databaseName !== PRODUCTION_D1.name ||
      !Array.isArray(manifest.schema?.migrations)) {
    throw new Error('Exact-main production D1 identity proof is incomplete');
  }
  if (!Number.isInteger(release?.expectedRecipeCount) || release.expectedRecipeCount <= 0) {
    throw new Error('Expected catalog recipe count is invalid');
  }
  const preNames = ledgerNames(before);
  const postNames = ledgerNames(after);
  if (JSON.stringify(preNames) !== JSON.stringify(postNames)) {
    throw new Error('Production migration ledger changed during read-only diagnosis');
  }
  if (!Array.isArray(runtime) || runtime.length !== 5 ||
      runtime.some((statement) => statement?.success !== true || !Array.isArray(statement.results))) {
    throw new Error('Five-statement runtime catalog proof is incomplete');
  }
  const expectedNames = manifest.schema.migrations.map((entry) => entry.name);
  if (expectedNames.some((name) => typeof name !== 'string')) throw new Error('Candidate migration manifest is invalid');
  const preSet = new Set(preNames);
  const expectedSet = new Set(expectedNames);
  const content = pipeline.mapRecipeContentRead(runtime);
  const hydration = pipeline.hydrateRuntimeRecipes(content);
  if (!Array.isArray(content.recipes) || !Array.isArray(hydration?.recipes) || !Array.isArray(hydration.failures)) {
    throw new Error('Runtime hydration proof is incomplete');
  }
  const codeCounts = {};
  for (const failure of hydration.failures) {
    if (typeof failure?.code !== 'string' || !/^[a-z_]+$/.test(failure.code)) {
      throw new Error('Runtime hydration returned an invalid failure code');
    }
    codeCounts[failure.code] = (codeCounts[failure.code] ?? 0) + 1;
  }
  const missing = expectedNames.filter((name) => !preSet.has(name));
  const unexpected = preNames.filter((name) => !expectedSet.has(name));
  const countMatchesRelease = content.recipes.length === release.expectedRecipeCount &&
    hydration.recipes.length === release.expectedRecipeCount;
  return {
    schemaVersion: 1,
    status: missing.length || unexpected.length || hydration.failures.length || !countMatchesRelease ? 'BLOCKED' : 'DIAGNOSTIC_OK',
    certification: 'NOT_A_RELEASE_CERTIFICATION',
    readOnly: true,
    productionMutations: [],
    repository: manifest.repository,
    candidateSha: manifest.sha,
    checkedAt,
    database: PRODUCTION_D1,
    ledger: { count: preNames.length, tip: preNames.at(-1) ?? null, missing, unexpected },
    runtimeCatalog: {
      expectedRecipes: release.expectedRecipeCount,
      physicalRows: content.recipes.length,
      hydratedRecipes: hydration.recipes.length,
      countMatchesRelease,
      hydrationFailureCount: hydration.failures.length,
      failureCodeCounts: Object.fromEntries(Object.entries(codeCounts).sort(([a], [b]) => a.localeCompare(b))),
    },
  };
}

async function main() {
  const [manifestPath, beforePath, runtimePath, afterPath, receiptPath] = process.argv.slice(2);
  if (!receiptPath) throw new Error('Expected manifest, pre-ledger, runtime, post-ledger and receipt paths');
  const { loadRuntimeCatalogPipeline } = await import('./d1-migration-check.mjs');
  const pipeline = await loadRuntimeCatalogPipeline();
  try {
    const receipt = summarizeProductionD1({
      manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
      release: JSON.parse(readFileSync(CATALOG_RELEASE, 'utf8')),
      before: JSON.parse(readFileSync(beforePath, 'utf8')),
      runtime: JSON.parse(readFileSync(runtimePath, 'utf8')),
      after: JSON.parse(readFileSync(afterPath, 'utf8')),
      pipeline,
    });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`Read-only production D1 diagnosis: ${receipt.status}; ledger=${receipt.ledger.count}; hydration failures=${receipt.runtimeCatalog.hydrationFailureCount}`);
  } finally {
    await pipeline.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Production D1 diagnosis failed before a complete sanitized receipt could be written');
    process.exitCode = 1;
  });
}
