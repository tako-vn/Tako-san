import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  verifyCompositionFlagPair,
  verifyCompositionRelease,
} from '../../scripts/composition-flags.mjs';
import { resolveMealCompositionV2Release } from '../../scripts/release-check.mjs';
import { parseWranglerJsonc } from '../../scripts/d1-migration-check.mjs';

// Reuse the YAML parser owned by the locked ESLint dependency, without adding tooling.
const require = createRequire(import.meta.url);
const { load } = createRequire(require.resolve('eslint/package.json'))('js-yaml');
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const deploySource = read('.github/workflows/deploy.yml');
const deploy = load(deploySource);
const OUTPUT = '${{ needs.release.outputs.meal_composition_v2_enabled }}';
const stepIndex = (steps, name) => steps.findIndex((step) => step.name === name);
const GUARD = 'Require matching Meal Composition V2 server and UI flags';

describe('T20 composition flags: Wrangler defaults', () => {
  it.each(['wrangler.jsonc', 'wrangler.staging.jsonc', 'wrangler.staging.jsonc.example'])(
    '%s defaults MEAL_COMPOSITION_V2_ENABLED to "false"',
    (file) => {
      expect(parseWranglerJsonc(read(file), file).vars.MEAL_COMPOSITION_V2_ENABLED).toBe('false');
    },
  );
});

describe('T20 composition flags: release gate normalization', () => {
  it('is off for pushes, missing input and the default dispatch', () => {
    expect(resolveMealCompositionV2Release({ eventName: 'workflow_run', input: 'false' })).toBe('false');
    expect(resolveMealCompositionV2Release({ eventName: 'workflow_run', input: 'true' })).toBe('false');
    expect(resolveMealCompositionV2Release({ eventName: 'workflow_dispatch', input: undefined })).toBe('false');
    expect(resolveMealCompositionV2Release({ eventName: 'workflow_dispatch', input: 'false' })).toBe('false');
    expect(resolveMealCompositionV2Release({ eventName: undefined, input: 'true' })).toBe('false');
  });
  it('is on only for an explicit dispatch opt-in', () => {
    expect(resolveMealCompositionV2Release({ eventName: 'workflow_dispatch', input: 'true' })).toBe('true');
  });
  it('treats any non-canonical value as off', () => {
    for (const input of ['TRUE', 'True', ' true', 'true ', '1', 'yes', 'on', '', true, 1, null]) {
      expect(resolveMealCompositionV2Release({ eventName: 'workflow_dispatch', input }), String(input)).toBe('false');
    }
  });
  it('the gate emits the normalized value as a step output and records it in the manifest', () => {
    const script = read('scripts/release-check.mjs');
    expect(script).toContain('input: process.env.MEAL_COMPOSITION_V2_ENABLED_INPUT');
    expect(script).toContain('eventName: process.env.GITHUB_EVENT_NAME');
    expect(script).toContain("mealCompositionV2Enabled: mealCompositionV2Enabled === 'true'");
    expect(script).toContain('meal_composition_v2_enabled=${mealCompositionV2Enabled}');
  });
});

describe('T20 composition flags: deploy workflow wiring', () => {
  it('requires an explicit dispatch so a main push cannot turn off live staging T20', () => {
    expect(Object.keys(deploy.on)).toEqual(['workflow_dispatch']);
    expect(deploy.jobs.release.if).toContain("github.ref == 'refs/heads/main'");
    expect(deploy.jobs.release.if).toContain("inputs.environment == 'staging'");
  });
  it('declares a boolean dispatch input defaulting to false', () => {
    const input = deploy.on.workflow_dispatch.inputs.meal_composition_v2_enabled;
    expect(input.type).toBe('boolean');
    expect(input.default).toBe(false);
    expect(input.description).toMatch(/BOTH/);
  });
  it('the release job derives one normalized output from the gate', () => {
    const release = deploy.jobs.release;
    expect(release.outputs.meal_composition_v2_enabled).toBe(
      '${{ steps.gate.outputs.meal_composition_v2_enabled }}',
    );
    const gate = release.steps.find((step) => step.id === 'gate');
    expect(gate.run).toBe('node scripts/release-check.mjs gate');
    expect(gate.env.MEAL_COMPOSITION_V2_ENABLED_INPUT).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.meal_composition_v2_enabled || false }}",
    );
  });
  it.each(['staging', 'production'])(
    '%s builds the UI flag and deploys the Worker var from the same output, guarded in between',
    (job) => {
      const steps = deploy.jobs[job].steps;
      const build = stepIndex(steps, 'Build');
      const guard = stepIndex(steps, GUARD);
      const deployStep = steps.findIndex((step) => String(step.with?.command ?? '').startsWith('deploy '));
      expect(build).toBeGreaterThan(-1);
      expect(steps[build].run).toBe('pnpm build');
      expect(steps[build].env.VITE_MEAL_COMPOSITION_V2_ENABLED).toBe(OUTPUT);
      expect(guard).toBeGreaterThan(build);
      expect(deployStep).toBeGreaterThan(guard);
      expect(steps[guard].run).toBe(
        'node scripts/composition-flags.mjs verify release-manifest.json dist/composition-flags.json',
      );
      expect(steps[guard].env).toEqual({
        MEAL_COMPOSITION_V2_ENABLED: OUTPUT,
        VITE_MEAL_COMPOSITION_V2_ENABLED: OUTPUT,
      });
      if (job === 'staging') expect(steps[guard].if).toBe(steps[build].if);
      expect(steps[deployStep].with.command).toContain(`--var MEAL_COMPOSITION_V2_ENABLED:${OUTPUT}`);
      // No other build in the job may compile the UI without the flag.
      expect(steps.filter((step) => /pnpm build\b/.test(String(step.run ?? '')))).toHaveLength(1);
    },
  );
  it('never reads the dispatch input anywhere but the normalizing gate', () => {
    expect(deploySource.match(/inputs\.meal_composition_v2_enabled/g)).toHaveLength(1);
    expect(deploySource.match(/MEAL_COMPOSITION_V2_ENABLED:\$\{\{ needs\.release\.outputs\.meal_composition_v2_enabled \}\}/g)).toHaveLength(2);
  });
});

describe('T20 composition flags: build consistency guard', () => {
  const manifest = (enabled) => ({ mealCompositionV2Enabled: enabled });
  const record = (value) => ({ VITE_MEAL_COMPOSITION_V2_ENABLED: value });
  it('passes off/off and on/on', () => {
    expect(verifyCompositionFlagPair({ server: 'false', ui: 'false' })).toBe('false');
    expect(verifyCompositionFlagPair({ server: 'true', ui: 'true' })).toBe('true');
    expect(verifyCompositionRelease({ server: 'false', ui: 'false', manifest: manifest(false), buildRecord: record('false') })).toBe('false');
    expect(verifyCompositionRelease({ server: 'true', ui: 'true', manifest: manifest(true), buildRecord: record('true') })).toBe('true');
  });
  it('fails any mismatch', () => {
    expect(() => verifyCompositionFlagPair({ server: 'true', ui: 'false' })).toThrow(/mismatch/);
    expect(() => verifyCompositionFlagPair({ server: 'false', ui: 'true' })).toThrow(/mismatch/);
  });
  it('fails non-canonical or missing values', () => {
    for (const bad of [undefined, null, '', 'TRUE', 'True', '1', '0', 'yes', ' true', true, false]) {
      expect(() => verifyCompositionFlagPair({ server: bad, ui: bad }), String(bad)).toThrow(/exactly/);
      expect(() => verifyCompositionFlagPair({ server: 'false', ui: bad }), String(bad)).toThrow(/exactly/);
    }
  });
  it('fails when the manifest or the compiled UI disagrees with the deploy value', () => {
    expect(() => verifyCompositionRelease({ server: 'true', ui: 'true', manifest: manifest(false), buildRecord: record('true') })).toThrow(/manifest/);
    expect(() => verifyCompositionRelease({ server: 'true', ui: 'true', manifest: {}, buildRecord: record('true') })).toThrow(/manifest/);
    expect(() => verifyCompositionRelease({ server: 'true', ui: 'true', manifest: manifest('true'), buildRecord: record('true') })).toThrow(/manifest/);
    expect(() => verifyCompositionRelease({ server: 'true', ui: 'true', manifest: manifest(true), buildRecord: record('false') })).toThrow(/Built UI/);
    expect(() => verifyCompositionRelease({ server: 'false', ui: 'false', manifest: manifest(false), buildRecord: record(null) })).toThrow(/Built UI/);
    expect(() => verifyCompositionRelease({ server: 'false', ui: 'false', manifest: manifest(false), buildRecord: {} })).toThrow(/Built UI/);
  });

  const dir = mkdtempSync(path.join(tmpdir(), 'composition-flags-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const runCli = ({ server, ui, enabled, built }) => {
    const manifestFile = path.join(dir, 'manifest.json');
    const recordFile = path.join(dir, 'record.json');
    writeFileSync(manifestFile, JSON.stringify(manifest(enabled)));
    writeFileSync(recordFile, JSON.stringify(record(built)));
    const env = { PATH: process.env.PATH };
    if (server !== undefined) env.MEAL_COMPOSITION_V2_ENABLED = server;
    if (ui !== undefined) env.VITE_MEAL_COMPOSITION_V2_ENABLED = ui;
    return spawnSync(process.execPath, ['scripts/composition-flags.mjs', 'verify', manifestFile, recordFile], {
      env,
      encoding: 'utf8',
    }).status;
  };
  it('CLI exits 0 for off/off and on/on, non-zero for mismatch or missing flags', () => {
    expect(runCli({ server: 'false', ui: 'false', enabled: false, built: 'false' })).toBe(0);
    expect(runCli({ server: 'true', ui: 'true', enabled: true, built: 'true' })).toBe(0);
    expect(runCli({ server: 'true', ui: 'false', enabled: true, built: 'false' })).not.toBe(0);
    expect(runCli({ server: 'false', ui: 'true', enabled: false, built: 'true' })).not.toBe(0);
    expect(runCli({ server: 'true', ui: 'true', enabled: true, built: 'false' })).not.toBe(0);
    expect(runCli({ server: undefined, ui: undefined, enabled: false, built: 'false' })).not.toBe(0);
  });
});
