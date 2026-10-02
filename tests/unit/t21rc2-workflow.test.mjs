import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { load } = createRequire(require.resolve('eslint/package.json'))('js-yaml');
const file = '.github/workflows/production-d1-t21rc-row-reconciliation.yml';
const text = readFileSync(file, 'utf8');
const workflow = load(text);
const steps = workflow.jobs.capture.steps;
const find = (command) => steps.find((step) => step.run === command);

describe('T21R-C2 production workflow static safety contract', () => {
  it('is dedicated, manual-only, minimally permissioned, and shares the production lock', () => {
    expect(workflow.name).toBe('Production D1 T21R-C Row Reconciliation');
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(workflow.concurrency).toEqual({ group: 'frigo-deploy-production', 'cancel-in-progress': false });
    expect(Object.keys(workflow.jobs)).toEqual(['gate', 'capture']);
  });

  it('exposes only immutable source/review inputs and confirmation defaulting false', () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs)).toEqual(['ref', 'reviewed_sha', 'confirm_t21rc_read_only_capture']);
    expect(inputs.ref).toMatchObject({ type: 'string', required: true });
    expect(inputs.reviewed_sha).toMatchObject({ type: 'string', required: true });
    expect(inputs.confirm_t21rc_read_only_capture).toMatchObject({ type: 'boolean', required: true, default: false });
    expect(text).not.toMatch(/inputs\.(sql|table|where|file|query)/i);
    expect(workflow.jobs.gate.if).toBe("github.ref == 'refs/heads/main' && inputs.confirm_t21rc_read_only_capture == true");
  });

  it('keeps production secrets out of the gate and uses the exact output SHA checkout', () => {
    expect(JSON.stringify(workflow.jobs.gate)).not.toContain('secrets.');
    expect(workflow.jobs.gate.steps[0].with).toEqual({ ref: 'main', 'fetch-depth': 0, 'persist-credentials': false });
    expect(workflow.jobs.gate.steps.at(-1).run).toBe('node scripts/t21rc2-production-approval.mjs gate');
    expect(workflow.jobs.capture.needs).toBe('gate');
    expect(workflow.jobs.capture.environment).toBe('production');
    expect(steps[0].with).toEqual({ ref: '${{ needs.gate.outputs.candidate_sha }}', 'fetch-depth': 0, 'persist-credentials': false });
  });

  it('requires normal approval before the sole credential-bearing fixed-read command', () => {
    const approval = find('node scripts/t21rc2-production-approval.mjs approve');
    const capture = find('node scripts/t21rc2-production-capture.mjs capture');
    expect(steps.indexOf(approval)).toBeLessThan(steps.indexOf(capture));
    expect(approval.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(capture.env).toEqual({ GH_TOKEN: '${{ github.token }}', CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}', CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}', WRANGLER_SEND_METRICS: 'false' });
    expect(steps.filter((step) => JSON.stringify(step.env ?? {}).includes('CLOUDFLARE_API_TOKEN'))).toEqual([capture]);
    expect(workflow.jobs.capture.env).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
  });

  it('classifies without credentials and rechecks main/approval before publication', () => {
    const classify = find('node scripts/t21rc2-production-capture.mjs classify');
    const recheck = find('node scripts/t21rc2-production-approval.mjs recheck');
    const receipt = find('node scripts/t21rc2-production-receipt.mjs publish');
    expect(classify.env).toBeUndefined();
    expect(receipt.env).toBeUndefined();
    expect(recheck.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(steps.indexOf(classify)).toBeLessThan(steps.indexOf(recheck));
    expect(steps.indexOf(recheck)).toBeLessThan(steps.indexOf(receipt));
  });

  it('uploads one success-only aggregate file, never a wildcard or private manifest on failure', () => {
    const uploads = Object.values(workflow.jobs).flatMap((job) => job.steps.filter((step) => step.uses?.startsWith('actions/upload-artifact')));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ if: 'success()', with: { path: '${{ runner.temp }}/t21rc2-public-receipt.json', 'if-no-files-found': 'error' } });
    expect(uploads[0].with.path).not.toMatch(/[\n*]/);
    expect(text).not.toMatch(/row-manifest\.json|capture-[ab]\.json|upload-artifact[\s\S]*path:\s*\./);
    expect(steps.at(-1)).toMatchObject({ if: 'always()', run: 'node scripts/t21rc2-production-capture.mjs cleanup' });
  });

  it('has no inline SQL, mutation command, dispatch, debug dump, raw cat/tee or delivery implementation', () => {
    const commands = Object.values(workflow.jobs).flatMap((job) => job.steps.filter((step) => step.run).map((step) => step.run));
    expect(commands).toEqual([
      'node scripts/t21rc2-production-approval.mjs gate', 'pnpm install --frozen-lockfile',
      'node scripts/t21rc2-production-approval.mjs approve', 'node scripts/t21rc2-production-capture.mjs capture',
      'node scripts/t21rc2-production-capture.mjs classify', 'node scripts/t21rc2-production-approval.mjs recheck',
      'node scripts/t21rc2-production-receipt.mjs publish', 'node scripts/t21rc2-production-capture.mjs cleanup',
    ]);
    expect(commands.join('\n')).not.toMatch(/wrangler|migrations apply|deploy|restore|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|\bcat\b|\btee\b|workflow run|curl|webhook|s3|r2/i);
  });
});
