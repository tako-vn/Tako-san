import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { T21RC4I_COMMANDS } from '../../scripts/t21rc4-cloudflare-identity-diagnostic.mjs';

const require = createRequire(import.meta.url);
const { load } = createRequire(require.resolve('eslint/package.json'))('js-yaml');
const workflowText = readFileSync('.github/workflows/production-d1-identity-diagnostic.yml', 'utf8');
const scriptText = readFileSync('scripts/t21rc4-cloudflare-identity-diagnostic.mjs', 'utf8');
const denied = /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|migrations?|deploy|restore)\b|\bd1\s+execute\b|--command/i;
const pins = [
  'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  'pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1',
];

function assertDiagnosticStaticSafety(text, script) {
  const workflow = load(text);
  expect(workflow.concurrency).toEqual({ group: 'frigo-deploy-production', 'cancel-in-progress': false });
  const commandsOnly = structuredClone(workflow);
  commandsOnly.concurrency.group = 'shared-production-lock';
  if (denied.test(JSON.stringify(commandsOnly)) || denied.test(script)) throw new Error('T21RC4I_STATIC_FORBIDDEN');
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  const inputs = workflow.on.workflow_dispatch.inputs;
  expect(Object.keys(inputs)).toEqual(['ref', 'reviewed_sha', 'confirm_metadata_identity_diagnostic']);
  expect(inputs.ref).toMatchObject({ type: 'string', required: true });
  expect(inputs.reviewed_sha).toMatchObject({ type: 'string', required: true });
  expect(inputs.confirm_metadata_identity_diagnostic).toMatchObject({ type: 'boolean', required: true, default: false });
  expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
  expect(Object.keys(workflow.jobs)).toEqual(['gate', 'diagnostic']);
  const gate = workflow.jobs.gate;
  const diagnostic = workflow.jobs.diagnostic;
  expect(gate.environment).toBeUndefined();
  expect(gate.env).toBeUndefined();
  expect(gate.steps).toHaveLength(3);
  expect(gate.steps.filter((step) => step.uses).map((step) => step.uses)).toEqual(pins.slice(0, 2));
  expect(gate.steps[0].with).toEqual({ ref: '${{ github.sha }}', 'fetch-depth': 0, 'persist-credentials': false });
  expect(gate.steps[2].run).toBe('node scripts/t21rc4-identity-gate.mjs gate');
  expect(gate.steps[2].env).toEqual({
    GH_TOKEN: '${{ github.token }}',
    C4I_REF: '${{ inputs.ref }}',
    C4I_REVIEWED_SHA: '${{ inputs.reviewed_sha }}',
    CONFIRM_METADATA_IDENTITY_DIAGNOSTIC: '${{ inputs.confirm_metadata_identity_diagnostic }}',
  });
  expect(gate.outputs).toEqual({
    main_sha: '${{ steps.gate.outputs.main_sha }}',
    reviewed_sha: '${{ steps.gate.outputs.reviewed_sha }}',
    ci_run_id: '${{ steps.gate.outputs.ci_run_id }}',
    ci_attempt: '${{ steps.gate.outputs.ci_attempt }}',
    repository_id: '${{ steps.gate.outputs.repository_id }}',
  });
  expect(diagnostic.needs).toBe('gate');
  expect(diagnostic.environment).toBe('production');
  expect(diagnostic.env).toBeUndefined();
  expect(diagnostic.steps).toHaveLength(7);
  expect(diagnostic.steps.filter((step) => step.uses).map((step) => step.uses)).toEqual(pins);
  expect(diagnostic.steps[0].with).toEqual({
    ref: '${{ needs.gate.outputs.main_sha }}', 'fetch-depth': 0, 'persist-credentials': false,
  });
  expect(diagnostic.steps[3].run).toBe('pnpm install --frozen-lockfile');
  expect(diagnostic.steps[4].run).toBe('node scripts/t21rc4-identity-gate.mjs bind');
  expect(diagnostic.steps[4].env).toMatchObject({
    C4I_REF: '${{ inputs.ref }}', C4I_REVIEWED_SHA: '${{ inputs.reviewed_sha }}',
    C4I_GATE_MAIN_SHA: '${{ needs.gate.outputs.main_sha }}',
    C4I_GATE_REVIEWED_SHA: '${{ needs.gate.outputs.reviewed_sha }}',
    C4I_GATE_CI_RUN_ID: '${{ needs.gate.outputs.ci_run_id }}',
    C4I_GATE_CI_ATTEMPT: '${{ needs.gate.outputs.ci_attempt }}',
    C4I_GATE_REPOSITORY_ID: '${{ needs.gate.outputs.repository_id }}',
  });
  expect(diagnostic.steps[5].run).toBe('node scripts/t21rc4-identity-approval.mjs');
  expect(diagnostic.steps[5].env).toEqual({
    GH_TOKEN: '${{ github.token }}',
    C4I_REF: '${{ inputs.ref }}',
    C4I_REVIEWED_SHA: '${{ inputs.reviewed_sha }}',
    C4I_GATE_MAIN_SHA: '${{ needs.gate.outputs.main_sha }}',
    C4I_GATE_REVIEWED_SHA: '${{ needs.gate.outputs.reviewed_sha }}',
  });
  expect(diagnostic.steps[6].run).toBe('node scripts/t21rc4-cloudflare-identity-diagnostic.mjs');
  expect(diagnostic.steps[6].env).toEqual({
    CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
    CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
  });
  for (const step of [...gate.steps.slice(0, 2), ...diagnostic.steps.slice(0, 4)]) expect(step.env).toBeUndefined();
  const source = ts.createSourceFile('diagnostic.mjs', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imports = []; const calls = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(source);
      if (expression === 'execute') calls.push(node.arguments.map((arg) => arg.getText(source)));
      if (expression === 'execFileSync' || expression === 'import' || /\b(?:fetch|spawn|exec|eval)\b/.test(expression)) {
        throw new Error('T21RC4I_STATIC_FORBIDDEN');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(imports).toEqual(['node:child_process', 'node:fs', 'node:os', 'node:path', 'node:url', 'typescript']);
  expect(calls).toEqual([
    ["'pnpm'", '[...T21RC4I_COMMANDS.whoami]', 'options'],
    ["'pnpm'", '[...T21RC4I_COMMANDS.list]', 'options'],
  ]);
}

describe('C4I diagnostic workflow safety', () => {
  it('requires credential-free gate, independent approval, exact checkout, and metadata-only commands', () => {
    assertDiagnosticStaticSafety(workflowText, scriptText);
  });
  it('freezes exactly the two permitted Wrangler argv arrays', () => {
    expect(T21RC4I_COMMANDS).toEqual({ whoami: ['wrangler', 'whoami'],
      list: ['wrangler', 'd1', 'list', '--json', '--config', 'wrangler.jsonc'] });
    expect(Object.isFrozen(T21RC4I_COMMANDS)).toBe(true);
    for (const args of Object.values(T21RC4I_COMMANDS)) expect(Object.isFrozen(args)).toBe(true);
  });
  it.each(['d1 execute', '--command', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE',
    'ALTER', 'DROP', 'PRAGMA', 'migration', 'deploy', 'restore'])(
    'rejects forbidden token %s in script and workflow', (token) => {
      expect(() => assertDiagnosticStaticSafety(workflowText, scriptText + `\n// ${token}\n`)).toThrow();
      expect(() => assertDiagnosticStaticSafety(workflowText + `\nextra: ${token}\n`, scriptText)).toThrow();
    },
  );
  it.each(['push', 'pull_request', 'schedule', 'repository_dispatch'])(
    'rejects additional trigger %s', (trigger) => {
      expect(() => assertDiagnosticStaticSafety(workflowText.replace('on:\n', `on:\n  ${trigger}: {}\n`), scriptText)).toThrow();
    },
  );
  it.each(['v4', 'main', 'latest', 'abc123', 'A'.repeat(40)])('rejects mutable or wrong pin %s', (ref) => {
    expect(() => assertDiagnosticStaticSafety(workflowText.replace(pins[0], `actions/checkout@${ref}`), scriptText)).toThrow();
  });
  it('rejects bypasses of gate, approval, permissions, Environment, and secret isolation', () => {
    for (const changed of [
      workflowText.replace('actions: read', 'actions: write'),
      workflowText.replace('environment: production', 'environment: staging'),
      workflowText.replace('needs: gate', 'needs: []'),
      workflowText.replace('jobs:\n  gate:', 'jobs:\n  removed_gate:'),
      workflowText.replace('node scripts/t21rc4-identity-approval.mjs', 'echo skipped'),
      workflowText.replace('node scripts/t21rc4-identity-gate.mjs gate', 'echo skipped'),
      workflowText.replace('node scripts/t21rc4-identity-gate.mjs bind', 'echo skipped'),
      workflowText.replace('C4I_REVIEWED_SHA: ${{ inputs.reviewed_sha }}', 'C4I_REVIEWED_SHA: ${{ github.sha }}'),
      workflowText.replace('GH_TOKEN: ${{ github.token }}', 'CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}'),
      workflowText.replace('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}', 'GH_TOKEN: ${{ github.token }}'),
      workflowText.replace('cancel-in-progress: false', 'cancel-in-progress: true'),
    ]) expect(() => assertDiagnosticStaticSafety(changed, scriptText)).toThrow();
  });
});
