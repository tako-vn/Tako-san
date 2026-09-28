import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';

const output = resolve('.artifacts/ocr-synthetic-test');
const manifest = resolve('.artifacts/ocr-synthetic-test/expected.synthetic.json');
const prepared = resolve('.artifacts/ocr-synthetic-test/prepared.synthetic.json');

function generate() {
  execFileSync(process.execPath, ['scripts/generate-synthetic-ocr.mjs', output, manifest],
    { cwd: process.cwd(), stdio: 'pipe' });
  return {
    expected: JSON.parse(readFileSync(manifest, 'utf8')),
    prepared: JSON.parse(readFileSync(prepared, 'utf8')),
  };
}

describe('synthetic OCR source-first fixture', () => {
  it('renders a reproducible four-case/16-variant matrix from independent source rows', async () => {
    const first = generate();
    expect(first.expected.classification).toBe('SYNTHETIC_OCR_CERTIFICATION');
    expect(first.expected.seed).toBe(20260929);
    expect(Object.keys(first.expected.receipts)).toEqual([
      'synthetic_easy', 'synthetic_medium', 'synthetic_hard', 'synthetic_veryhard',
    ]);
    expect(Object.values(first.expected.receipts).map((receipt) => receipt.items.length)).toEqual([8, 14, 21, 29]);
    for (const receipt of Object.values(first.expected.receipts)) {
      expect(receipt.totalAmountVnd).toBe(receipt.items.reduce((sum, item) => sum + item.totalPriceVnd, 0));
      expect(receipt.items.every((item) => item.quantity > 0 && item.unit && item.name)).toBe(true);
    }
    expect(first.prepared.cases).toHaveLength(16);
    for (const image of first.prepared.cases) {
      const bytes = readFileSync(image.path);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(image.sha256);
      const metadata = await sharp(bytes).metadata();
      expect([metadata.width, metadata.height]).toEqual([image.width, image.height]);
      if (image.variant === 'current_2000_q82') expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(2000);
      if (image.variant === 'candidate_2400_q90') expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(2400);
    }
    const second = generate();
    expect(second.expected).toEqual(first.expected);
    expect(second.prepared.cases.map((image) => image.sha256)).toEqual(first.prepared.cases.map((image) => image.sha256));
  });
});
