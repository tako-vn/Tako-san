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
  // The required shared lock contains "deploy" as an identifier, never a command.
  const lock = workflow.concurrency?.group;
  expect(lock).toBe('frigo-deploy-production');
  const commandsOnly = structuredClone(workflow);
  commandsOnly.concurrency.group = 'shared-production-lock';
  if (denied.test(JSON.stringify(commandsOnly)) || denied.test(script)) throw new Error('T21RC4I_STATIC_FORBIDDEN');
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  expect(Object.keys(workflow.jobs)).toEqual(['diagnostic']);
  const job = workflow.jobs.diagnostic;
  expect(job.environment).toBe('production');
  expect(job['runs-on']).toBe('ubuntu-latest');
  expect(job.if).toBe("github.ref == 'refs/heads/main' && github.run_attempt == 1 && inputs.confirm_metadata_identity_diagnostic == true");
  expect(job.env).toBeUndefined(); expect(job.permissions).toBeUndefined();
  expect(job.steps).toHaveLength(5);
  expect(job.steps.filter((step) => step.uses).map((step) => step.uses)).toEqual(pins);
  expect(job.steps.filter((step) => step.run).map((step) => step.run)).toEqual([
    'pnpm install --frozen-lockfile', 'node scripts/t21rc4-cloudflare-identity-diagnostic.mjs',
  ]);
  expect(job.steps[0].with).toEqual({ ref: '${{ github.sha }}', 'fetch-depth': 0, 'persist-credentials': false });
  expect(job.steps[1].with['node-version']).toBe(24);
  expect(job.steps[2].with.version).toBe(10);
  for (const step of job.steps.slice(0, -1)) expect(step.env).toBeUndefined();
  expect(job.steps.at(-1).env).toEqual({
    CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
    CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
  });
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
  it('is manual, main-only, first-attempt, protected, immutable and metadata-only without artifacts', () => {
    assertDiagnosticStaticSafety(workflowText, scriptText);
    const input = load(workflowText).on.workflow_dispatch.inputs.confirm_metadata_identity_diagnostic;
    expect(input).toMatchObject({ type: 'boolean', required: true, default: false });
  });
  it('freezes exactly the two permitted Wrangler argv arrays', () => {
    expect(T21RC4I_COMMANDS).toEqual({ whoami: ['wrangler', 'whoami'],
      list: ['wrangler', 'd1', 'list', '--json', '--config', 'wrangler.jsonc'] });
    expect(Object.isFrozen(T21RC4I_COMMANDS)).toBe(true);
    for (const args of Object.values(T21RC4I_COMMANDS)) expect(Object.isFrozen(args)).toBe(true);
  });
  it.each(['d1 execute', '--command', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE',
    'ALTER', 'DROP', 'PRAGMA', 'migration', 'deploy', 'restore'])(
    'rejects forbidden token %s in the script and workflow', (token) => {
      expect(() => assertDiagnosticStaticSafety(workflowText, scriptText + `\n// ${token}\n`)).toThrow('T21RC4I_STATIC_FORBIDDEN');
      expect(() => assertDiagnosticStaticSafety(workflowText + `\nextra: ${token}\n`, scriptText)).toThrow('T21RC4I_STATIC_FORBIDDEN');
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
  it('rejects any permission expansion, bypass of the Environment or cancellation', () => {
    for (const changed of [workflowText.replace('contents: read', 'contents: write'),
      workflowText.replace('contents: read', 'contents: read\n  actions: write'),
      workflowText.replace('environment: production', 'environment: staging'),
      workflowText.replace('cancel-in-progress: false', 'cancel-in-progress: true')]) {
      expect(() => assertDiagnosticStaticSafety(changed, scriptText)).toThrow();
    }
  });
  it('rejects an added command, artifact step or helper import', () => {
    for (const changed of [workflowText + '\n      - run: echo raw-metadata\n',
      workflowText + '\n      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n']) {
      expect(() => assertDiagnosticStaticSafety(changed, scriptText)).toThrow();
    }
    expect(() => assertDiagnosticStaticSafety(workflowText, scriptText + "\nimport './other-helper.mjs';\n")).toThrow();
  });
});
