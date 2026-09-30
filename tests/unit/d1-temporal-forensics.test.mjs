import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { assertAllowedCloudflareRequest, collectTemporalEvidence, normalizeV1Pagination, refineTransitionIntervals, sanitizeAuditEvent } from '../../scripts/d1-temporal-forensics.mjs';

const account = 'a'.repeat(32);
const db = 'f975ec39-b2c8-4a2a-80e1-0366054599d3';
const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;

function mockResponse(result, resultInfo) {
  return { ok: true, status: 200, json: async () => ({
    success: true, result, ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
  }) };
}

function auditEvent(info, type, timestamp = '2026-09-26T13:05:00Z') {
  return {
    when: timestamp,
    action: { info, type, result: true },
    actor: { type: 'user', email: 'private@example.test', ip: '192.0.2.1' },
    resource: { type: 'd1.database', id: db },
    interface: 'API',
    metadata: { private: 'must-not-appear' },
    oldValue: 'private-old-value',
    newValue: 'private-new-value',
  };
}

function fixtureFetch({ events = [], auditPages = [events], auditResultInfo, auditFailureAt = () => null,
  bookmarkAt = () => 'stable', bookmarkErrorAt = () => false } = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push([url, options]);
    if (url.pathname.endsWith('/audit_logs')) {
      const page = Number(url.searchParams.get('page'));
      const failureStatus = auditFailureAt(page);
      if (failureStatus !== null) return { ok: false, status: failureStatus };
      const result = auditPages[page - 1] ?? [];
      const defaultInfo = { page, per_page: 1000 };
      const resultInfo = typeof auditResultInfo === 'function'
        ? auditResultInfo(page, result, defaultInfo) : auditResultInfo === undefined ? defaultInfo : auditResultInfo;
      return mockResponse(result, resultInfo ?? undefined);
    }
    if (url.pathname.endsWith('/time_travel/bookmark')) {
      const timestamp = url.searchParams.get('timestamp');
      if (bookmarkErrorAt(timestamp)) return { ok: false, status: 503 };
      return mockResponse({ bookmark: bookmarkAt(timestamp) });
    }
    return mockResponse({ uuid: db, name: 'frigo-db', version: 'production', created_at: '2026-01-01T00:00:00Z' });
  };
  return { fetchImpl, requests };
}

describe('D1 temporal metadata-only forensics', () => {
  it('allows only reviewed GET endpoints', () => {
    expect(() => assertAllowedCloudflareRequest(`${base}/d1/database/${db}`)).not.toThrow();
    expect(() => assertAllowedCloudflareRequest(`${base}/d1/database/${db}/time_travel/bookmark?timestamp=2026-09-26T13%3A05%3A00Z`)).not.toThrow();
    expect(() => assertAllowedCloudflareRequest(`${base}/audit_logs`)).not.toThrow();
    for (const suffix of ['/query', '/raw', '/export', '/import', '/time_travel/restore']) {
      expect(() => assertAllowedCloudflareRequest(`${base}/d1/database/${db}${suffix}`)).toThrow();
    }
    expect(() => assertAllowedCloudflareRequest(`${base}/audit_logs?export=true`)).toThrow();
    expect(() => assertAllowedCloudflareRequest(`${base}/audit_logs?probe=%2Fquery`)).toThrow();
    expect(() => assertAllowedCloudflareRequest(`${base}/logs/audit`)).toThrow();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(() => assertAllowedCloudflareRequest(`${base}/d1/database/${db}`, method)).toThrow();
    }
    expect(() => assertAllowedCloudflareRequest(`http://api.cloudflare.com/client/v4/accounts/${account}/audit_logs`)).toThrow();
    expect(() => assertAllowedCloudflareRequest(`https://evil.example/client/v4/accounts/${account}/audit_logs`)).toThrow();
  });

  it('fails closed on database identity mismatch before reading bookmarks', async () => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url.pathname);
      return mockResponse({ uuid: db, name: 'wrong-database' });
    };
    await expect(collectTemporalEvidence({ accountId: account, token: 'fixture', fetchImpl }))
      .rejects.toThrow('PRODUCTION_D1_IDENTITY_MISMATCH');
    expect(urls).toHaveLength(1);
  });

  it('counts real D1 operation names and emits only sanitized event fields', async () => {
    const { fetchImpl, requests } = fixtureFetch({
      events: [
        auditEvent('TimeTravel', 'update'),
        auditEvent('CreateDatabase', 'create', '2026-09-26T13:06:00Z'),
        auditEvent('DeleteDatabase', 'delete', '2026-09-26T13:07:00Z'),
        auditEvent('OtherOperation', 'TimeTravel', '2026-09-26T13:08:00Z'),
      ],
      bookmarkAt: (timestamp) => timestamp < '2026-09-26T13:05:00Z'
        ? 'bookmark-before-secret-handle' : 'bookmark-after-secret-handle',
    });
    const receipt = await collectTemporalEvidence({ accountId: account, token: 'fixture', fetchImpl });
    expect(receipt.bookmarkForensics.candidateWindow.stateAdvance).toBe(true);
    expect(receipt.bookmarkForensics.candidateWindow.precision).toBe('FIVE_MINUTES');
    expect(receipt.auditLogs.operationIdentityComplete).toBe(true);
    expect(receipt.auditLogs.timeTravelRestore).toBe(1);
    expect(receipt.auditLogs.createDatabase).toBe(1);
    expect(receipt.auditLogs.deleteDatabase).toBe(1);
    expect(receipt.auditLogs.relevantEvents[0].actionInfo).toBe('TimeTravel');
    expect(receipt.auditLogs.relevantEvents[0].actionType).toBe('update');
    expect(receipt.auditLogs.relevantEvents[0].actorType).toBe('user');
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toMatch(/private@example|192\.0\.2\.1|must-not-appear|private-old-value|private-new-value/);
    expect(serialized).not.toContain('bookmark-before-secret-handle');
    expect(serialized).not.toContain('bookmark-after-secret-handle');
    expect(receipt.bookmarkForensics.distinctBookmarks).toBeGreaterThanOrEqual(2);
    expect(receipt.bookmarkForensics.samples.every((sample) => !('bookmark' in sample))).toBe(true);
    expect(receipt.bookmarkForensics.samples.every((sample) => /^[a-f0-9]{64}$/.test(sample.bookmarkDigest))).toBe(true);
    expect(requests.every(([url, options]) => {
      assertAllowedCloudflareRequest(url, options.method);
      return options.method === 'GET' && options.redirect === 'error';
    })).toBe(true);
  });

  it('uses deterministic digests to preserve equality and state transitions', async () => {
    const before = 'bookmark-before-secret-handle';
    const after = 'bookmark-after-secret-handle';
    const digest = (value) => createHash('sha256').update(value).digest('hex');
    const same = await collectTemporalEvidence({
      accountId: account, token: 'fixture', fetchImpl: fixtureFetch({ bookmarkAt: () => before }).fetchImpl,
    });
    expect(same.bookmarkForensics.distinctBookmarks).toBe(1);
    expect(same.bookmarkForensics.transitionCount).toBe(0);
    expect(same.bookmarkForensics.intervals.every((interval) => interval.state === 'NO_STATE_ADVANCE_OBSERVED')).toBe(true);
    expect(same.bookmarkForensics.samples.every((sample) => sample.bookmarkDigest === digest(before))).toBe(true);
    expect(same.bookmarkForensics.candidateWindow.stateAdvance).toBe(false);

    const changed = await collectTemporalEvidence({
      accountId: account, token: 'fixture',
      fetchImpl: fixtureFetch({ bookmarkAt: (timestamp) => timestamp < '2026-09-26T13:05:00Z' ? before : after }).fetchImpl,
    });
    expect(changed.bookmarkForensics.distinctBookmarks).toBe(2);
    expect(changed.bookmarkForensics.transitionCount).toBeGreaterThan(0);
    expect(changed.bookmarkForensics.intervals.some((interval) => interval.state === 'STATE_ADVANCE_OBSERVED')).toBe(true);
    expect(changed.bookmarkForensics.candidateWindow.beforeDigest).toBe(digest(before));
    expect(changed.bookmarkForensics.candidateWindow.atDigest).toBe(digest(after));
    expect(changed.bookmarkForensics.candidateWindow.afterDigest).toBe(digest(after));
    expect(changed.bookmarkForensics.candidateWindow.stateAdvance).toBe(true);
  });

  it('does not support the 13:05 candidate from a later 13:05-to-13:10 transition', async () => {
    const { fetchImpl } = fixtureFetch({ bookmarkAt: (timestamp) =>
      timestamp < '2026-09-26T13:07:00Z' ? 'stable-before' : 'changed-after' });
    const receipt = await collectTemporalEvidence({ accountId: account, token: 'fixture', fetchImpl });
    const { beforeDigest, atDigest, afterDigest, stateAdvance } = receipt.bookmarkForensics.candidateWindow;
    expect(beforeDigest).toBe(atDigest);
    expect(afterDigest).not.toBe(atDigest);
    expect(stateAdvance).toBe(true);
    expect(receipt.timeWindow).toMatchObject({ historicalCandidateStateAdvance: false,
      historicalTimestampSupported: false });
  });

  it('excludes unrelated audit resources', () => {
    expect(sanitizeAuditEvent({ actor: { email: 'private@example.test' } })).not.toHaveProperty('email');
  });
});

describe('Audit Logs v1 terminal-empty-page pagination', () => {
  const collect = async (options) => collectTemporalEvidence({
    accountId: account, token: 'fixture', fetchImpl: fixtureFetch(options).fetchImpl,
  });
  const incomplete = { available: true, complete: false,
    operationIdentityComplete: false, timeTravelRestore: null,
    createDatabase: null, deleteDatabase: null };

  it('A: accepts the T21D HTTP 200 empty audit response with only page and per_page', async () => {
    const { fetchImpl, requests } = fixtureFetch();
    const receipt = await collectTemporalEvidence({ accountId: account, token: 'fixture', fetchImpl });
    expect(receipt.auditLogs).toMatchObject({ available: true, complete: true,
      operationIdentityComplete: true, pagesRead: 1, d1Events: 0,
      createDatabase: 0, deleteDatabase: 0, timeTravelRestore: 0,
      pagination: { mode: 'v1-terminal-empty-page', perPage: 1000, pagesRead: 1,
        terminalEmptyPageObserved: true, totalCount: null, totalPages: null } });
    expect(requests.filter(([url]) => url.pathname.endsWith('/audit_logs'))).toHaveLength(1);
  });

  it('B: reads a short nonempty page and then a terminal empty page', async () => {
    const events = [auditEvent('CreateDatabase', 'create'),
      auditEvent('DeleteDatabase', 'delete'), auditEvent('TimeTravel', 'update')];
    const { fetchImpl, requests } = fixtureFetch({ events });
    const receipt = await collectTemporalEvidence({ accountId: account, token: 'fixture', fetchImpl });
    expect(receipt.auditLogs).toMatchObject({ available: true, complete: true,
      operationIdentityComplete: true, pagesRead: 2, d1Events: 3,
      createDatabase: 1, deleteDatabase: 1, timeTravelRestore: 1,
      pagination: { terminalEmptyPageObserved: true } });
    expect(requests.filter(([url]) => url.pathname.endsWith('/audit_logs'))
      .map(([url]) => url.searchParams.get('page'))).toEqual(['1', '2']);
  });

  it('C: reads 1000, then 1, then an empty page without total_count', async () => {
    const unrelated = { resource: { type: 'workers.script', id: 'fixture' } };
    const { fetchImpl, requests } = fixtureFetch({
      auditPages: [Array(1000).fill(unrelated), [auditEvent('TimeTravel', 'update')], []],
    });
    const receipt = await collectTemporalEvidence({ accountId: account, token: 'fixture', fetchImpl });
    expect(receipt.auditLogs).toMatchObject({ available: true, complete: true,
      operationIdentityComplete: true, pagesRead: 3, d1Events: 1, timeTravelRestore: 1,
      pagination: { terminalEmptyPageObserved: true } });
    expect(requests.filter(([url]) => url.pathname.endsWith('/audit_logs'))).toHaveLength(3);
  });

  it('reads 1000, 1000, 1, then the terminal empty page', async () => {
    const unrelated = { resource: { type: 'workers.script', id: 'fixture' } };
    const { fetchImpl, requests } = fixtureFetch({ auditPages: [
      Array(1000).fill(unrelated), Array(1000).fill(unrelated),
      [auditEvent('TimeTravel', 'update')], [],
    ] });
    const receipt = await collectTemporalEvidence({ accountId: account, token: 'fixture', fetchImpl });
    expect(receipt.auditLogs).toMatchObject({ available: true, complete: true,
      pagesRead: 4, timeTravelRestore: 1,
      pagination: { terminalEmptyPageObserved: true } });
    expect(requests.filter(([url]) => url.pathname.endsWith('/audit_logs'))).toHaveLength(4);
  });

  it('D: treats count as optional but rejects a count that disagrees with result.length', async () => {
    expect((await collect({ events: [auditEvent('TimeTravel', 'update')] })).auditLogs.complete).toBe(true);
    const receipt = await collect({ events: [auditEvent('TimeTravel', 'update')],
      auditResultInfo: (page, result, info) => ({ ...info, count: page === 1 ? 0 : result.length }) });
    expect(receipt.auditLogs).toMatchObject(incomplete);
  });

  it('E: accepts optional consistent total_count and rejects a mismatched final count', async () => {
    const events = [auditEvent('TimeTravel', 'update')];
    const consistent = await collect({ events,
      auditResultInfo: (page, result, info) => ({ ...info, total_count: 1, count: result.length }) });
    expect(consistent.auditLogs).toMatchObject({ complete: true, pagesRead: 2,
      timeTravelRestore: 1, pagination: { totalCount: 1, terminalEmptyPageObserved: true } });
    const mismatched = await collect({ events,
      auditResultInfo: (page, result, info) => ({ ...info, total_count: 2, count: result.length }) });
    expect(mismatched.auditLogs).toMatchObject(incomplete);
  });

  it('rejects total_count changing between pages', async () => {
    const receipt = await collect({ events: [auditEvent('TimeTravel', 'update')],
      auditResultInfo: (page, result, info) => ({ ...info, count: result.length,
        total_count: page === 1 ? 1 : 2 }) });
    expect(receipt.auditLogs).toMatchObject({ ...incomplete, pagesRead: 2 });
  });

  it('F: treats total_pages as an optional hint and still probes the empty page', async () => {
    const { fetchImpl, requests } = fixtureFetch({ events: [auditEvent('TimeTravel', 'update')],
      auditResultInfo: (page, _result, info) => ({ ...info, total_pages: 1 }) });
    const receipt = await collectTemporalEvidence({ accountId: account, token: 'fixture', fetchImpl });
    expect(receipt.auditLogs).toMatchObject({ complete: true, pagesRead: 2,
      timeTravelRestore: 1,
      pagination: { totalPages: 1, terminalEmptyPageObserved: true } });
    expect(requests.filter(([url]) => url.pathname.endsWith('/audit_logs'))).toHaveLength(2);
  });

  it('rejects total_pages changing between pages', async () => {
    const receipt = await collect({ events: [auditEvent('TimeTravel', 'update')],
      auditResultInfo: (page, _result, info) => ({ ...info, total_pages: page === 1 ? 1 : 2 }) });
    expect(receipt.auditLogs).toMatchObject({ ...incomplete, pagesRead: 2 });
  });

  it('rejects a total_pages hint that contradicts the observed terminal page', async () => {
    const receipt = await collect({ events: [auditEvent('TimeTravel', 'update')],
      auditResultInfo: (page, _result, info) => ({ ...info, total_pages: 2 }) });
    expect(receipt.auditLogs).toMatchObject({ ...incomplete, pagesRead: 2,
      pagination: { terminalEmptyPageObserved: true } });
  });

  it('accepts optional metadata appearing on only one page', async () => {
    const receipt = await collect({ events: [auditEvent('TimeTravel', 'update')],
      auditResultInfo: (page, result, info) => page === 1
        ? { ...info, count: result.length, total_count: 1, total_pages: 1 } : info });
    expect(receipt.auditLogs).toMatchObject({ complete: true, pagesRead: 2, timeTravelRestore: 1 });
  });

  it('G: rejects a response whose page differs from the requested page', async () => {
    const receipt = await collect({ events: [auditEvent('TimeTravel', 'update')],
      auditResultInfo: (page, _result, info) => ({ ...info, page: page + 1 }) });
    expect(receipt.auditLogs).toMatchObject(incomplete);
  });

  it('H: rejects per_page above the request or changing across pages', async () => {
    const tooLarge = await collect({ events: [auditEvent('TimeTravel', 'update')],
      auditResultInfo: (page, _result, info) => ({ ...info, per_page: 1001 }) });
    expect(tooLarge.auditLogs).toMatchObject(incomplete);
    const changed = await collect({ events: [auditEvent('TimeTravel', 'update')],
      auditResultInfo: (page, _result, info) => ({ ...info, per_page: page === 1 ? 1000 : 999 }) });
    expect(changed.auditLogs).toMatchObject({ ...incomplete, pagesRead: 2 });
  });

  it.each([403, 500])('I: keeps audit available when a later page returns HTTP %i', async (status) => {
    const receipt = await collect({ events: [auditEvent('TimeTravel', 'update')],
      auditFailureAt: (page) => page === 2 ? status : null });
    expect(receipt.auditLogs).toMatchObject({ ...incomplete, pagesRead: 1,
      httpStatus: status, pagination: { terminalEmptyPageObserved: false } });
  });

  it('J: marks audit unavailable when the first page fails', async () => {
    const receipt = await collect({ auditFailureAt: (page) => page === 1 ? 403 : null });
    expect(receipt.auditLogs).toMatchObject({ available: false, complete: false,
      operationIdentityComplete: false, pagesRead: 0, httpStatus: 403,
      createDatabase: null, deleteDatabase: null, timeTravelRestore: null,
      pagination: { terminalEmptyPageObserved: false } });
  });

  it('K: stops after 50 nonempty pages without requesting page 51', async () => {
    const unrelated = { resource: { type: 'workers.script', id: 'fixture' } };
    const { fetchImpl, requests } = fixtureFetch({ auditPages: Array.from({ length: 51 }, () => [unrelated]) });
    const receipt = await collectTemporalEvidence({ accountId: account, token: 'fixture', fetchImpl });
    expect(receipt.auditLogs).toMatchObject({ ...incomplete, pagesRead: 50,
      pagination: { terminalEmptyPageObserved: false } });
    expect(requests.filter(([url]) => url.pathname.endsWith('/audit_logs'))).toHaveLength(50);
  });

  it('L: remains incomplete on missing action.info despite a terminal empty page', async () => {
    const receipt = await collect({ events: [auditEvent(undefined, 'update')] });
    expect(receipt.auditLogs).toMatchObject({ available: true, complete: true,
      operationIdentityComplete: false, pagesRead: 2, timeTravelRestore: null,
      createDatabase: null, deleteDatabase: null,
      pagination: { terminalEmptyPageObserved: true } });
  });

  it('rejects missing page metadata and malformed optional integer hints', async () => {
    const receipt = await collect({ events: [auditEvent('TimeTravel', 'update')], auditResultInfo: null });
    expect(receipt.auditLogs).toMatchObject(incomplete);
    const valid = { page: 1, per_page: 1000 };
    expect(normalizeV1Pagination(valid, 1, 1, 1000)).toMatchObject({ valid: true,
      page: 1, perPage: 1000, count: 1, totalCount: null, totalPages: null });
    expect(normalizeV1Pagination({ ...valid, count: 1, total_count: 1, total_pages: 1 }, 1, 1, 1000))
      .toMatchObject({ valid: true, count: 1, totalCount: 1, totalPages: 1 });
    for (const bad of [
      { page: 2 }, { page: 1.5 }, { per_page: 0 }, { per_page: 1001 }, { per_page: 1.5 },
      { count: -1 }, { count: 0 }, { count: 1001 }, { total_count: -1 },
      { total_count: 1.5 }, { total_pages: -1 }, { total_pages: 1.5 },
    ]) {
      expect(normalizeV1Pagination({ ...valid, ...bad }, 1, 1, 1000).valid).toBe(false);
    }
    expect(normalizeV1Pagination({ page: 1 }, 0, 1, 1000).valid).toBe(false);
    expect(normalizeV1Pagination({ per_page: 1000 }, 0, 1, 1000).valid).toBe(false);
  });
});

describe('incomplete control-plane evidence', () => {
  it('does not emit a restore zero when audit pagination metadata is missing', async () => {
    const { fetchImpl } = fixtureFetch({ auditResultInfo: null });
    const receipt = await collectTemporalEvidence({ accountId: account, token: 'fixture', fetchImpl });
    expect(receipt.auditLogs.available).toBe(true);
    expect(receipt.auditLogs.complete).toBe(false);
    expect(receipt.auditLogs.operationIdentityComplete).toBe(false);
    expect(receipt.auditLogs.timeTravelRestore).toBeNull();
  });

  it('does not emit a false restore zero when D1 action.info is missing', async () => {
    const { fetchImpl } = fixtureFetch({ events: [auditEvent(undefined, 'update')] });
    const receipt = await collectTemporalEvidence({ accountId: account, token: 'fixture', fetchImpl });
    expect(receipt.auditLogs.available).toBe(true);
    expect(receipt.auditLogs.complete).toBe(true);
    expect(receipt.auditLogs.operationIdentityComplete).toBe(false);
    expect(receipt.auditLogs.timeTravelRestore).toBeNull();
    expect(receipt.auditLogs.createDatabase).toBeNull();
    expect(receipt.auditLogs.deleteDatabase).toBeNull();
  });

  it('does not report a negative restore finding when audit access is denied', async () => {
    const fetchImpl = async (url) => {
      if (url.pathname.endsWith('/audit_logs')) return { ok: false, status: 403 };
      if (url.pathname.endsWith('/time_travel/bookmark')) return mockResponse({ bookmark: 'stable' });
      return mockResponse({ uuid: db, name: 'frigo-db' });
    };
    const receipt = await collectTemporalEvidence({ accountId: account, token: 'fixture', fetchImpl });
    expect(receipt.auditLogs.available).toBe(false);
    expect(receipt.auditLogs.operationIdentityComplete).toBe(false);
    expect(receipt.auditLogs.timeTravelRestore).toBeNull();
    expect(receipt.bookmarkForensics.candidateWindow.stateAdvance).toBe(false);
  });

  it('preserves failed bookmark status without inventing a digest or candidate conclusion', async () => {
    const { fetchImpl } = fixtureFetch({
      bookmarkAt: () => 'stable',
      bookmarkErrorAt: (timestamp) => timestamp === '2026-09-26T13:05:00Z',
    });
    const receipt = await collectTemporalEvidence({ accountId: account, token: 'fixture', fetchImpl });
    const failed = receipt.bookmarkForensics.samples.find((sample) => sample.timestamp === '2026-09-26T13:05:00Z');
    expect(failed.available).toBe(false);
    expect(failed.httpStatus).toBe(503);
    expect(failed.bookmarkDigest).toBeNull();
    expect(receipt.bookmarkForensics.candidateWindow.stateAdvance).toBeNull();
  });
});

describe('adaptive bookmark refinement', () => {
  const start = '2026-09-26T12:00:00Z';
  const end = '2026-09-26T13:00:00Z';
  const timeline = (states) => async (timestamp) => {
    const state = [...states].reverse().find(([at]) => timestamp >= at)?.[1] ?? states[0][1];
    return { timestamp, bookmarkDigest: state, available: true, httpStatus: 200 };
  };
  const refine = (overrides = {}) => refineTransitionIntervals({
    leftTimestamp: start, leftDigest: 'A', rightTimestamp: end, rightDigest: 'B',
    sample: timeline([[start, 'A'], ['2026-09-26T12:37:00Z', 'B']]),
    minimumResolutionSeconds: 60, requestBudget: 96, ...overrides,
  });

  it('stops immediately when the endpoint states are equal', async () => {
    let calls = 0;
    const result = await refine({ rightDigest: 'A', sample: async () => { calls++; } });
    expect(result).toMatchObject({ complete: true, budgetExhausted: false, requestCount: 0 });
    expect(result.transitionIntervals).toHaveLength(0);
    expect(calls).toBe(0);
  });

  it('narrows a single transition to a containing interval of at most one minute', async () => {
    const result = await refine();
    expect(result.complete).toBe(true);
    expect(result.budgetExhausted).toBe(false);
    expect(result.requestCount).toBeGreaterThan(0);
    expect(result.requestCount).toBeLessThanOrEqual(96);
    expect(result.transitionIntervals).toHaveLength(1);
    expect(result.transitionIntervals[0]).toMatchObject({ state: 'STATE_ADVANCE_OBSERVED',
      leftDigest: 'A', rightDigest: 'B' });
    expect(result.transitionIntervals[0].durationSeconds).toBeLessThanOrEqual(60);
    expect(Date.parse(result.transitionIntervals[0].start)).toBeLessThanOrEqual(Date.parse('2026-09-26T12:37:00Z'));
    expect(Date.parse(result.transitionIntervals[0].end)).toBeGreaterThanOrEqual(Date.parse('2026-09-26T12:37:00Z'));
  });

  it('preserves two transitions through A, B, and C rather than collapsing them', async () => {
    const result = await refine({ rightDigest: 'C', sample: timeline([
      [start, 'A'], ['2026-09-26T12:20:00Z', 'B'], ['2026-09-26T12:40:00Z', 'C'],
    ]) });
    expect(result.complete).toBe(true);
    expect(result.transitionIntervals).toHaveLength(2);
    expect(result.transitionIntervals.map(({ leftDigest, rightDigest }) => [leftDigest, rightDigest]))
      .toEqual([['A', 'B'], ['B', 'C']]);
    expect(result.transitionIntervals.every(({ durationSeconds }) => durationSeconds <= 60)).toBe(true);
  });

  it('fails closed when a midpoint bookmark request fails', async () => {
    const result = await refine({ sample: async (timestamp) => ({ timestamp,
      bookmarkDigest: null, available: false, httpStatus: 503 }) });
    expect(result.complete).toBe(false);
    expect(result.requestCount).toBe(1);
  });

  it('stops at a deterministic request budget and preserves incomplete evidence', async () => {
    let calls = 0;
    const result = await refine({ requestBudget: 2, sample: async (timestamp) => {
      calls++;
      return timeline([[start, 'A'], ['2026-09-26T12:37:00Z', 'B']])(timestamp);
    } });
    expect(result).toMatchObject({ complete: false, budgetExhausted: true, requestCount: 2 });
    expect(calls).toBe(2);
  });

  it('refines only the two known coarse windows and never serializes raw handles', async () => {
    const rawA = 'bookmark-before-secret-handle';
    const rawB = 'bookmark-middle-secret-handle';
    const rawC = 'bookmark-after-secret-handle';
    const { fetchImpl, requests } = fixtureFetch({ bookmarkAt: (timestamp) => {
      if (timestamp < '2026-09-26T12:37:00Z') return rawA;
      if (timestamp < '2026-09-26T15:31:00Z') return rawB;
      return rawC;
    } });
    const receipt = await collectTemporalEvidence({ accountId: account, token: 'fixture', fetchImpl });
    expect(receipt.schemaVersion).toBe(2);
    expect(receipt.refinement).toMatchObject({ attempted: true, complete: true,
      requestBudget: 96, minimumResolutionSeconds: 60 });
    expect(receipt.refinement.requestCount).toBeLessThanOrEqual(96);
    expect(receipt.refinement.windows).toHaveLength(2);
    expect(receipt.refinement.windows.map(({ initialStart, initialEnd }) => [initialStart, initialEnd]))
      .toEqual([
        ['2026-09-26T12:00:00Z', '2026-09-26T13:00:00Z'],
        ['2026-09-26T13:10:00Z', '2026-09-26T18:00:00Z'],
      ]);
    expect(receipt.refinement.windows.every(({ transitionIntervals }) => transitionIntervals.length === 1)).toBe(true);
    expect(receipt.bookmarkForensics.candidateWindow.stateAdvance).toBe(false);
    expect(receipt.timeWindow).toMatchObject({ historicalCandidateStateAdvance: false,
      historicalTimestampSupported: false });
    const candidateSamples = receipt.bookmarkForensics.samples.filter(({ timestamp }) =>
      timestamp >= '2026-09-26T13:00:00Z' && timestamp <= '2026-09-26T13:10:00Z');
    expect(candidateSamples.map(({ timestamp }) => timestamp)).toEqual([
      '2026-09-26T13:00:00Z', '2026-09-26T13:05:00Z', '2026-09-26T13:10:00Z',
    ]);
    expect(new Set(candidateSamples.map(({ bookmarkDigest }) => bookmarkDigest)).size).toBe(1);
    const serialized = JSON.stringify(receipt);
    for (const raw of [rawA, rawB, rawC]) expect(serialized).not.toContain(raw);
    expect(requests.every(([url, options]) => {
      assertAllowedCloudflareRequest(url, options.method);
      return options.method === 'GET' && options.redirect === 'error';
    })).toBe(true);
  });
});
