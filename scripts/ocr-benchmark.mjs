#!/usr/bin/env node
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, extname } from 'node:path';
import sharp from 'sharp';

const names = ['receipt_easy', 'receipt_medium', 'receipt_hard', 'receipt_veryhard'];
const variants = ['original', 'current_2000_q82', 'candidate_2400_q90', 'lossless_png'];
const args = process.argv.slice(2);
const mode = args[0];
const option = (key, fallback) => {
  const index = args.indexOf(key);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const dataset = resolve(option('--dataset', 'qa/ocr'));
const output = resolve(option('--output', '.artifacts/ocr-benchmark'));

function fail(code, detail) {
  process.stderr.write(`${code}: ${detail}\n`);
  process.exitCode = 1;
}

async function json(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { fail('DATASET_UNAVAILABLE', `Required JSON is unavailable: ${path}`); return null; }
}

function validItem(item) {
  return item && typeof item.name === 'string' && item.name.trim()
    && Number.isFinite(item.quantity) && item.quantity > 0
    && Number.isFinite(item.totalPriceVnd) && item.totalPriceVnd >= 0;
}

function validExpected(input) {
  return input && input.version === 1 && names.every((name) => {
    const receipt = input.receipts?.[name];
    return receipt && typeof receipt.file === 'string' && /^[a-zA-Z0-9_.-]+$/.test(receipt.file)
      && receipt.file.startsWith(`${name}.`)
      && Array.isArray(receipt.items) && receipt.items.length > 0
      && receipt.items.every(validItem)
      && Number.isFinite(receipt.totalAmountVnd) && receipt.totalAmountVnd >= 0;
  });
}

function normalized(value) {
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function editDistance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

function minimumNameEdits(actual, predicted) {
  const size = Math.max(actual.length, predicted.length);
  if (!size) return 0;
  const costs = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => editDistance(actual[i] || '', predicted[j] || '')));
  const rowPotential = Array(size + 1).fill(0);
  const columnPotential = Array(size + 1).fill(0);
  const matchedRow = Array(size + 1).fill(0);
  const predecessor = Array(size + 1).fill(0);
  for (let row = 1; row <= size; row += 1) {
    matchedRow[0] = row;
    let column = 0;
    const best = Array(size + 1).fill(Infinity);
    const used = Array(size + 1).fill(false);
    do {
      used[column] = true;
      const currentRow = matchedRow[column];
      let delta = Infinity;
      let nextColumn = 0;
      for (let candidate = 1; candidate <= size; candidate += 1) {
        if (used[candidate]) continue;
        const cost = costs[currentRow - 1][candidate - 1]
          - rowPotential[currentRow] - columnPotential[candidate];
        if (cost < best[candidate]) {
          best[candidate] = cost;
          predecessor[candidate] = column;
        }
        if (best[candidate] < delta) {
          delta = best[candidate];
          nextColumn = candidate;
        }
      }
      for (let candidate = 0; candidate <= size; candidate += 1) {
        if (used[candidate]) {
          rowPotential[matchedRow[candidate]] += delta;
          columnPotential[candidate] -= delta;
        } else {
          best[candidate] -= delta;
        }
      }
      column = nextColumn;
    } while (matchedRow[column] !== 0);
    do {
      const previous = predecessor[column];
      matchedRow[column] = matchedRow[previous];
      column = previous;
    } while (column !== 0);
  }
  return -columnPotential[0];
}

function matchItems(truth, predicted) {
  const remaining = new Set(predicted.map((_, index) => index));
  const exactPairs = [];
  for (const item of truth) {
    const matches = [...remaining].filter((index) => normalized(predicted[index].name) === normalized(item.name));
    if (!matches.length) continue;
    const match = matches.find((index) => predicted[index].quantity === item.quantity
      && predicted[index].totalPriceVnd === item.totalPriceVnd)
      ?? matches.find((index) => predicted[index].totalPriceVnd === item.totalPriceVnd)
      ?? matches[0];
    exactPairs.push([item, predicted[match]]);
    remaining.delete(match);
  }
  return exactPairs;
}

function scoreRun(run, truth) {
  const exactPairs = matchItems(truth.items, run.items);
  const actual = truth.items.map((item) => normalized(item.name));
  const predicted = run.items.map((item) => normalized(item.name));
  // Receipt rows may reorder; minimize name edits across all line assignments.
  const textErrors = minimumNameEdits(actual, predicted);
  const textChars = actual.reduce((sum, item) => sum + item.length, 0);
  return {
    case: run.case, variant: run.variant, expectedItemCount: actual.length,
    detectedItemCount: predicted.length, exactNameMatches: exactPairs.length,
    nameCharacterErrorRate: textChars ? textErrors / textChars : null,
    quantityMatches: exactPairs.filter(([a, b]) => a.quantity === b.quantity).length,
    priceMatches: exactPairs.filter(([a, b]) => a.totalPriceVnd === b.totalPriceVnd).length,
    totalMatch: truth.totalAmountVnd === run.totalAmountVnd,
    latencyMs: run.latencyMs,
  };
}

if (!['prepare', 'score'].includes(mode)) {
  fail('USAGE', 'node scripts/ocr-benchmark.mjs prepare|score [--dataset qa/ocr] [--output .artifacts/ocr-benchmark]');
} else {
  const expected = await json(join(dataset, 'expected.json'));
  if (expected && !validExpected(expected)) fail('GROUND_TRUTH_INVALID', 'expected.json must match qa/ocr/expected.schema.json with all four receipts.');
  if (expected && validExpected(expected) && mode === 'prepare') {
    await mkdir(output, { recursive: true, mode: 0o700 });
    const report = { version: 1, cases: [] };
    for (const name of names) {
      const source = join(dataset, expected.receipts[name].file);
      let bytes;
      try { bytes = await readFile(source); }
      catch { fail('DATASET_UNAVAILABLE', `Image is unavailable: ${source}`); break; }
      let metadata;
      try { metadata = await sharp(bytes).metadata(); }
      catch { fail('DATASET_INVALID', `Image cannot be decoded: ${source}`); break; }
      const extension = extname(source).toLowerCase();
      if (!['.jpg', '.jpeg', '.png', '.webp'].includes(extension) || !metadata.width || !metadata.height) {
        fail('DATASET_INVALID', `Unsupported image format or dimensions: ${source}`);
        break;
      }
      const resized = Math.max(metadata.width, metadata.height) > 2000;
      const currentBytes = await sharp(bytes).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 }).toBuffer();
      const keepOriginal = !resized && currentBytes.length >= bytes.length;
      const paths = {
        original: join(output, `${name}_original${extension}`),
        current_2000_q82: join(output, `${name}_current_2000_q82${keepOriginal ? extension : '.jpg'}`),
        candidate_2400_q90: join(output, `${name}_candidate_2400_q90.jpg`),
        lossless_png: join(output, `${name}_lossless.png`),
      };
      await copyFile(source, paths.original);
      await writeFile(paths.current_2000_q82, keepOriginal ? bytes : currentBytes, { mode: 0o600 });
      await sharp(bytes).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90 }).toFile(paths.candidate_2400_q90);
      await sharp(bytes).rotate().png({ compressionLevel: 9 }).toFile(paths.lossless_png);
      for (const variant of variants) {
        const variantBytes = await readFile(paths[variant]);
        const variantMeta = await sharp(variantBytes).metadata();
        report.cases.push({ case: name, variant, path: paths[variant], bytes: variantBytes.length,
          width: variantMeta.width, height: variantMeta.height,
          sha256: createHash('sha256').update(variantBytes).digest('hex') });
      }
    }
    if (!process.exitCode) {
      await writeFile(join(output, 'prepared.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      process.stdout.write(`Prepared ${report.cases.length} private image variants in ${output}.\n`);
    }
  }
  if (expected && validExpected(expected) && mode === 'score') {
    const results = await json(join(dataset, 'results.json'));
    if (results) {
      if (results.version !== 1 || !Array.isArray(results.runs) || results.runs.length !== 16) {
        fail('RESULTS_INVALID', 'results.json must contain exactly one run for each case and variant.');
      } else {
        const seen = new Set();
        const scores = [];
        for (const run of results.runs) {
          const key = `${run.case}:${run.variant}`;
          if (!names.includes(run.case) || !variants.includes(run.variant) || seen.has(key)
            || !Array.isArray(run.items) || !run.items.every(validItem)
            || !Number.isFinite(run.totalAmountVnd) || run.totalAmountVnd < 0
            || !Number.isFinite(run.latencyMs) || run.latencyMs < 0) {
            fail('RESULTS_INVALID', `Invalid or duplicate run: ${key}`);
            break;
          }
          seen.add(key);
          scores.push(scoreRun(run, expected.receipts[run.case]));
        }
        if (!process.exitCode && seen.size === 16) {
          await mkdir(output, { recursive: true, mode: 0o700 });
          await writeFile(join(output, 'scores.json'), `${JSON.stringify({ version: 1, scores }, null, 2)}\n`, { mode: 0o600 });
          process.stdout.write(`Scored ${scores.length} private OCR runs in ${output}/scores.json.\n`);
        }
      }
    }
  }
}
