import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareRecipeContentRead } from '../../packages/db/src/recipe-content';
import { currentCatalogRelease } from '../../packages/recipes/src/recipe-authority';
import { APPROVED_BATCHES_REGISTRY } from '../../scripts/d1-migration-check.mjs';
import { migrationManifest } from '../../scripts/release-check.mjs';
import {
  LEDGER_TIP,
  STAGING_D1,
  STATUS,
  StagingRuntimeReadinessError,
  assertReadOnlySql,
  catalogReadQuery,
  foreignKeyCheckQuery,
  gate,
  guardSql,
  identity,
  ledgerQuery,
  pinnedStagingDatabase,
  provenanceQuery,
  querySql,
  quickCheckQuery,
  remoteQuery,
  verifyCatalogCount,
  verifyExactLedger,
  verifyReadinessHealth,
  verifyRemoteProvenance,
} from '../../scripts/staging-d1-runtime-readiness-check.mjs';

const { load } = createRequire(createRequire(import.meta.url).resolve('eslint/package.json'))('js-yaml');
const workflowText = readFileSync('.github/workflows/staging-d1-runtime-readiness.yml', 'utf8');
const dirs = [];
const temporary = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'staging-runtime-'));
  dirs.push(dir);
  return dir;
};
const write = (dir, name, data) => {
  const file = path.join(dir, name);
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
};
const result = (rows) => [{ success: true, results: rows }];
const schema = migrationManifest(
  process.cwd(),
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
);
const ledger = result(schema.migrations.map((migration) => ({ name: migration.name })));

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('staging D1 runtime readiness SQL and identity', () => {
  it('pins the reviewed staging database and rejects a different identity', () => {
    expect(pinnedStagingDatabase()).toEqual(STAGING_D1);
    const raw = readFileSync('wrangler.staging.jsonc', 'utf8');
    expect(() => pinnedStagingDatabase(raw.replace(STAGING_D1.id, 'deadbeefdeadbeef'))).toThrow(/pinned staging D1|Staging Wrangler config/);
  });

  it('emits only reviewed read-only SELECT/PRAGMA statements', () => {
    expect(guardSql('ledger', ledgerQuery())).toHaveLength(1);
    expect(guardSql('catalog', catalogReadQuery())).toHaveLength(2);
    expect(guardSql('provenance', provenanceQuery())).toHaveLength(1);
    expect(guardSql('runtime-catalog', querySql('runtime-catalog', prepareRecipeContentRead))).toHaveLength(5);
    expect(guardSql('foreign-key-check', foreignKeyCheckQuery())).toEqual(['PRAGMA foreign_key_check']);
    expect(guardSql('quick-check', quickCheckQuery())).toEqual(['PRAGMA quick_check']);
    expect(provenanceQuery()).not.toMatch(/title|description|instruction/i);
  });

  it.each([
    'INSERT INTO recipes VALUES (1)',
    'UPDATE recipes SET title = 1',
    'DELETE FROM recipes',
    'REPLACE INTO recipes VALUES (1)',
    'CREATE TABLE example(id)',
    'DROP TABLE recipes',
    'ALTER TABLE recipes ADD COLUMN example',
    'VACUUM',
    'REINDEX',
    'SELECT 1; DELETE FROM recipes',
  ])('rejects mutation SQL before any remote request: %s', (sql) => {
    expect(() => assertReadOnlySql(sql)).toThrow(/Non-read-only SQL rejected/);
    const dir = temporary();
    const file = write(dir, 'bad.sql', sql);
    const calls = [];
    expect(() => remoteQuery(file, write(dir, 'out.json', {}), {
      execute: (...args) => {
        calls.push(args);
        return JSON.stringify(result([]));
      },
    })).toThrow(/Non-read-only SQL rejected/);
    expect(calls).toHaveLength(0);
  });

  it('remote-query targets only the pinned staging D1 with --command', () => {
    const dir = temporary();
    const sql = write(dir, 'ledger.sql', ledgerQuery());
    const out = path.join(dir, 'out.json');
    const calls = [];
    remoteQuery(sql, out, {
      execute: (_cli, args) => {
        calls.push(args);
        return JSON.stringify(result([{ name: LEDGER_TIP }]));
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'wrangler', 'd1', 'execute', STAGING_D1.name, '--remote', '--yes',
      '--config', 'wrangler.staging.jsonc', '--command', ledgerQuery(), '--json',
    ]);
    expect(calls[0].join(' ')).not.toMatch(/migrations apply|deploy|--file/);
  });

  it('fails closed on the wrong staging D1 identity', () => {
    const dir = temporary();
    const file = write(dir, 'receipt.json', { database: STAGING_D1 });
    expect(() => identity(file, [{ name: STAGING_D1.name, uuid: '00000000000000000000000000000000' }], {
      name: STAGING_D1.name,
      uuid: '00000000000000000000000000000000',
    })).toThrow(StagingRuntimeReadinessError);
    try {
      identity(file, [{ name: STAGING_D1.name, uuid: '00000000000000000000000000000000' }], null);
    } catch (error) {
      expect(error.status).toBe(STATUS.BLOCKED_IDENTITY);
    }
  });

  it('accepts the pinned staging D1 list/info pair', () => {
    const dir = temporary();
    const file = write(dir, 'receipt.json', { database: STAGING_D1 });
    const receipt = identity(
      file,
      [{ name: STAGING_D1.name, uuid: STAGING_D1.id }],
      { name: STAGING_D1.name, uuid: STAGING_D1.id },
    );
    expect(receipt.cloudflare).toMatchObject({
      databaseName: STAGING_D1.name,
      databaseId: STAGING_D1.id,
      infoCrossCheck: 'match',
    });
  });

  it('requires the exact 0039 ledger tip', () => {
    expect(verifyExactLedger(schema, ledger)).toEqual({ tip: LEDGER_TIP, count: schema.count });
    const extra = result([...schema.migrations.map((migration) => ({ name: migration.name })), { name: '0040_unreviewed.sql' }]);
    try {
      verifyExactLedger(schema, extra);
      throw new Error('expected ledger failure');
    } catch (error) {
      expect(error).toBeInstanceOf(StagingRuntimeReadinessError);
      expect(error.status).toBe(STATUS.BLOCKED_LEDGER);
    }
    const missing = result(schema.migrations.slice(0, -1).map((migration) => ({ name: migration.name })));
    expect(() => verifyExactLedger(schema, missing)).toThrow(StagingRuntimeReadinessError);
    expect(() => verifyExactLedger({ ...schema, version: '0038_auth_onboarding_completion.sql' }, ledger))
      .toThrow(/0039_meal_composition_v2/);
  });

  it('fails closed when foreign_key_check or quick_check is unhealthy', () => {
    expect(verifyReadinessHealth({ foreignKeys: result([]), quickCheck: result([{ quick_check: 'ok' }]) }))
      .toEqual({ foreignKeyCheck: 'PASS', quickCheck: 'PASS' });
    try {
      verifyReadinessHealth({ foreignKeys: result([{ table: 'recipes' }]), quickCheck: result([{ quick_check: 'ok' }]) });
      throw new Error('expected fk failure');
    } catch (error) {
      expect(error.status).toBe(STATUS.HEALTH_FAILED);
    }
    try {
      verifyReadinessHealth({ foreignKeys: result([]), quickCheck: result([{ quick_check: 'corrupt' }]) });
      throw new Error('expected quick_check failure');
    } catch (error) {
      expect(error.status).toBe(STATUS.HEALTH_FAILED);
    }
  });

  it('maps a physical 499-row catalog to COUNT_DRIFT', () => {
    const release = currentCatalogRelease();
    try {
      verifyCatalogCount([
        { success: true, results: [{ recipes: release.expectedRecipeCount - 1 }] },
        { success: true, results: [] },
      ], release);
      throw new Error('expected count drift');
    } catch (error) {
      expect(error.status).toBe(STATUS.COUNT_DRIFT);
    }
  });

  it('maps an approved batch hash mismatch to PROVENANCE_DRIFT', () => {
    const release = currentCatalogRelease();
    const drifted = {
      ...release,
      approvedImportBatches: release.approvedImportBatches.map((batch, index) => (
        index === 0 ? { ...batch, batchHash: 'f'.repeat(64) } : batch
      )),
    };
    const rows = release.orderedRecipeIds.map((id, runtime_order) => ({
      id,
      runtime_order,
      source_type: runtime_order < release.legacyBaselineCount ? 'legacy' : 'ai_generated',
      source_reference: runtime_order < release.legacyBaselineCount
        ? null
        : release.approvedImportBatches.find((batch) => (
          runtime_order >= batch.releaseBaseCount && runtime_order < batch.releaseBaseCount + batch.recipeCount
        ))?.sourceReference,
      verification_state: runtime_order < release.legacyBaselineCount ? 'unverified' : 'reviewed',
      version: 1,
    }));
    try {
      verifyRemoteProvenance(result(rows), drifted, JSON.parse(readFileSync(APPROVED_BATCHES_REGISTRY, 'utf8')));
      throw new Error('expected provenance drift');
    } catch (error) {
      expect(error.status).toBe(STATUS.PROVENANCE_DRIFT);
    }
  });

  it('fails if the dispatch is not main before attempting network or D1 operations', async () => {
    const previous = process.env.GITHUB_REF;
    try {
      process.env.GITHUB_REF = 'refs/heads/not-main';
      await expect(gate(write(temporary(), 'receipt.json', {}))).rejects.toMatchObject({ status: STATUS.BLOCKED_MAIN });
    } finally {
      if (previous === undefined) delete process.env.GITHUB_REF;
      else process.env.GITHUB_REF = previous;
    }
  });

  it('rejects a stale or non-SHA ref', async () => {
    const previous = process.env.GITHUB_REF;
    try {
      process.env.GITHUB_REF = 'refs/heads/main';
      await expect(gate(write(temporary(), 'receipt.json', {}), { ref: 'main' }))
        .rejects.toMatchObject({ status: STATUS.BLOCKED_MAIN });
      await expect(gate(write(temporary(), 'receipt.json', {}), { ref: 'a'.repeat(40) }))
        .rejects.toMatchObject({ status: STATUS.BLOCKED_MAIN });
    } finally {
      if (previous === undefined) delete process.env.GITHUB_REF;
      else process.env.GITHUB_REF = previous;
    }
  });
});

describe('manual staging-only D1 runtime readiness workflow', () => {
  it('is workflow_dispatch only, staging Environment, and has no mutation or deploy commands', () => {
    const workflow = load(workflowText);
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(Object.keys(workflow.on.workflow_dispatch.inputs).sort()).toEqual(['confirm_staging_readiness', 'ref']);
    expect(workflow.on.workflow_dispatch.inputs.confirm_staging_readiness).toMatchObject({ default: false, type: 'boolean' });
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(workflow.concurrency).toEqual({ group: 'frigo-deploy-staging', 'cancel-in-progress': false });
    expect(Object.keys(workflow.jobs)).toEqual(['certify']);
    expect(workflow.jobs.certify.environment).toBe('staging');
    expect(workflow.jobs.certify.if).toContain("github.ref == 'refs/heads/main'");
    expect(workflow.jobs.certify.if).toContain('inputs.confirm_staging_readiness == true');
    expect(workflowText).not.toMatch(/wrangler deploy/);
    expect(workflowText).not.toMatch(/d1 migrations apply/);
    expect(workflowText).not.toMatch(/environment:\s*production/);
    expect(workflowText).not.toMatch(/wrangler\.jsonc --/);
    expect(workflowText).not.toMatch(/--file\b/);
    expect(workflowText).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/);
    const artifact = workflow.jobs.certify.steps.find((step) => step.uses === 'actions/upload-artifact@v4');
    expect(artifact.with).toMatchObject({
      path: 'staging-d1-runtime-readiness-receipt.json',
      'if-no-files-found': 'error',
      'retention-days': 90,
    });
    expect(artifact.with.name).toContain('staging-d1-runtime-readiness-');
    const commands = workflow.jobs.certify.steps.flatMap((step) => (step.run || '').split('\n')).filter((line) => /wrangler d1 /.test(line));
    for (const command of commands) {
      if (command.includes('d1 list --json')) continue;
      expect(command).toContain('frigo-db-staging-v3');
      expect(command).toContain('--config wrangler.staging.jsonc');
    }
  });
});
