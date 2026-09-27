#!/usr/bin/env node
// T20 release guard: the Worker var and the build-time UI flag must ship as one decision.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseWranglerJsonc } from './d1-migration-check.mjs';

export const COMPOSITION_FLAG_BUILD_RECORD = 'dist/composition-flags.json';
const CANONICAL = ['true', 'false'];

/** Passes only for off/off or on/on with exact canonical strings; returns the shared value. */
export function verifyCompositionFlagPair({ server, ui }) {
  if (!CANONICAL.includes(server))
    throw new Error(`MEAL_COMPOSITION_V2_ENABLED must be exactly 'true' or 'false' (got ${JSON.stringify(server)})`);
  if (!CANONICAL.includes(ui))
    throw new Error(`VITE_MEAL_COMPOSITION_V2_ENABLED must be exactly 'true' or 'false' (got ${JSON.stringify(ui)})`);
  if (server !== ui)
    throw new Error(`Composition flag mismatch: server=${server} ui=${ui}; both must be enabled or disabled together`);
  return server;
}

/** Also binds the pair to the immutable release manifest and to what Vite actually compiled. */
export function verifyCompositionRelease({ server, ui, manifest, buildRecord }) {
  const value = verifyCompositionFlagPair({ server, ui });
  if (typeof manifest?.mealCompositionV2Enabled !== 'boolean')
    throw new Error('Release manifest is missing boolean mealCompositionV2Enabled');
  if (String(manifest.mealCompositionV2Enabled) !== value)
    throw new Error(`Release manifest approved mealCompositionV2Enabled=${manifest.mealCompositionV2Enabled}, deploy requested ${value}`);
  const built = buildRecord?.VITE_MEAL_COMPOSITION_V2_ENABLED;
  if (built !== value)
    throw new Error(`Built UI compiled VITE_MEAL_COMPOSITION_V2_ENABLED=${JSON.stringify(built ?? null)}, expected ${value}`);
  return value;
}

/** Staging T20 must not ship behind a disabled planner route or a hidden planner UI. */
export function verifyStagingPlannerPrerequisite({ composition, config, buildRecord }) {
  if (config?.vars?.ENVIRONMENT !== 'staging')
    throw new Error('Planner prerequisite must use the staging Wrangler configuration');
  if (composition !== 'true') return;
  if (config.vars.MEAL_PLANNER_ENABLED !== 'true')
    throw new Error('Staging T20 requires MEAL_PLANNER_ENABLED=true in Wrangler config');
  if (buildRecord?.VITE_MEAL_PLANNER_ENABLED !== 'true')
    throw new Error('Staging T20 requires VITE_MEAL_PLANNER_ENABLED=true in the built UI');
}

function main() {
  const [command, manifestFile = 'release-manifest.json', buildRecordFile = COMPOSITION_FLAG_BUILD_RECORD, stagingConfigFile] =
    process.argv.slice(2);
  if (command !== 'verify')
    throw new Error('Usage: composition-flags.mjs verify [release-manifest.json] [dist/composition-flags.json] [wrangler.staging.jsonc]');
  const buildRecord = JSON.parse(readFileSync(buildRecordFile, 'utf8'));
  const value = verifyCompositionRelease({
    server: process.env.MEAL_COMPOSITION_V2_ENABLED,
    ui: process.env.VITE_MEAL_COMPOSITION_V2_ENABLED,
    manifest: JSON.parse(readFileSync(manifestFile, 'utf8')),
    buildRecord,
  });
  if (stagingConfigFile) {
    verifyStagingPlannerPrerequisite({
      composition: value,
      config: parseWranglerJsonc(readFileSync(stagingConfigFile, 'utf8'), stagingConfigFile),
      buildRecord,
    });
  }
  console.log(`Meal Composition V2 flags consistent: server=${value} ui=${value}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
