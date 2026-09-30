import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';
const DB_ID = 'f975ec39-b2c8-4a2a-80e1-0366054599d3';
const DB_NAME = 'frigo-db';
const WINDOW_START = '2026-09-25T20:00:00Z';
const WINDOW_END = '2026-09-29T14:00:00Z';
const AUDIT_PER_PAGE = 1000;
const MAX_AUDIT_PAGES = 50;
const MAX_REFINEMENT_BOOKMARK_REQUESTS = 96;
const MINIMUM_RESOLUTION_SECONDS = 60;
const REFINEMENT_WINDOWS = [
  ['2026-09-26T12:00:00Z', '2026-09-26T13:00:00Z'],
  ['2026-09-26T13:10:00Z', '2026-09-26T18:00:00Z'],
];
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

export function normalizeV1Pagination(resultInfo, resultLength, requestedPage, requestedPerPage) {
  const invalid = { valid: false };
  if (!resultInfo || typeof resultInfo !== 'object' || Array.isArray(resultInfo)
    || !Number.isSafeInteger(resultLength) || resultLength < 0
    || !Number.isSafeInteger(requestedPage) || requestedPage < 1
    || !Number.isSafeInteger(requestedPerPage) || requestedPerPage < 1) return invalid;

  const { page, per_page: perPage, count, total_count: totalCount, total_pages: reportedTotalPages } = resultInfo;
  if (!Number.isSafeInteger(page) || page !== requestedPage
    || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > requestedPerPage
    || resultLength > perPage
    || (count !== undefined && (!Number.isSafeInteger(count) || count < 0
      || count > perPage || count !== resultLength))
    || (totalCount !== undefined && (!Number.isSafeInteger(totalCount) || totalCount < 0))
    || (reportedTotalPages !== undefined
      && (!Number.isSafeInteger(reportedTotalPages) || reportedTotalPages < 0))) return invalid;

  return { valid: true, page, perPage, count: resultLength,
    totalCount: totalCount ?? null, totalPages: reportedTotalPages ?? null };
}

export async function refineTransitionIntervals({ leftTimestamp, leftDigest, rightTimestamp, rightDigest,
  sample, minimumResolutionSeconds, requestBudget }) {
  if (!Number.isSafeInteger(minimumResolutionSeconds) || minimumResolutionSeconds < 1
    || !Number.isSafeInteger(requestBudget) || requestBudget < 0) {
    throw new Error('Invalid refinement limits');
  }
  const start = Date.parse(leftTimestamp);
  const end = Date.parse(rightTimestamp);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error('Invalid refinement interval');
  }
  const transitionIntervals = [];
  const unresolvedIntervals = [];
  const pending = [{ start: leftTimestamp, end: rightTimestamp,
    leftDigest, rightDigest, startMs: start, endMs: end }];
  let requestCount = 0;
  let complete = true;
  let budgetExhausted = false;

  while (pending.length > 0) {
    const interval = pending.pop();
    const { startMs, endMs } = interval;
    const durationSeconds = (endMs - startMs) / 1000;
    const record = { start: interval.start, end: interval.end, durationSeconds,
      leftDigest: interval.leftDigest, rightDigest: interval.rightDigest };
    if (typeof interval.leftDigest !== 'string' || typeof interval.rightDigest !== 'string') {
      complete = false;
      unresolvedIntervals.push({ ...record, state: 'UNKNOWN' });
      continue;
    }
    if (interval.leftDigest === interval.rightDigest) continue;
    if (durationSeconds <= minimumResolutionSeconds) {
      transitionIntervals.push({ ...record, state: 'STATE_ADVANCE_OBSERVED' });
      continue;
    }
    if (requestCount >= requestBudget) {
      complete = false;
      budgetExhausted = true;
      transitionIntervals.push({ ...record, state: 'STATE_ADVANCE_OBSERVED' });
      continue;
    }

    let midpointMs = Math.floor((startMs + endMs) / 120000) * 60000;
    if (midpointMs <= startMs || midpointMs >= endMs) midpointMs = Math.floor((startMs + endMs) / 2);
    const midpoint = new Date(midpointMs).toISOString().replace('.000Z', 'Z');
    requestCount++;
    let sampled;
    try {
      sampled = await sample(midpoint);
    } catch {
      sampled = null;
    }
    if (sampled?.available !== true || typeof sampled.bookmarkDigest !== 'string') {
      complete = false;
      transitionIntervals.push({ ...record, state: 'STATE_ADVANCE_OBSERVED' });
      unresolvedIntervals.push({ ...record, state: 'UNKNOWN' });
      continue;
    }
    pending.push({ start: midpoint, end: interval.end, startMs: midpointMs, endMs,
      leftDigest: sampled.bookmarkDigest, rightDigest: interval.rightDigest });
    pending.push({ start: interval.start, end: midpoint, startMs, endMs: midpointMs,
      leftDigest: interval.leftDigest, rightDigest: sampled.bookmarkDigest });
  }

  transitionIntervals.sort((a, b) => a.start.localeCompare(b.start));
  unresolvedIntervals.sort((a, b) => a.start.localeCompare(b.start));
  return { complete, budgetExhausted, requestCount, transitionIntervals, unresolvedIntervals };
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
    const sampled = { timestamp, bookmarkDigest: rawBookmark === null
      ? null : createHash('sha256').update(rawBookmark).digest('hex'),
      available: rawBookmark !== null,
      httpStatus: response.ok ? 200 : response.status };
    samples.push(sampled);
    return sampled;
  };
  for (const timestamp of CHECKPOINTS) await sample(timestamp);
  const initial = summarizeBookmarks(samples);
  const historicalCandidateStateAdvance = initial.candidateWindow.beforeDigest === null
    || initial.candidateWindow.atDigest === null ? null
      : initial.candidateWindow.beforeDigest !== initial.candidateWindow.atDigest;
  // A refined digest transition locates database-wide state change, not a specific writer.
  const refinementWindows = [];
  let refinementRequestCount = 0;
  for (const [initialStart, initialEnd] of REFINEMENT_WINDOWS) {
    const leftDigest = samples.find((entry) => entry.timestamp === initialStart)?.bookmarkDigest ?? null;
    const rightDigest = samples.find((entry) => entry.timestamp === initialEnd)?.bookmarkDigest ?? null;
    const refined = await refineTransitionIntervals({
      leftTimestamp: initialStart, leftDigest, rightTimestamp: initialEnd, rightDigest,
      sample, minimumResolutionSeconds: MINIMUM_RESOLUTION_SECONDS,
      requestBudget: MAX_REFINEMENT_BOOKMARK_REQUESTS - refinementRequestCount,
    });
    refinementRequestCount += refined.requestCount;
    refinementWindows.push({ initialStart, initialEnd, ...refined });
  }
  const refinement = { attempted: true, complete: refinementWindows.every((window) => window.complete),
    budgetExhausted: refinementWindows.some((window) => window.budgetExhausted),
    requestCount: refinementRequestCount, requestBudget: MAX_REFINEMENT_BOOKMARK_REQUESTS,
    minimumResolutionSeconds: MINIMUM_RESOLUTION_SECONDS, windows: refinementWindows };

  const relevantEvents = [];
  let auditAvailable = true;
  let auditComplete = false;
  let auditHttpStatus = 200;
  let pagesRead = 0;
  let eventsRead = 0;
  let terminalEmptyPageObserved = false;
  let observedPerPage = null;
  let observedTotalCount = null;
  let observedTotalPages = null;
  for (let page = 1; page <= MAX_AUDIT_PAGES; page++) {
    const response = await get('audit_logs', {
      since: WINDOW_START, before: WINDOW_END, direction: 'asc', per_page: String(AUDIT_PER_PAGE), page: String(page),
    });
    if (!response.ok || !Array.isArray(response.result)) {
      auditAvailable = pagesRead > 0;
      auditHttpStatus = response.ok ? 200 : response.status ?? null;
      break;
    }
    pagesRead++;
    const current = normalizeV1Pagination(response.resultInfo, response.result.length, page, AUDIT_PER_PAGE);
    if (!current.valid
      || (observedPerPage !== null && current.perPage !== observedPerPage)
      || (current.totalCount !== null && observedTotalCount !== null
        && current.totalCount !== observedTotalCount)
      || (current.totalPages !== null && observedTotalPages !== null
        && current.totalPages !== observedTotalPages)) {
      break;
    }
    observedPerPage = current.perPage;
    if (current.totalCount !== null) observedTotalCount = current.totalCount;
    if (current.totalPages !== null) observedTotalPages = current.totalPages;
    eventsRead += current.count;
    if ((observedTotalCount !== null && eventsRead > observedTotalCount)
      || (current.count > 0 && observedTotalPages !== null && page > observedTotalPages)) break;
    for (const event of response.result) {
      if (event?.resource?.type === 'd1.database' && event?.resource?.id === DB_ID) {
        relevantEvents.push(sanitizeAuditEvent(event));
      }
    }
    if (current.count === 0) {
      terminalEmptyPageObserved = true;
      auditComplete = (observedTotalCount === null || eventsRead === observedTotalCount)
        && (observedTotalPages === null || page === observedTotalPages + 1);
      break;
    }
  }
  const operationIdentityComplete = auditAvailable && auditComplete && relevantEvents.every(
    (event) => typeof event.actionInfo === 'string' && event.actionInfo.trim().length > 0,
  );
  const operationCount = (name) => relevantEvents.filter((event) => event.actionInfo === name).length;
  return {
    schemaVersion: 2,
    readOnly: true,
    productionMutations: [],
    database: { name: db.name, id: db.uuid, version: db.version ?? null, createdAt: db.created_at ?? null },
    timeWindow: { lastKnownGood: CHECKPOINTS[0], firstKnownBad: '2026-09-29T13:07:52Z',
      historicalExternalWriteCandidate: '2026-09-26T13:05:00Z',
      historicalCandidateStateAdvance,
      historicalTimestampSupported: historicalCandidateStateAdvance },
    bookmarkForensics: summarizeBookmarks(samples),
    refinement,
    auditLogs: { available: auditAvailable, complete: auditComplete, operationIdentityComplete,
      httpStatus: auditHttpStatus, pagesRead, d1Events: relevantEvents.length,
      pagination: { mode: 'v1-terminal-empty-page', perPage: observedPerPage,
        pagesRead, terminalEmptyPageObserved, totalCount: observedTotalCount,
        totalPages: observedTotalPages },
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
