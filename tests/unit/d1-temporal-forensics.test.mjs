import { describe, expect, it } from 'vitest';
import { assertAllowedCloudflareRequest, collectTemporalEvidence, sanitizeAuditEvent } from '../../scripts/d1-temporal-forensics.mjs';

const account = 'a'.repeat(32);
const db = 'f975ec39-b2c8-4a2a-80e1-0366054599d3';
const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;

function mockResponse(result) {
  return { ok: true, status: 200, json: async () => ({ success: true, result }) };
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
    expect(() => assertAllowedCloudflareRequest(`${base}/d1/database/${db}`, 'POST')).toThrow();
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

  it('emits sanitized audit fields and never calls SQL or restore endpoints', async () => {
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push([url, options]);
      if (url.pathname.endsWith('/audit_logs')) return mockResponse([{
        when: '2026-09-26T13:05:00Z', action: { type: 'TimeTravelRestore', result: true },
        actor: { type: 'user', email: 'private@example.test', ip: '192.0.2.1' },
        resource: { type: 'd1.database', id: db }, interface: 'API',
        metadata: { private: 'must-not-appear' },
      }]);
      if (url.pathname.endsWith('/time_travel/bookmark')) {
        const timestamp = url.searchParams.get('timestamp');
        return mockResponse({ bookmark: timestamp < '2026-09-26T13:05:00Z' ? 'before' : 'after' });
      }
      return mockResponse({ uuid: db, name: 'frigo-db', version: 'production', created_at: '2026-01-01T00:00:00Z' });
    };
    const receipt = await collectTemporalEvidence({ accountId: account, token: 'fixture', fetchImpl });
    expect(receipt.bookmarkForensics.candidateWindow.stateAdvance).toBe(true);
    expect(receipt.bookmarkForensics.candidateWindow.precision).toBe('MINUTE');
    expect(receipt.auditLogs.timeTravelRestore).toBe(1);
    expect(receipt.auditLogs.relevantEvents[0].actorType).toBe('user');
    expect(JSON.stringify(receipt)).not.toMatch(/private@example|192\.0\.2\.1|must-not-appear/);
    expect(requests.every(([url, options]) => {
      assertAllowedCloudflareRequest(url, options.method);
      return options.method === 'GET';
    })).toBe(true);
  });

  it('excludes unrelated audit resources', () => {
    expect(sanitizeAuditEvent({ actor: { email: 'private@example.test' } })).not.toHaveProperty('email');
  });
});

describe('incomplete control-plane evidence', () => {
  it('does not report a negative restore finding when audit access is denied', async () => {
    const fetchImpl = async (url) => {
      if (url.pathname.endsWith('/audit_logs')) return { ok: false, status: 403 };
      if (url.pathname.endsWith('/time_travel/bookmark')) return mockResponse({ bookmark: 'stable' });
      return mockResponse({ uuid: db, name: 'frigo-db' });
    };
    const receipt = await collectTemporalEvidence({ accountId: account, token: 'fixture', fetchImpl });
    expect(receipt.auditLogs.available).toBe(false);
    expect(receipt.auditLogs.timeTravelRestore).toBeNull();
    expect(receipt.bookmarkForensics.candidateWindow.stateAdvance).toBe(false);
  });
});
