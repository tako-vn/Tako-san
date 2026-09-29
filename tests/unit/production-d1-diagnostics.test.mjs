import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { summarizeProductionD1 } from '../../scripts/production-d1-diagnostics.mjs';

const require = createRequire(import.meta.url);
const { load } = createRequire(require.resolve('eslint/package.json'))('js-yaml');
const workflow = load(readFileSync('.github/workflows/production-d1-diagnostics.yml', 'utf8'));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const reviewedCommands = {
  'gate: Require immutable current main and exact-SHA CI': 'bb59f159a35e7931871600cbc25d6e9a1ef97703d1c416bf5a9617bd2e5d8cc3',
  'diagnose: Install pinned diagnostic tooling': 'f733afb2da73a36bd48778fd7502436e384741ad191367d97182afc4909130a5',
  'diagnose: Recheck exact main and production config': 'aa81ef73b471de6553f8479ec179a3534902e91dbd0e24374184626b80ecda5f',
  'diagnose: Prove production Cloudflare and D1 identity': '85138173f0ce3c2bdc434d4793e6c0507bb987edd6c45b199fab58afdf3ef9be',
  'diagnose: Generate and guard five reviewed SELECTs': 'db57117329c68de539a7f51075d92a4cf6794ce55f088dc58e3ff252c4d11d62',
  'diagnose: Read production ledger and runtime catalog without mutation': 'fd63c230813d382d7b51499e6126a5dd2ea6128f1efa32e366c875bc7e9f9512',
  'diagnose: Reject main change during diagnosis': 'aeff76d12b6bb0d47fe50f41a1c3f44116874d40a5e3d5975781f32e86078d69',
};
const sha = 'a'.repeat(40);
const db = 'f975ec39-b2c8-4a2a-80e1-0366054599d3';
const manifest = {
  repository: 'takovn2/Tako-san', environment: 'production', sha, mainSha: sha,
  cloudflare: { databaseName: 'frigo-db', databaseId: db },
  schema: { migrations: [{ name: '0038_auth_onboarding_completion.sql' }, { name: '0039_meal_composition_v2.sql' }] },
};
const release = { expectedRecipeCount: 500 };
const ledger = [{ success: true, results: [{ name: '0038_auth_onboarding_completion.sql' }] }];
const runtime = Array.from({ length: 5 }, () => ({ success: true, results: [] }));
const pipeline = {
  mapRecipeContentRead: () => ({ recipes: [{ id: 'private-recipe-id' }] }),
  hydrateRuntimeRecipes: () => ({ recipes: [], failures: [{ id: 'private-recipe-id', code: 'incomplete_entry', reasons: ['private'] }] }),
};
const summarize = (overrides = {}) => summarizeProductionD1({
  manifest, release, before: ledger, after: ledger, runtime, pipeline, checkedAt: '2026-09-29T00:00:00.000Z', ...overrides,
});

function assertReviewedWorkflow(candidate) {
  expect(Object.keys(candidate).sort()).toEqual(['concurrency', 'jobs', 'name', 'on', 'permissions']);
  expect(Object.keys(candidate.on)).toEqual(['workflow_dispatch']);
  expect(candidate.permissions).toEqual({ contents: 'read', actions: 'read' });
  expect(candidate.concurrency).toEqual({ group: 'frigo-deploy-production', 'cancel-in-progress': false });
  expect(Object.keys(candidate.jobs)).toEqual(['gate', 'diagnose']);
  expect(candidate.jobs.gate.if).toBe("github.ref == 'refs/heads/main' && inputs.confirm_read_only_diagnostics == true");
  expect(candidate.jobs.diagnose.environment).toBe('production');
  expect(candidate.jobs.diagnose.needs).toBe('gate');
  const commands = {};
  const actionNames = [];
  for (const [jobName, job] of Object.entries(candidate.jobs)) {
    for (const step of job.steps) {
      if (step.run) {
        const key = `${jobName}: ${step.name}`;
        expect(commands[key]).toBeUndefined();
        commands[key] = hash(step.run);
      } else {
        actionNames.push(`${jobName}: ${step.uses}`);
        expect(step.env).toBeUndefined();
      }
    }
  }
  expect(commands).toEqual(reviewedCommands);
  expect(actionNames).toEqual([
    'gate: actions/checkout@v4', 'gate: actions/setup-node@v4', 'gate: actions/upload-artifact@v4',
    'diagnose: actions/checkout@v4', 'diagnose: actions/download-artifact@v4',
    'diagnose: actions/setup-node@v4', 'diagnose: pnpm/action-setup@v4',
    'diagnose: actions/upload-artifact@v4',
  ]);
  expect(candidate.jobs.gate.steps[0].with).toMatchObject({ ref: 'main', 'persist-credentials': false });
  expect(candidate.jobs.diagnose.steps[0].with).toMatchObject({ ref: '${{ needs.gate.outputs.candidate_sha }}', 'persist-credentials': false });
  expect(candidate.jobs.diagnose.steps.at(-1)).toMatchObject({
    if: 'always()', with: { path: 'production-d1-diagnostics.json', 'if-no-files-found': 'warn' },
  });
  const scripts = candidate.jobs.diagnose.steps.map((step) => step.run ?? '').join('\n');
  expect(scripts).toContain('node scripts/release-check.mjs recheck');
  expect(scripts).toContain('node scripts/d1-migration-check.mjs identity');
  expect(scripts).toContain('node scripts/d1-readonly-query.mjs runtime-catalog');
  expect(scripts).toContain('SELECT name FROM d1_migrations ORDER BY name');
  expect(scripts).not.toMatch(/\b(?:migrations apply|wrangler deploy|secret put|--file runtime-catalog)\b/);
}

describe('production read-only D1 diagnostics', () => {
  it('reports migration gap and hydration codes without recipe or user identifiers', () => {
    const result = summarize();
    expect(result.status).toBe('BLOCKED');
    expect(result.ledger).toMatchObject({ count: 1, tip: '0038_auth_onboarding_completion.sql', missing: ['0039_meal_composition_v2.sql'], unexpected: [] });
    expect(result.runtimeCatalog).toMatchObject({ expectedRecipes: 500, physicalRows: 1, hydratedRecipes: 0, countMatchesRelease: false, hydrationFailureCount: 1, failureCodeCounts: { incomplete_entry: 1 } });
    expect(result.productionMutations).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('rejects unproven identity and changing ledgers', () => {
    expect(() => summarize({ manifest: { ...manifest, cloudflare: { databaseName: 'frigo-db', databaseId: 'other' } } })).toThrow(/identity/);
    expect(() => summarize({ after: [{ success: true, results: [{ name: '0039_meal_composition_v2.sql' }] }] })).toThrow(/changed/);
    expect(() => summarize({ runtime: runtime.slice(1) })).toThrow(/Five-statement/);
    expect(() => summarize({ release: { expectedRecipeCount: 0 } })).toThrow(/count/);
  });

  it('blocks a catalog count mismatch even when hydration reports no failures', () => {
    const result = summarize({
      before: [{ success: true, results: manifest.schema.migrations.map(({ name }) => ({ name })) }],
      after: [{ success: true, results: manifest.schema.migrations.map(({ name }) => ({ name })) }],
      pipeline: {
        mapRecipeContentRead: () => ({ recipes: [{ id: 'private-recipe-id' }] }),
        hydrateRuntimeRecipes: () => ({ recipes: [{ id: 'private-recipe-id' }], failures: [] }),
      },
    });
    expect(result.status).toBe('BLOCKED');
    expect(result.runtimeCatalog.countMatchesRelease).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('pins the reviewed manual workflow and its entire executable shell surface', () => {
    assertReviewedWorkflow(workflow);
    const candidate = structuredClone(workflow);
    candidate.jobs.diagnose.steps.find((step) => step.run?.includes('runtime-catalog')).run += '\npnpm wrangler d1 migrations apply frigo-db --remote';
    expect(() => assertReviewedWorkflow(candidate)).toThrow();
  });
});

it('verifies the configured Cloudflare account before the first production D1 query', () => {
  const steps = workflow.jobs.diagnose.steps;
  const identity = steps.find((step) => step.name === 'Prove production Cloudflare and D1 identity');
  expect(identity.env).toEqual({
    CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
    CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
    WRANGLER_SEND_METRICS: 'false',
  });
  const commands = identity.run.trim().split('\n').map((line) => line.trim());
  expect(commands[0]).toContain('if (!process.env.CLOUDFLARE_API_TOKEN || !/^[a-f0-9]{32}$/i.test(process.env.CLOUDFLARE_ACCOUNT_ID');
  expect(commands[1]).toBe('pnpm wrangler whoami > cloudflare-identity.txt');
  expect(commands[2]).toContain('readFileSync("cloudflare-identity.txt", "utf8").includes(process.env.CLOUDFLARE_ACCOUNT_ID)');
  expect(commands[3]).toBe('pnpm wrangler d1 list --json > d1-list.json');
});
