import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson, ApiError } from '../../src/web/services/http';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

afterEach(() => vi.unstubAllGlobals());

describe('scan request correlation', () => {
  it('preserves machine code and response request ID on HTTP failure', async () => {
    const storage = new MemoryStorage();
    storage.setItem('frigo_user_id', 'user-a');
    storage.setItem('frigo_household_id', 'house-a');
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', new MemoryStorage());
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'SCAN_QUOTA_EXCEEDED' }), {
      status: 429, headers: { 'X-Request-Id': 'request_abc12345' },
    })));
    await expect(fetchJson('/scans/fridge')).rejects.toMatchObject({
      kind: 'http', status: 429, requestId: 'request_abc12345', code: 'SCAN_QUOTA_EXCEEDED',
    } satisfies Partial<ApiError>);
  });
});
