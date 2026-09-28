import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/web/services/http';
import { scanApiErrorMessage, scanErrorMessage } from '../../src/web/lib/scan-errors';

const quota = { plan: 'free', limit: 5, used: 5, remaining: 0, resetAt: '2026-10-01T00:00:00.000Z' };

describe('scan machine error presentation', () => {
  it('shows a quota-specific message and authoritative reset date for both scan modes', () => {
    const error = new ApiError('http', `HTTP 429: ${JSON.stringify({ code: 'SCAN_QUOTA_EXCEEDED', quota })}`, 429,
      { requestId: 'request_123456789' });
    for (const context of ['fridge', 'receipt'] as const) {
      const message = scanApiErrorMessage(error, context);
      expect(message).toContain('5 lượt quét miễn phí');
      expect(message).toContain('1/10/2026');
      expect(message).toContain('Mã hỗ trợ: request_123');
      expect(message).not.toMatch(/ảnh chưa đủ rõ|không thể bóc tách/i);
    }
  });

  it('does not describe a Plus entitlement as free quota', () => {
    const plus = { ...quota, plan: 'plus', limit: 999999 };
    const message = scanErrorMessage('SCAN_QUOTA_EXCEEDED', 'fridge', { quota: plus });
    expect(message).toContain('gói hiện tại');
    expect(message).not.toContain('miễn phí');
  });

  it('keeps rate limiting, provider outages, and image quality distinct', () => {
    expect(scanErrorMessage('RATE_LIMITED', 'receipt')).toContain('giới hạn tạm thời');
    expect(scanErrorMessage('MODEL_NOT_FOUND', 'receipt')).toContain('Dịch vụ AI');
    expect(scanErrorMessage('MODEL_NOT_FOUND', 'receipt')).not.toContain('chụp');
    expect(scanErrorMessage('AI_SCAN_NO_USABLE_ITEMS', 'receipt')).toContain('chụp toàn bộ hóa đơn');
    expect(scanErrorMessage('IMAGE_STORAGE_FAILED', 'fridge')).toContain('Ảnh quét');
    expect(scanErrorMessage('IDEMPOTENCY_CONFLICT', 'fridge')).toContain('lượt quét mới');
  });

  it('never surfaces untrusted provider or request identifier text', () => {
    const error = new ApiError('http', 'HTTP 503: {"code":"MODEL_NOT_FOUND","error":"private provider detail"}', 503,
      { requestId: 'private response\nstack' });
    const message = scanApiErrorMessage(error, 'fridge');
    expect(message).not.toContain('private');
    expect(message).not.toContain('Mã hỗ trợ');
  });
});
