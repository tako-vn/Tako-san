#!/usr/bin/env node
// Offline only: consume a saved five-statement catalog read and emit aggregate evidence.
import { readFileSync } from 'node:fs';
import { compareV1IngredientSemantics } from './t21rb-v1-semantic.mjs';
import { loadCertifiedV1Authority } from './t21r-v1-authority.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--input' || !args[1]) {
  console.error('usage: node scripts/t21rb-v1-offline.mjs --input <saved-runtime-catalog.json>');
  process.exit(2);
}

try {
  const { targetRecipes, releaseManifest, reconciliation, authorityProof } = await loadCertifiedV1Authority();
  const raw = JSON.parse(readFileSync(args[1], 'utf8'));
  const comparison = await compareV1IngredientSemantics({
    targetRecipes, runtimeResults: raw, releaseManifest, reconciliation,
  });
  console.log(JSON.stringify({
    schemaVersion: 1,
    certification: 'NOT_A_RELEASE_CERTIFICATION',
    targetManifestSha256: authorityProof.releaseManifestSha256,
    ...comparison,
  }, null, 2));
} catch {
  console.error('t21rb=BLOCKED_OFFLINE_INPUT_OR_AUTHORITY');
  process.exitCode = 1;
}
