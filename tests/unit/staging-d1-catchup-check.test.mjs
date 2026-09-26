import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseWranglerJsonc } from '../../scripts/d1-migration-check.mjs';
import { PRE_TIP as STAGING_0039_PRE_TIP, TIP as STAGING_0039_TIP } from '../../scripts/staging-d1-migration-check.mjs';
import {
  ARTIFACT_ROOT,
  CATCHUP_STEPS,
  FORBIDDEN_MIGRATION,
  GLOBAL_RECIPE_IDS,
  HISTORICAL_REPORTED_BOOKMARK,
  STAGING_D1,
  assertFreshBookmark,
  assertRepositoryIdentity,
  buildMigrationPrefix,
  captureBookmark,
  catchupWranglerConfig,
  certify0033Baseline,
  certifyOnboarding,
  certifyPostState,
  expectedSnapshot,
  findCollisions,
  incomingCatalog,
  localReplayAndCertify,
  loadHistoricalRelease,
  onboardingQuery,
  resolveCatchupStep,
  run,
  sha256File,
  stagingConfig,
  validateCatchupCandidate,
  verifyBatchMarker,
  verifyCatchupPlan,
  verifyPrefixIntegrity,
  verifyStagingD1Identity,
  writeCatchupWranglerConfig,
} from '../../scripts/staging-d1-catchup-check.mjs';

const { load } = createRequire(createRequire(import.meta.url).resolve('eslint/package.json'))('js-yaml');
const catchupWorkflow = readFileSync('.github/workflows/staging-d1-catchup.yml', 'utf8');
const migrateWorkflow = readFileSync('.github/workflows/staging-d1-migrate.yml', 'utf8');
const dirs = [];
const temporary = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'staging-catchup-'));
  dirs.push(dir);
  return dir;
};
const write = (dir, name, data) => {
  const file = path.join(dir, name);
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
};
const result = (rows) => [{ success: true, results: rows }];
const ledger = (names) => result(names.map((name) => ({ name })));

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('staging historical catch-up prefix isolation', () => {
  it('copies 0001 through the requested target with matching SHA-256 and never includes 0039', () => {
    const dest = path.join(temporary(), 'migrations');
    const manifest = buildMigrationPrefix({ target: '0034', destDir: dest });
    expect(manifest.included[0].filename).toBe('0001_initial_schema.sql');
    expect(manifest.included.at(-1).filename).toBe('0034_global_recipe_catalog_parity.sql');
    expect(manifest.included.map((entry) => entry.filename)).not.toEqual(
      expect.arrayContaining(['0035_recipe_media_layer.sql', FORBIDDEN_MIGRATION]),
    );
    for (const entry of manifest.included) {
      expect(entry.sourceSha).toBe(entry.copySha);
      expect(entry.copySha).toBe(sha256File(path.join(dest, entry.filename)));
    }
    expect(readdirSync(dest).sort()).toEqual(manifest.included.map((entry) => entry.filename));
    expect(verifyPrefixIntegrity(manifest, { destDir: dest })).toBe('PASS');
  });

  it('builds an 0038 prefix through auth onboarding and still excludes 0039', () => {
    const dest = path.join(temporary(), 'migrations');
    const manifest = buildMigrationPrefix({ target: '0038', destDir: dest });
    expect(manifest.included.at(-1).filename).toBe('0038_auth_onboarding_completion.sql');
    expect(manifest.included.some((entry) => entry.filename === FORBIDDEN_MIGRATION)).toBe(false);
    expect(readdirSync(dest)).not.toContain(FORBIDDEN_MIGRATION);
  });

  it('rejects missing, duplicate, modified, future and 0039-leaking prefixes', () => {
    const source = path.join(temporary(), 'migrations');
    cpSync('migrations', source, { recursive: true });
    expect(() => buildMigrationPrefix({ target: '0039', destDir: path.join(temporary(), 'out') }))
      .toThrow(/0039 belongs to the existing/);
    const dest = path.join(temporary(), 'out');
    const manifest = buildMigrationPrefix({ target: '0034', sourceDir: source, destDir: dest });
    writeFileSync(path.join(dest, FORBIDDEN_MIGRATION), '-- leaked\n');
    expect(() => verifyPrefixIntegrity(manifest, { sourceDir: source, destDir: dest }))
      .toThrow(/0039 leakage/);
    rmSync(path.join(dest, FORBIDDEN_MIGRATION));
    writeFileSync(path.join(dest, '0034_global_recipe_catalog_parity.sql'), '-- mutated\n');
    expect(() => verifyPrefixIntegrity(manifest, { sourceDir: source, destDir: dest }))
      .toThrow(/modified copy/);
    rmSync(path.join(dest, '0001_initial_schema.sql'));
    expect(() => verifyPrefixIntegrity(manifest, { sourceDir: source, destDir: dest }))
      .toThrow(/Prefix directory does not match|ENOENT/);
    writeFileSync(path.join(source, '0034_duplicate.sql'), 'SELECT 1;\n');
    expect(() => buildMigrationPrefix({ target: '0034', sourceDir: source, destDir: path.join(temporary(), 'dup') }))
      .toThrow(/duplicate|malformed/);
    rmSync(path.join(source, '0034_global_recipe_catalog_parity.sql'));
    expect(() => buildMigrationPrefix({ target: '0034', sourceDir: source, destDir: path.join(temporary(), 'missing') }))
      .toThrow(/missing migration|malformed/);
  });
});

describe('ephemeral staging D1-only catch-up config', () => {
  it('preserves staging D1 identity, points migrations_dir at the prefix, and copies no production resources', () => {
    const dir = temporary();
    const migrationsDir = path.join(dir, 'migrations');
    const configPath = path.join(dir, 'wrangler.catchup.jsonc');
    mkdirSync(migrationsDir);
    const written = writeCatchupWranglerConfig({ destFile: configPath, migrationsDir });
    const parsed = parseWranglerJsonc(readFileSync(configPath, 'utf8'), configPath);
    expect(parsed.name).toBe('frigo-staging');
    expect(parsed.vars.ENVIRONMENT).toBe('staging');
    expect(parsed.vars.MEAL_COMPOSITION_V2_ENABLED).toBe('false');
    expect(parsed.d1_databases).toEqual([{
      binding: 'DB',
      database_name: STAGING_D1.name,
      database_id: STAGING_D1.id,
      migrations_dir: migrationsDir.replaceAll('\\', '/'),
    }]);
    expect(parsed.r2_buckets).toBeUndefined();
    expect(parsed.kv_namespaces).toBeUndefined();
    expect(parsed.queues).toBeUndefined();
    expect(parsed.routes).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain('f975ec39-b2c8-4a2a-80e1-0366054599d3');
    expect(written.config).toEqual(catchupWranglerConfig({ migrationsDir }));
    expect(() => catchupWranglerConfig({
      migrationsDir, database: { name: 'frigo-db', id: 'f975ec39-b2c8-4a2a-80e1-0366054599d3' },
    })).toThrow(/Production D1/);
    expect(() => catchupWranglerConfig({
      migrationsDir, database: { name: STAGING_D1.name, id: 'changed' },
    })).toThrow(/identity changed/);
  });

  it('is readable by Wrangler locally and lists only the prefix through the target', () => {
    const dir = temporary();
    const migrationsDir = path.join(dir, 'migrations');
    const configPath = path.join(dir, 'wrangler.catchup.jsonc');
    buildMigrationPrefix({ target: '0034', destDir: migrationsDir });
    writeCatchupWranglerConfig({ destFile: configPath, migrationsDir: 'migrations' });
    const output = execFileSync(
      'pnpm',
      ['wrangler', 'd1', 'migrations', 'list', STAGING_D1.name, '--local', '--persist-to', path.join(dir, 'state'), '--config', configPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(output).toMatch(/0034_global_recipe_catalog_parity\.sql/);
    expect(output).not.toMatch(/0035_recipe_media_layer\.sql/);
    expect(output).not.toMatch(/0039_meal_composition_v2\.sql/);
  });

  it('pins the committed staging config and rejects the production D1 ID', () => {
    const database = stagingConfig();
    expect(database).toMatchObject({ name: STAGING_D1.name, id: STAGING_D1.id, productionRejected: true });
    const raw = readFileSync('wrangler.staging.jsonc', 'utf8');
    expect(() => stagingConfig(raw.replace(STAGING_D1.id, 'f975ec39-b2c8-4a2a-80e1-0366054599d3'))).toThrow(/Staging Wrangler config/);
  });
});

describe('one-step transition model', () => {
  it('allows only 0033→0034 … 0037→0038 and rejects skips and 0039', () => {
    expect(resolveCatchupStep('0034')).toMatchObject({
      preTip: '0033_scan_evidence_completeness.sql',
      file: '0034_global_recipe_catalog_parity.sql',
    });
    expect(() => resolveCatchupStep('0039')).toThrow(/existing staging-d1-migrate/);
    expect(() => resolveCatchupStep('0033')).toThrow(/Unsupported/);
    expect(CATCHUP_STEPS['0035'].preTip).toBe('0034_global_recipe_catalog_parity.sql');
    expect(CATCHUP_STEPS['0038'].preTip).toBe('0037_recipe_catalog_scale.sql');
  });

  it('rejects a 0033→0035 or 0034→0036 request at the ledger gate', async () => {
    const dir = temporary();
    const names = [
      '0032_scan_evidence_retention.sql',
      '0033_scan_evidence_completeness.sql',
      '0034_global_recipe_catalog_parity.sql',
      '0035_recipe_media_layer.sql',
    ];
    const file = write(dir, 'receipt.json', {
      cloudflare: { accountAuthenticated: true },
      schema: { migrations: names.slice(0, 3).map((name) => ({ name })) },
      chain: ['0035_recipe_media_layer.sql'],
      step: CATCHUP_STEPS['0035'],
    });
    await expect(run('pre-ledger', file, [write(dir, 'ledger.json', ledger(names.slice(0, 2)))]))
      .rejects.toThrow(/neither at the expected pre-tip|not 0034|exactly one/);
  });
});

describe('staging identity and repository owner', () => {
  it('accepts the pinned staging D1 and rejects production or changed IDs', () => {
    const list = [
      { name: 'frigo-db', uuid: 'f975ec39-b2c8-4a2a-80e1-0366054599d3' },
      { name: STAGING_D1.name, uuid: STAGING_D1.id },
    ];
    expect(verifyStagingD1Identity({ list, info: { name: STAGING_D1.name, uuid: STAGING_D1.id } }))
      .toMatchObject({ productionRejected: true, databaseId: STAGING_D1.id });
    expect(() => verifyStagingD1Identity({
      list, info: null, expected: { name: 'frigo-db', id: 'f975ec39-b2c8-4a2a-80e1-0366054599d3' },
    })).toThrow(/Production D1/);
    expect(() => verifyStagingD1Identity({
      list: [{ name: STAGING_D1.name, uuid: 'changed' }], info: null,
    })).toThrow(/mismatch in d1 list/);
    expect(() => verifyStagingD1Identity({ list: null, info: null }))
      .toThrow(/STAGING_CLOUDFLARE_CREDENTIAL_REVALIDATION_REQUIRED/);
  });

  it('rejects stale repository owners and the wrong GitHub repository id', () => {
    expect(assertRepositoryIdentity({ repository: 'takovn1/Tako-san', repositoryId: '1385308553' }))
      .toEqual({ fullName: 'takovn1/Tako-san', id: '1385308553' });
    expect(() => assertRepositoryIdentity({ repository: 'tako-vn2/Tako-san', repositoryId: '1385308553' }))
      .toThrow(/Stale repository owner/);
    expect(() => assertRepositoryIdentity({ repository: 'takovn1/Tako-san', repositoryId: '1' }))
      .toThrow(/repository id/);
  });
});

describe('fresh Time Travel bookmark', () => {
  it('records the historical bookmark only as metadata and rejects reused bookmarks', () => {
    const fresh = captureBookmark({ bookmark: 'fresh-bookmark-1' });
    expect(fresh.source).toBe('time-travel-info');
    expect(fresh.historicalReportedBookmark).toBe(HISTORICAL_REPORTED_BOOKMARK);
    expect(assertFreshBookmark(fresh)).toBe('PASS');
    expect(() => assertFreshBookmark({
      bookmark: HISTORICAL_REPORTED_BOOKMARK, source: 'historical', capturedAt: new Date().toISOString(),
    })).toThrow(/fresh Time Travel bookmark|Stale or reused/);
    expect(() => assertFreshBookmark({
      bookmark: HISTORICAL_REPORTED_BOOKMARK, reused: true, source: 'time-travel-info', capturedAt: new Date().toISOString(),
    })).toThrow(/Stale or reused/);
  });
});

describe('0033 baseline and historical certification', () => {
  it('certifies the exact local 0033 recipe set and rejects count/ID/slug drift', () => {
    const baseline = expectedSnapshot('0033_scan_evidence_completeness.sql');
    expect(certify0033Baseline(baseline)).toMatchObject({
      certification: 'STAGING_0033_BASELINE_CERTIFIED', recipeCount: 59,
    });
    expect(() => certify0033Baseline({ ...baseline, recipeCount: 58, ids: baseline.ids.slice(1) }))
      .toThrow(/STAGING_0033_BASELINE_DRIFT/);
    const wrongId = [...baseline.ids];
    wrongId[0] = 'not-a-real-recipe';
    expect(() => certify0033Baseline({
      ...baseline,
      ids: wrongId,
      idSetHash: 'deadbeef',
      integrity: baseline.integrity,
    })).toThrow(/STAGING_0033_BASELINE_DRIFT/);
    expect(() => certify0033Baseline({
      ...baseline,
      ids: [...baseline.ids, 'extra-recipe'],
      recipeCount: 60,
      integrity: { ...baseline.integrity, recipes: 60 },
    })).toThrow(/STAGING_0033_BASELINE_DRIFT/);
    expect(() => certify0033Baseline({
      ...baseline,
      integrity: { ...baseline.integrity, duplicate_slugs: 1 },
    })).toThrow(/duplicate slug/);
  });

  it('certifies 0034–0038 locally against the historical T14F catalog, one step at a time', () => {
    const replay = localReplayAndCertify();
    expect(replay).toEqual([
      { tip: '0033', recipes: 59, certified: 'STAGING_0033_BASELINE_CERTIFIED' },
      { tip: '0034', recipes: 71, certified: 'STAGING_0034_CERTIFIED' },
      { tip: '0035', recipes: 71, certified: 'STAGING_0035_CERTIFIED' },
      { tip: '0036', recipes: 101, certified: 'STAGING_0036_CERTIFIED' },
      { tip: '0037', recipes: 500, certified: 'STAGING_0037_CERTIFIED' },
      { tip: '0038', recipes: 500, certified: 'STAGING_0038_CERTIFIED' },
    ]);
    const release = loadHistoricalRelease();
    const after34 = expectedSnapshot('0034_global_recipe_catalog_parity.sql');
    expect(after34.orderedIds).toEqual(release.orderedRecipeIds.slice(0, 71));
    expect(GLOBAL_RECIPE_IDS.every((id) => after34.ids.includes(id))).toBe(true);
    expect(verifyBatchMarker(CATCHUP_STEPS['0036'])).toBe('PASS');
    expect(verifyBatchMarker(CATCHUP_STEPS['0037'])).toBe('PASS');
    const after38 = expectedSnapshot('0038_auth_onboarding_completion.sql');
    expect(after38.orderedIds).toEqual(release.orderedRecipeIds);
    expect(after38.integrity.media_ready).toBe(0);
    expect(after38.integrity.media_pending).toBe(500);
  });

  it('rejects pilot and scale ID/slug collisions before apply', () => {
    const pre36 = expectedSnapshot('0035_recipe_media_layer.sql');
    const incoming36 = incomingCatalog(CATCHUP_STEPS['0036']);
    expect(incoming36.ids).toHaveLength(30);
    expect(findCollisions(pre36, incoming36)).toBe('PASS');
    expect(() => findCollisions(
      { ids: [...pre36.ids, incoming36.ids[0]], slugs: pre36.slugs },
      { ...incoming36, label: 'pilot' },
    )).toThrow(/Catalog collision/);
    const pre37 = expectedSnapshot('0036_recipe_catalog_pilot.sql');
    const incoming37 = incomingCatalog(CATCHUP_STEPS['0037']);
    expect(incoming37.ids).toHaveLength(399);
    expect(findCollisions(pre37, incoming37)).toBe('PASS');
    expect(() => findCollisions(
      { ids: pre37.ids, slugs: [...pre37.slugs, incoming37.slugs[0]] },
      { ...incoming37, label: 'scale' },
    )).toThrow(/Catalog collision/);
  });
});

describe('catch-up plan and main-moved / ledger-changed gates', () => {
  it('accepts exactly one pending historical migration and rejects 0039 leakage', () => {
    const plan = 'Migrations to be applied:\n│ 0034_global_recipe_catalog_parity.sql │\n';
    expect(verifyCatchupPlan(plan, { file: '0034_global_recipe_catalog_parity.sql', mode: 'apply' }))
      .toEqual({ planned: ['0034_global_recipe_catalog_parity.sql'] });
    expect(() => verifyCatchupPlan(
      `${plan}│ 0035_recipe_media_layer.sql │\n`,
      { file: '0034_global_recipe_catalog_parity.sql', mode: 'apply' },
    )).toThrow(/exactly/);
    expect(() => verifyCatchupPlan(
      'Migrations to be applied:\n│ 0039_meal_composition_v2.sql │\n',
      { file: '0038_auth_onboarding_completion.sql', mode: 'apply' },
    )).toThrow(/0039 leakage/);
    expect(verifyCatchupPlan('✅ No migrations to apply!', {
      file: '0034_global_recipe_catalog_parity.sql', mode: 'certify',
    })).toEqual({ planned: [] });
  });

  it('fails closed when main moved or the ledger changed between preflight and apply', async () => {
    const dir = temporary();
    const names = ['0033_scan_evidence_completeness.sql', '0034_global_recipe_catalog_parity.sql'];
    const file = write(dir, 'receipt.json', {
      sha: '0'.repeat(40),
      repository: { fullName: 'takovn1/Tako-san', id: '1385308553' },
      step: CATCHUP_STEPS['0034'],
      chain: ['0034_global_recipe_catalog_parity.sql'],
      schema: { migrations: names.map((name) => ({ name })) },
      plan: { planned: ['0034_global_recipe_catalog_parity.sql'] },
      prefix: { included: [{ filename: '0034_global_recipe_catalog_parity.sql', sourceSha: 'a', copySha: 'a' }], sha256: 'x' },
      preLedger: { mode: 'apply', tip: '0033_scan_evidence_completeness.sql', chain: ['0034_global_recipe_catalog_parity.sql'] },
    });
    await expect(run('recheck', file)).rejects.toThrow(/main moved/);
  });
});

describe('candidate SHA and hosted CI gates', () => {
  it('requires the catch-up ref to equal current origin/main', () => {
    const mainSha = execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
    expect(validateCatchupCandidate({ ref: mainSha, target: '0034' })).toMatchObject({
      sha: mainSha, mainSha, chain: ['0034_global_recipe_catalog_parity.sql'],
    });
    expect(() => validateCatchupCandidate({ ref: 'main', target: '0034' })).toThrow(/full immutable SHA/);
    expect(() => validateCatchupCandidate({ ref: mainSha, target: '0039' })).toThrow(/0039/);
  });
});

describe('GitHub Actions catch-up workflow', () => {
  it('is manual, staging-only, one migration per run, and never applies 0039', () => {
    const workflow = load(catchupWorkflow);
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.on.workflow_dispatch.inputs.target.options).toEqual(['0034', '0035', '0036', '0037', '0038']);
    expect(workflow.on.workflow_dispatch.inputs.confirm_staging_catchup.default).toBe(false);
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(workflow.concurrency).toEqual({ group: 'frigo-deploy-staging', 'cancel-in-progress': false });
    expect(workflow.jobs.certify.environment).toBe('staging');
    expect(workflow.jobs.certify.if).toContain("github.ref == 'refs/heads/main'");
    expect(workflow.jobs.certify.if).toContain('inputs.confirm_staging_catchup == true');
    expect(catchupWorkflow).not.toContain('environment: production');
    expect(catchupWorkflow).not.toContain('wrangler.jsonc --');
    expect(catchupWorkflow).not.toContain('time-travel restore');
    expect(catchupWorkflow).not.toContain(FORBIDDEN_MIGRATION);
    const apply = workflow.jobs.certify.steps.find((step) => step.name?.startsWith('Apply only the certified'));
    expect(apply.run).toContain('--config "$config"');
    expect(apply.run).toContain('migrations apply');
    expect(apply.run).not.toContain('wrangler.staging.jsonc');
    const identity = workflow.jobs.certify.steps.find((step) => step.name?.startsWith('Prove Cloudflare'));
    expect(identity.run).toContain('--config wrangler.staging.jsonc');
    expect(identity.run).toContain('frigo-db-staging-v3');
    const preflight = workflow.jobs.certify.steps
      .slice(0, workflow.jobs.certify.steps.indexOf(apply))
      .map((step) => step.run || '')
      .join('\n');
    expect(preflight).not.toMatch(/wrangler d1 migrations apply/);
  });

  it('does not weaken the existing 0039 staging migration workflow', () => {
    expect(STAGING_0039_PRE_TIP).toBe('0038_auth_onboarding_completion.sql');
    expect(STAGING_0039_TIP).toBe(FORBIDDEN_MIGRATION);
    const workflow = load(migrateWorkflow);
    expect(workflow.concurrency).toEqual({ group: 'frigo-deploy-staging', 'cancel-in-progress': false });
    expect(migrateWorkflow).toMatch(/certified 0039 chain|applying\/certifying 0039/);
    expect(workflow.jobs.certify.steps.some((step) => /Apply only the certified 0039/.test(step.name))).toBe(true);
  });
});


describe('recheck CI and ledger races', () => {
  const successfulRun = (sha) => ({
    id: 36274587084,
    run_attempt: 1,
    html_url: 'https://github.com/takovn1/Tako-san/actions/runs/36274587084',
    head_sha: sha,
    head_branch: 'main',
    event: 'push',
    path: '.github/workflows/ci.yml',
    status: 'completed',
    conclusion: 'success',
    updated_at: '2026-09-26T00:00:00Z',
    repository: { full_name: 'takovn1/Tako-san' },
    head_repository: { full_name: 'takovn1/Tako-san' },
  });

  it('rejects unsuccessful exact-main CI and a ledger that changed after preflight', async () => {
    const mainSha = execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
    const dir = temporary();
    const dest = path.join(dir, 'migrations');
    const prefix = buildMigrationPrefix({ target: '0034', destDir: dest });
    const names = prefix.included.map((entry) => entry.filename);
    const file = write(dir, 'receipt.json', {
      sha: mainSha,
      repository: { fullName: 'takovn1/Tako-san', id: '1385308553' },
      ci: { id: 1 },
      step: CATCHUP_STEPS['0034'],
      chain: ['0034_global_recipe_catalog_parity.sql'],
      schema: { migrations: names.map((name) => ({ name })) },
      plan: { planned: ['0034_global_recipe_catalog_parity.sql'] },
      prefix: { ...prefix, destDir: dest },
      preLedger: {
        mode: 'apply',
        tip: '0033_scan_evidence_completeness.sql',
        count: names.length - 1,
        names: names.slice(0, -1),
        chain: ['0034_global_recipe_catalog_parity.sql'],
      },
    });
    const previousToken = process.env.GH_TOKEN;
    const previousRepo = process.env.GITHUB_REPOSITORY;
    const previousFetch = globalThis.fetch;
    process.env.GH_TOKEN = 'test-token';
    process.env.GITHUB_REPOSITORY = 'takovn1/Tako-san';
    try {
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ workflow_runs: [{ ...successfulRun(mainSha), conclusion: 'failure' }] }),
      });
      await expect(run('recheck', file)).rejects.toThrow(/successful/);
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ workflow_runs: [successfulRun(mainSha)] }),
      });
      await expect(run('recheck', file, [write(dir, 'changed-ledger.json', ledger(names.slice(0, -2)))]))
        .rejects.toThrow(/ledger changed|neither at the expected pre-tip/);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previousToken;
      if (previousRepo === undefined) delete process.env.GITHUB_REPOSITORY;
      else process.env.GITHUB_REPOSITORY = previousRepo;
    }
  });
});

describe('fail-closed run() commands', () => {
  it('refuses gate when the dispatch is not main', async () => {
    const previous = process.env.GITHUB_REF;
    try {
      process.env.GITHUB_REF = 'refs/heads/feat/staging-d1-catchup-0033-0038';
      await expect(run('gate', write(temporary(), 'receipt.json', {}))).rejects.toThrow(/main/);
    } finally {
      if (previous === undefined) delete process.env.GITHUB_REF;
      else process.env.GITHUB_REF = previous;
    }
  });

  it('refuses identity when the receipt database is production', async () => {
    const dir = temporary();
    const file = write(dir, 'receipt.json', {
      database: { name: 'frigo-db', id: 'f975ec39-b2c8-4a2a-80e1-0366054599d3' },
    });
    const list = write(dir, 'list.json', [{ name: 'frigo-db', uuid: 'f975ec39-b2c8-4a2a-80e1-0366054599d3' }]);
    const info = write(dir, 'info.json', { name: 'frigo-db', uuid: 'f975ec39-b2c8-4a2a-80e1-0366054599d3' });
    await expect(run('identity', file, [list, info])).rejects.toThrow(/Production D1/);
  });
});
