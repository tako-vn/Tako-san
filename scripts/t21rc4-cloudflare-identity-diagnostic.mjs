#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const DATABASE_NAME = 'frigo-db';
const DATABASE_UUID = 'f975ec39-b2c8-4a2a-80e1-0366054599d3';
export const T21RC4I_COMMANDS = Object.freeze({
  whoami: Object.freeze(['wrangler', 'whoami']),
  list: Object.freeze(['wrangler', 'd1', 'list', '--json', '--config', 'wrangler.jsonc']),
});
export const T21RC4I_STATUSES = Object.freeze([
  'T21RC4I_TOKEN_MISSING',
  'T21RC4I_ACCOUNT_ID_SECRET_INVALID_FORMAT',
  'T21RC4I_WRANGLER_CONFIG_MISMATCH',
  'T21RC4I_WHOAMI_COMMAND_FAILED',
  'T21RC4I_ACCOUNT_ID_SECRET_MISMATCH',
  'T21RC4I_D1_LIST_COMMAND_FAILED',
  'T21RC4I_D1_LIST_RESPONSE_INVALID',
  'T21RC4I_PRODUCTION_D1_NAME_MISSING',
  'T21RC4I_PRODUCTION_D1_NAME_DUPLICATE',
  'T21RC4I_PRODUCTION_D1_UUID_MISMATCH',
  'T21RC4I_CLOUDFLARE_IDENTITY_CERTIFIED',
  'T21RC4I_DIAGNOSTIC_INTERNAL_FAILURE',
  'T21RC4I_INPUT_REJECTED',
]);

// Same strict JSONC identity contract, isolated from the capture helpers.
export function verifyT21RC4IdentityConfig(text) {
  const source = ts.parseJsonText('wrangler.jsonc', text);
  if (source.parseDiagnostics.length) throw new Error('T21RC4I_WRANGLER_CONFIG_MISMATCH');
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const seen = new Set();
      for (const property of node.properties) {
        const name = property.name?.text ?? property.name?.getText(source);
        if (seen.has(name)) throw new Error('T21RC4I_WRANGLER_CONFIG_MISMATCH');
        seen.add(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', text);
  const bindings = parsed.config?.d1_databases;
  if (parsed.error || !Array.isArray(bindings) || bindings.length !== 1
      || bindings[0]?.binding !== 'DB' || bindings[0]?.database_name !== DATABASE_NAME
      || bindings[0]?.database_id !== DATABASE_UUID) {
    throw new Error('T21RC4I_WRANGLER_CONFIG_MISMATCH');
  }
}

function emptyReceipt() {
  return {
    status: 'T21RC4I_DIAGNOSTIC_INTERNAL_FAILURE', tokenPresent: false,
    accountIdSecretFormat: 'NOT_RUN', wranglerConfigIdentity: 'NOT_RUN',
    wranglerWhoami: 'NOT_RUN', accountIdMatchesWhoami: null,
    d1List: 'NOT_RUN', frigoDbMatchCount: null, productionD1UuidMatch: null,
    d1SqlExecuted: false, productionMutations: 0,
    tokenScopeReadOnlyProven: false, tokenScope: 'UNKNOWN',
  };
}

export function runT21RC4IdentityDiagnostic({
  env = process.env, cwd = process.cwd(), execute = execFileSync,
} = {}) {
  const receipt = emptyReceipt();
  const stop = (status) => { receipt.status = status; return receipt; };
  receipt.tokenPresent = typeof env.CLOUDFLARE_API_TOKEN === 'string'
    && env.CLOUDFLARE_API_TOKEN.length > 0;
  if (!receipt.tokenPresent) return stop('T21RC4I_TOKEN_MISSING');
  receipt.accountIdSecretFormat = typeof env.CLOUDFLARE_ACCOUNT_ID === 'string'
    && /^[0-9a-f]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID)
    ? 'VALID' : 'INVALID';
  if (receipt.accountIdSecretFormat !== 'VALID') return stop('T21RC4I_ACCOUNT_ID_SECRET_INVALID_FORMAT');
  try {
    verifyT21RC4IdentityConfig(readFileSync(path.join(cwd, 'wrangler.jsonc'), 'utf8'));
    receipt.wranglerConfigIdentity = 'PASS';
  } catch {
    receipt.wranglerConfigIdentity = 'FAIL';
    return stop('T21RC4I_WRANGLER_CONFIG_MISMATCH');
  }

  let privateDir;
  try {
    privateDir = mkdtempSync(path.join(tmpdir(), 't21rc4i-'));
    const logSink = path.join(privateDir, 'wrangler.log');
    symlinkSync('/dev/null', logSink);
    // Do not inherit alternate credentials, endpoint overrides or GitHub tokens.
    const childEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP',
      'SystemRoot', 'ComSpec', 'PATHEXT'].filter((key) => typeof env[key] === 'string')
      .map((key) => [key, env[key]]));
    Object.assign(childEnv, {
      CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
      CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'error',
      WRANGLER_LOG_PATH: logSink,
    });
    const options = { cwd, env: childEnv, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, timeout: 60_000 };
    let whoami;
    try {
      whoami = execute('pnpm', [...T21RC4I_COMMANDS.whoami], options);
      if (typeof whoami !== 'string') throw new Error();
      receipt.wranglerWhoami = 'SUCCESS';
    } catch {
      receipt.wranglerWhoami = 'FAILURE';
      return stop('T21RC4I_WHOAMI_COMMAND_FAILED');
    }
    receipt.accountIdMatchesWhoami = (whoami.match(/\b[0-9a-f]{32}\b/gi) ?? [])
      .some((id) => id.toLowerCase() === env.CLOUDFLARE_ACCOUNT_ID.toLowerCase());
    if (!receipt.accountIdMatchesWhoami) return stop('T21RC4I_ACCOUNT_ID_SECRET_MISMATCH');
    let listOutput;
    try {
      listOutput = execute('pnpm', [...T21RC4I_COMMANDS.list], options);
    } catch {
      receipt.d1List = 'FAILURE';
      return stop('T21RC4I_D1_LIST_COMMAND_FAILED');
    }
    let list;
    try {
      if (typeof listOutput !== 'string') throw new Error();
      list = JSON.parse(listOutput);
      if (!Array.isArray(list) || list.some((item) => !item || typeof item !== 'object'
          || Array.isArray(item) || typeof item.name !== 'string'
          || typeof item.uuid !== 'string')) throw new Error();
    } catch {
      receipt.d1List = 'FAILURE';
      return stop('T21RC4I_D1_LIST_RESPONSE_INVALID');
    }
    receipt.d1List = 'SUCCESS';
    const matches = list.filter((item) => item.name === DATABASE_NAME);
    receipt.frigoDbMatchCount = matches.length > 1 ? 'MULTIPLE' : matches.length;
    if (!matches.length) return stop('T21RC4I_PRODUCTION_D1_NAME_MISSING');
    if (matches.length > 1) return stop('T21RC4I_PRODUCTION_D1_NAME_DUPLICATE');
    receipt.productionD1UuidMatch = matches[0].uuid === DATABASE_UUID;
    if (!receipt.productionD1UuidMatch) return stop('T21RC4I_PRODUCTION_D1_UUID_MISMATCH');
    return stop('T21RC4I_CLOUDFLARE_IDENTITY_CERTIFIED');
  } catch {
    return stop('T21RC4I_DIAGNOSTIC_INTERNAL_FAILURE');
  } finally {
    if (privateDir) {
      try { rmSync(privateDir, { recursive: true, force: true }); }
      catch { receipt.status = 'T21RC4I_DIAGNOSTIC_INTERNAL_FAILURE'; }
    }
  }
}

// Reconstruct every field; caller-supplied extras and arbitrary strings are discarded.
export function formatT21RC4IdentityReceipt(value) {
  const source = value && typeof value === 'object' ? value : {};
  const enumValue = (key, allowed) => allowed.includes(source[key]) ? source[key] : 'NOT_RUN';
  const booleanOrNull = (key) => typeof source[key] === 'boolean' ? source[key] : null;
  return `${JSON.stringify({
    status: T21RC4I_STATUSES.includes(source.status) ? source.status : 'T21RC4I_DIAGNOSTIC_INTERNAL_FAILURE',
    tokenPresent: source.tokenPresent === true,
    accountIdSecretFormat: enumValue('accountIdSecretFormat', ['VALID', 'INVALID']),
    wranglerConfigIdentity: enumValue('wranglerConfigIdentity', ['PASS', 'FAIL']),
    wranglerWhoami: enumValue('wranglerWhoami', ['SUCCESS', 'FAILURE']),
    accountIdMatchesWhoami: booleanOrNull('accountIdMatchesWhoami'),
    d1List: enumValue('d1List', ['SUCCESS', 'FAILURE']),
    frigoDbMatchCount: [0, 1, 'MULTIPLE'].includes(source.frigoDbMatchCount) ? source.frigoDbMatchCount : null,
    productionD1UuidMatch: booleanOrNull('productionD1UuidMatch'),
    d1SqlExecuted: false, productionMutations: 0,
    tokenScopeReadOnlyProven: false, tokenScope: 'UNKNOWN',
  }, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let receipt;
  try {
    receipt = process.argv.length === 2 ? runT21RC4IdentityDiagnostic()
      : { status: 'T21RC4I_INPUT_REJECTED' };
  } catch {
    receipt = { status: 'T21RC4I_DIAGNOSTIC_INTERNAL_FAILURE' };
  }
  process.stdout.write(formatT21RC4IdentityReceipt(receipt));
  process.exitCode = receipt.status === 'T21RC4I_CLOUDFLARE_IDENTITY_CERTIFIED' ? 0 : 1;
}
