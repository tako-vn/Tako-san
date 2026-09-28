// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/web/services/http';

const getMe = vi.hoisted(() => vi.fn());
const scanFridge = vi.hoisted(() => vi.fn());
vi.mock('../../src/web/services/api', () => ({ api: { getMe, scanFridge } }));
vi.mock('../../src/web/components/scan/CameraViewfinder', () => ({
  CameraViewfinder: ({ onCapture }: { onCapture: (image: string) => void }) =>
    <button onClick={() => onCapture('data:image/png;base64,dGVzdA==')}>Capture test image</button>,
}));

import { ScanPage } from '../../src/web/pages/ScanPage';

const snapshot = { user: { id: 'guest-test', household: { id: 'hh_guest-test' },
  subscription: { plan: 'free', limit: 5, used: 2, remaining: 3, resetAt: '2026-10-01T00:00:00Z' } } };

async function click(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(text));
  expect(button).toBeDefined();
  await act(async () => { button?.click(); });
}

describe('scan quota UI', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    localStorage.setItem('frigo_user_id', 'guest-test');
    localStorage.setItem('frigo_household_id', 'hh_guest-test');
    getMe.mockResolvedValue(snapshot);
    host = document.createElement('div');
    document.body.appendChild(host);
  });
  afterEach(() => {
    act(() => root?.unmount());
    host.remove();
    getMe.mockReset();
    scanFridge.mockReset();
  });

  async function render() {
    await act(async () => {
      root = createRoot(host);
      root.render(<MemoryRouter><ScanPage /></MemoryRouter>);
    });
  }

  it('shows remaining Free scans from the server snapshot', async () => {
    await render();
    expect(host.querySelector('[data-testid="scan-quota"]')?.textContent).toContain('3/5');
    expect(getMe).toHaveBeenCalledWith({ requireServer: true });
  });

  it('uses a new key after terminal scan failure and reuses the key after ambiguous enqueue', async () => {
    scanFridge.mockRejectedValueOnce(new ApiError('http',
      'HTTP 503: {"code":"MAX_ATTEMPTS_EXCEEDED","scan":{"status":"failed"}}', 503));
    scanFridge.mockRejectedValueOnce(new ApiError('http', 'HTTP 503: {"code":"QUEUE_UNAVAILABLE"}', 503));
    scanFridge.mockRejectedValueOnce(new ApiError('http', 'HTTP 503: {"code":"QUEUE_UNAVAILABLE"}', 503));
    scanFridge.mockRejectedValueOnce(new ApiError('offline', 'Network response lost', undefined, { retryable: true }));
    await render();
    await click(host, 'Capture test image');
    const firstKey = scanFridge.mock.calls[0][2];
    expect(host.textContent).toContain('Thử xử lý lại');

    await click(host, 'Thử xử lý lại');
    const secondKey = scanFridge.mock.calls[1][2];
    expect(secondKey).not.toBe(firstKey);
    expect(host.textContent).toContain('Kiểm tra lại');

    await click(host, 'Kiểm tra lại');
    expect(scanFridge.mock.calls[2][2]).toBe(secondKey);
    await click(host, 'Kiểm tra lại');
    expect(scanFridge.mock.calls[3][2]).toBe(secondKey);
    expect(host.textContent).toContain('mất kết nối');
  });
});
