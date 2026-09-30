import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';
const DB_ID = 'f975ec39-b2c8-4a2a-80e1-0366054599d3';
const DB_NAME = 'frigo-db';
const WINDOW_START = '2026-09-25T20:00:00Z';
const WINDOW_END = '2026-09-29T14:00:00Z';
const CHECKPOINTS = [
  '2026-09-25T20:14:41Z', '2026-09-26T00:00:00Z',
  '2026-09-26T06:00:00Z', '2026-09-26T12:00:00Z',
  '2026-09-26T13:00:00Z', '2026-09-26T13:05:00Z',
  '2026-09-26T13:10:00Z', '2026-09-26T18:00:00Z',
  '2026-09-27T00:00:00Z', '2026-09-28T00:00:00Z',
  '2026-09-29T13:07:52Z',
];

export function assertAllowedCloudflareRequest(value, method = 'GET') {
  const url = new URL(value);
  if (method !== 'GET' || url.origin !== 'https://api.cloudflare.com') {
    throw new Error('Metadata-only GET required');
  }
  const decodedTarget = decodeURIComponent(url.pathname + url.search);
  if (/\/(?:query|raw|export|import|restore)(?:\/|[?&=]|$)/i.test(decodedTarget)) {
    throw new Error('Forbidden D1 endpoint');
  }
  const account = '[a-f0-9]{32}';
  const db = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  const allowed = new RegExp(`^/client/v4/accounts/${account}/(?:d1/database/${db}(?:/time_travel/bookmark)?|audit_logs)$`, 'i');
  if (!allowed.test(url.pathname) || url.searchParams.has('export')) {
    throw new Error('Endpoint outside metadata allowlist');
  }
  return url;
}

function apiClient(accountId, token, fetchImpl) {
  if (!/^[a-f0-9]{32}$/i.test(accountId || '') || !token) {
    throw new Error('Protected Cloudflare credentials required');
  }
  return async (path, params = {}) => {
    const url = new URL(`${API}/accounts/${accountId}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    assertAllowedCloudflareRequest(url, 'GET');
    const response = await fetchImpl(url, {
      method: 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!response.ok) return { ok: false, status: response.status };
    const body = await response.json();
    return body?.success === true
      ? { ok: true, result: body.result, resultInfo: body.result_info ?? null }
      : { ok: false, status: response.status };
  };
}

export function sanitizeAuditEvent(event) {
  return {
    timestamp: event?.when ?? null,
    actionInfo: typeof event?.action?.info === 'string' ? event.action.info : null,
    actionType: typeof event?.action?.type === 'string' ? event.action.type : null,
    result: event?.action?.result ?? null,
    interface: event?.interface ?? null,
    actorType: event?.actor?.type ?? null,
    resourceType: event?.resource?.type ?? null,
    resourceId: event?.resource?.id ?? null,
  };
}

function summarizeBookmarks(samples) {
  const ordered = [...samples].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const changes = [];
  for (let i = 1; i < ordered.length; i++) {
    const before = ordered[i - 1];
    const after = ordered[i];
    if (before.bookmarkDigest !== null && after.bookmarkDigest !== null) {
      changes.push({ timestampA: before.timestamp, timestampB: after.timestamp,
        state: before.bookmarkDigest === after.bookmarkDigest ? 'NO_STATE_ADVANCE_OBSERVED' : 'STATE_ADVANCE_OBSERVED' });
    }
  }
  const at = (timestamp) => ordered.find((sample) => sample.timestamp === timestamp)?.bookmarkDigest ?? null;
  const beforeDigest = at('2026-09-26T13:00:00Z');
  const atDigest = at('2026-09-26T13:05:00Z');
  const afterDigest = at('2026-09-26T13:10:00Z');
  const minuteChanges = changes.filter((item) => item.timestampA >= '2026-09-26T13:00:00Z'
    && item.timestampB <= '2026-09-26T13:10:00Z'
    && item.state === 'STATE_ADVANCE_OBSERVED').length;
  return {
    supported: ordered.some((sample) => sample.bookmarkDigest !== null),
    samples: ordered,
    sampleCount: ordered.length,
    distinctBookmarks: new Set(ordered.map((sample) => sample.bookmarkDigest).filter(Boolean)).size,
    transitionCount: changes.filter((item) => item.state === 'STATE_ADVANCE_OBSERVED').length,
    intervals: changes,
    signalNoisy: minuteChanges >= 8,
    candidateWindow: { beforeDigest, atDigest, afterDigest,
      stateAdvance: beforeDigest === null || atDigest === null || afterDigest === null
        ? null : beforeDigest !== atDigest || atDigest !== afterDigest,
      precision: ordered.some((sample) => sample.timestamp === '2026-09-26T13:01:00Z') ? 'MINUTE' : 'FIVE_MINUTES' },
  };
}

export async function collectTemporalEvidence({ accountId, token, fetchImpl = fetch }) {
  const get = apiClient(accountId, token, fetchImpl);
  const metadata = await get(`d1/database/${DB_ID}`);
  if (!metadata.ok) throw new Error(`Database metadata unavailable: HTTP ${metadata.status}`);
  const db = metadata.result;
  if (db?.uuid !== DB_ID || db?.name !== DB_NAME) throw new Error('PRODUCTION_D1_IDENTITY_MISMATCH');

  const samples = [];
  const sample = async (timestamp) => {
    const response = await get(`d1/database/${DB_ID}/time_travel/bookmark`, { timestamp });
    const rawBookmark = response.ok && typeof response.result?.bookmark === 'string'
      ? response.result.bookmark : null;
    samples.push({ timestamp, bookmarkDigest: rawBookmark === null
      ? null : createHash('sha256').update(rawBookmark).digest('hex'),
      available: rawBookmark !== null,
      httpStatus: response.ok ? 200 : response.status });
  };
  for (const timestamp of CHECKPOINTS) await sample(timestamp);
  const initial = summarizeBookmarks(samples);
  if (initial.candidateWindow.stateAdvance === true) {
    for (let minute = 1; minute <= 9; minute++) {
      if (minute === 5) continue;
      await sample(`2026-09-26T13:${String(minute).padStart(2, '0')}:00Z`);
    }
  }

  const relevantEvents = [];
  let auditAvailable = true;
  let auditComplete = true;
  let auditHttpStatus = 200;
  let pagesRead = 0;
  let totalPages = null;
  for (let page = 1; page <= 50; page++) {
    const response = await get('audit_logs', {
      since: WINDOW_START, before: WINDOW_END, direction: 'asc', per_page: '1000', page: String(page),
    });
    if (!response.ok || !Array.isArray(response.result)) {
      auditAvailable = false;
      auditComplete = false;
      auditHttpStatus = response.status ?? null;
      break;
    }
    pagesRead++;
    for (const event of response.result) {
      if (event?.resource?.type === 'd1.database' && event?.resource?.id === DB_ID) {
        relevantEvents.push(sanitizeAuditEvent(event));
      }
    }
    const reportedTotalPages = response.resultInfo?.total_pages;
    if (!Number.isSafeInteger(reportedTotalPages) || reportedTotalPages < 0
      || (totalPages !== null && reportedTotalPages !== totalPages)
      || (reportedTotalPages === 0 && response.result.length > 0)) {
      auditComplete = false;
      break;
    }
    totalPages = reportedTotalPages;
    if (page >= Math.max(1, totalPages)) break;
    if (page === 50) auditComplete = false;
  }
  const operationIdentityComplete = auditAvailable && auditComplete && relevantEvents.every(
    (event) => typeof event.actionInfo === 'string' && event.actionInfo.trim().length > 0,
  );
  const operationCount = (name) => relevantEvents.filter((event) => event.actionInfo === name).length;
  return {
    schemaVersion: 1,
    readOnly: true,
    productionMutations: [],
    database: { name: db.name, id: db.uuid, version: db.version ?? null, createdAt: db.created_at ?? null },
    timeWindow: { lastKnownGood: CHECKPOINTS[0], firstKnownBad: '2026-09-29T13:07:52Z',
      historicalExternalWriteCandidate: '2026-09-26T13:05:00Z' },
    bookmarkForensics: summarizeBookmarks(samples),
    auditLogs: { available: auditAvailable, complete: auditComplete, operationIdentityComplete,
      httpStatus: auditHttpStatus, pagesRead, d1Events: relevantEvents.length,
      createDatabase: operationIdentityComplete ? operationCount('CreateDatabase') : null,
      deleteDatabase: operationIdentityComplete ? operationCount('DeleteDatabase') : null,
      timeTravelRestore: operationIdentityComplete ? operationCount('TimeTravel') : null,
      relevantEvents },
    interpretation: 'Bookmarks show database-wide state only; audit logs are not per-query SQL history.',
    writerProven: false,
    writerOutputProven: false,
    sourceArtifactProven: false,
    executionProven: false,
    ingestionPipelineProven: false,
    rootCauseStatus: 'UNRESOLVED',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  collectTemporalEvidence({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
  }).then((receipt) => {
    writeFileSync(process.argv[2] ?? 'd1-temporal-forensics.json', `${JSON.stringify(receipt, null, 2)}\n`);
    console.log('D1 metadata-only temporal receipt written');
  }).catch((error) => {
    console.error(error.message === 'PRODUCTION_D1_IDENTITY_MISMATCH'
      ? error.message : 'D1 temporal forensics failed without writing a receipt');
    process.exitCode = 1;
  });
}
