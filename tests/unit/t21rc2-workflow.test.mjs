import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { load } = createRequire(require.resolve('eslint/package.json'))('js-yaml');
const file = '.github/workflows/production-d1-t21rc-row-reconciliation.yml';
const text = readFileSync(file, 'utf8');
const workflow = load(text);
const ciFile = '.github/workflows/ci.yml';
const ciText = readFileSync(ciFile, 'utf8');
const ci = load(ciText);
const steps = workflow.jobs.capture.steps;
const find = (command) => steps.find((step) => step.run === command);

function requireImmutableExternalActions(document) {
  const refs = [];
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (Object.hasOwn(node, 'uses')) {
      if (typeof node.uses !== 'string') throw new Error('T21RC3_MUTABLE_ACTION_REF');
      if (!node.uses.startsWith('./')) {
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/.test(node.uses)) {
          throw new Error('T21RC3_MUTABLE_ACTION_REF');
        }
        refs.push(node.uses);
      }
    }
    Object.values(node).forEach(visit);
  };
  visit(document);
  return refs;
}

describe('T21R-C3 immutable production Action dependencies', () => {
  it('pins every external uses entry in every job to a full lowercase commit SHA', () => {
    const refs = requireImmutableExternalActions(workflow);
    expect(refs).toHaveLength(6);
    expect(new Set(refs)).toEqual(new Set([
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      'pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1',
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    ]));
  });

  it.each(['v4', 'v4.4.0', 'main', 'master', 'latest', 'feature/readiness', 'abc123', 'a'.repeat(39), 'A'.repeat(40)])(
    'rejects a production workflow mutated to @%s', (ref) => {
      const mutated = load(text.replace(/actions\/checkout@[a-f0-9]{40}/, `actions/checkout@${ref}`));
      expect(() => requireImmutableExternalActions(mutated)).toThrow('T21RC3_MUTABLE_ACTION_REF');
    },
  );

  it('also rejects a mutable action appended after all six immutable actions', () => {
    const mutated = structuredClone(workflow);
    mutated.jobs.capture.steps.push({ uses: 'other/action@main' });
    expect(() => requireImmutableExternalActions(mutated)).toThrow('T21RC3_MUTABLE_ACTION_REF');
  });

  it('checks job-level uses and treats local composite paths separately', () => {
    const mutated = structuredClone(workflow);
    mutated.jobs.additional = { uses: 'other/workflow@main' };
    expect(() => requireImmutableExternalActions(mutated)).toThrow('T21RC3_MUTABLE_ACTION_REF');
    expect(requireImmutableExternalActions({ jobs: { local: { steps: [{ uses: './.github/actions/local' }] } } })).toEqual([]);
  });

  it('changes only Action identity in the certified production workflow', () => {
    const before = load(execFileSync('git', [
      'show', `0d4fe89b7ccc72e013aafe53665059d0e62bd3b4:${file}`,
    ], { encoding: 'utf8' }));
    const after = structuredClone(workflow);
    for (const job of Object.values(after.jobs)) {
      for (const step of job.steps) {
        if (step.uses) step.uses = step.uses.replace(/@[a-f0-9]{40}$/, '@v4');
      }
    }
    expect(after).toEqual(before);
  });
});

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

describe('hosted CI Git history for T21R-C2 validation', () => {
  it('checks out full history so historical reviewed SHAs remain Git objects', () => {
    // T21R-C2 validation depends on exact historical Git objects and must run with full history.
    const checkouts = Object.values(ci.jobs).flatMap((job) => (
      job.steps.filter((step) => String(step.uses ?? '').startsWith('actions/checkout@'))
    ));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0].uses).toBe('actions/checkout@v4');
    expect(checkouts[0].with).toEqual({ 'fetch-depth': 0 });
    expect(ciText).not.toMatch(/fetch-depth:\s*[1-9]/);
  });
});
