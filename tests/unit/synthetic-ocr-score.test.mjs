import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const directory = resolve('.artifacts/ocr-synthetic-score-test');
const manifest = `${directory}/expected.synthetic.json`;
const prepared = `${directory}/prepared.synthetic.json`;
const results = `${directory}/results.synthetic.json`;
const scores = `${directory}/scores.synthetic.json`;

describe('synthetic OCR scorer', () => {
  it('counts incorrect quantity, price, and total separately without altering ground truth', () => {
    execFileSync(process.execPath, ['scripts/generate-synthetic-ocr.mjs', directory, manifest],
      { cwd: process.cwd(), stdio: 'pipe' });
    const expected = JSON.parse(readFileSync(manifest, 'utf8'));
    const images = JSON.parse(readFileSync(prepared, 'utf8'));
    const runs = images.cases.map((image) => {
      const truth = expected.receipts[image.case];
      return { case: image.case, variant: image.variant, latencyMs: 12,
        totalAmountVnd: truth.totalAmountVnd, items: structuredClone(truth.items) };
    });
    const changed = runs.find((run) => run.case === 'synthetic_easy' && run.variant === 'current_2000_q82');
    changed.items[0].quantity += 1;
    changed.items[1].totalPriceVnd += 1000;
    changed.totalAmountVnd += 1000;
    writeFileSync(results, JSON.stringify({ version: 1, engine: 'scorer-fixture', runs }));
    execFileSync(process.execPath, ['scripts/score-synthetic-ocr.mjs', manifest, prepared, results, scores],
      { cwd: process.cwd(), stdio: 'pipe' });
    const output = JSON.parse(readFileSync(scores, 'utf8'));
    const measured = output.scores.find((run) => run.case === 'synthetic_easy' && run.variant === 'current_2000_q82');
    expect(measured).toMatchObject({ exactNormalizedNameCount: 8, quantityCount: 7,
      priceCount: 7, totalExact: false, provisionalTargetsMet: false });
    expect(output.scores.filter((run) => run.provisionalTargetsMet === false)).toHaveLength(1);
    expect(JSON.parse(readFileSync(manifest, 'utf8'))).toEqual(expected);
  });
});
