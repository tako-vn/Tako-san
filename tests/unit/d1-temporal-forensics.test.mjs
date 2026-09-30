import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { assertAllowedCloudflareRequest, collectTemporalEvidence, sanitizeAuditEvent } from '../../scripts/d1-temporal-forensics.mjs';

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

function fixtureFetch({ events = [], auditPages = [events], auditResultInfo = { total_pages: 1 },
  bookmarkAt = () => 'stable', bookmarkErrorAt = () => false } = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push([url, options]);
    if (url.pathname.endsWith('/audit_logs')) {
      const page = Number(url.searchParams.get('page'));
      return mockResponse(auditPages[page - 1] ?? [], auditResultInfo ?? undefined);
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
    expect(receipt.bookmarkForensics.candidateWindow.precision).toBe('MINUTE');
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

  it('excludes unrelated audit resources', () => {
    expect(sanitizeAuditEvent({ actor: { email: 'private@example.test' } })).not.toHaveProperty('email');
  });
});

describe('incomplete control-plane evidence', () => {
  it('reads later audit pages even when the first page is short', async () => {
    const { fetchImpl, requests } = fixtureFetch({
      auditPages: [[], [auditEvent('TimeTravel', 'update')]],
      auditResultInfo: { total_pages: 2 },
    });
    const receipt = await collectTemporalEvidence({ accountId: account, token: 'fixture', fetchImpl });
    expect(receipt.auditLogs.available).toBe(true);
    expect(receipt.auditLogs.complete).toBe(true);
    expect(receipt.auditLogs.operationIdentityComplete).toBe(true);
    expect(receipt.auditLogs.pagesRead).toBe(2);
    expect(receipt.auditLogs.timeTravelRestore).toBe(1);
    expect(requests.filter(([url]) => url.pathname.endsWith('/audit_logs'))).toHaveLength(2);
  });

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
