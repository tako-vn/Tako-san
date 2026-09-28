#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const expectedPath = resolve(process.argv[2] || 'qa/ocr/synthetic/expected.synthetic.json');
const preparedPath = resolve(process.argv[3] || '.artifacts/ocr-synthetic/prepared.synthetic.json');
const resultsPath = resolve(process.argv[4] || '.artifacts/ocr-synthetic/apple-vision.raw.json');
const outputPath = resolve(process.argv[5] || '.artifacts/ocr-synthetic/scores.synthetic.json');
const variants = ['original', 'current_2000_q82', 'candidate_2400_q90', 'lossless_png'];
const targets = {
  synthetic_easy: { name: 0.95, quantity: 0.95, price: 0.95, total: 1 },
  synthetic_medium: { name: 0.90, quantity: 0.90, price: 0.90, total: 0.95 },
  synthetic_hard: { name: 0.85, quantity: 0.85, price: 0.85, total: 0.90 },
};

async function load(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error(`RESULTS_UNAVAILABLE_OR_INVALID: ${path}`); }
}
function normalized(value) {
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(current[column - 1] + 1, previous[column] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}
function minimumNameEdits(actual, predicted) {
  const size = Math.max(actual.length, predicted.length);
  if (!size) return 0;
  const costs = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => editDistance(actual[row] || '', predicted[column] || '')));
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
        } else best[candidate] -= delta;
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
function numberFromText(text) {
  const value = String(text).replace(/[^0-9]/g, '');
  return value ? Number(value) : null;
}
function quantityFromText(text) {
  const match = normalized(text).match(/(\d+(?:[,.]\d+)?)\s*(kg|ml|g|l|qua|bo|cai|piece|bunch)\b/);
  if (!match) return { quantity: null, unit: null };
  const unit = { qua: 'piece', cai: 'piece', piece: 'piece', bo: 'bunch', bunch: 'bunch' }[match[2]] || match[2];
  return { quantity: Number(match[1].replace(',', '.')), unit };
}
function parseObservations(observations) {
  const lines = observations.filter((line) => typeof line.text === 'string' && Number.isFinite(line.x) && Number.isFinite(line.y));
  const left = lines.filter((line) => line.x < 0.55);
  const header = left.find((line) => normalized(line.text).includes('mat hang'));
  const total = left.find((line) => normalized(line.text).includes('tong cong'));
  const priceHeader = lines.find((line) => line.x > 0.79 && normalized(line.text).includes('thanh tien'));
  const slope = header && priceHeader ? (priceHeader.y - header.y) / (priceHeader.x - header.x) : 0;
  const anchorX = header?.x ?? 0.15;
  const rowY = (line) => line.y - slope * (line.x - anchorX);
  const names = left.filter((line) => {
    const value = normalized(line.text);
    return line.y < (header?.y ?? 0.93) - 0.007 && line.y > (total?.y ?? 0.05) + 0.005
      && value && !/^(takosan|phieu thu|synthetic|mat hang|tong cong)/.test(value);
  }).sort((a, b) => b.y - a.y);
  const quantities = lines.filter((line) => line.x >= 0.55 && line.x <= 0.79 && quantityFromText(line.text).quantity !== null);
  const prices = lines.filter((line) => line.x > 0.79 && numberFromText(line.text) !== null
    && !normalized(line.text).includes('vnd'));
  const usedQuantities = new Set();
  const usedPrices = new Set();
  const spacing = names.length > 1 ? Math.abs(names[0].y - names[1].y) : 0.03;
  const tolerance = Math.max(0.012, spacing * 0.55);
  const nearest = (pool, used, name) => {
    const best = pool.map((line, index) => ({ line, index, distance: Math.abs(rowY(line) - rowY(name)) }))
      .filter((entry) => !used.has(entry.index) && entry.distance <= tolerance)
      .sort((a, b) => a.distance - b.distance)[0];
    if (best) used.add(best.index);
    return best?.line;
  };
  const items = names.map((line) => {
    const quantityLine = nearest(quantities, usedQuantities, line);
    const priceLine = nearest(prices, usedPrices, line);
    return { name: line.text, ...quantityFromText(quantityLine?.text || ''),
      totalPriceVnd: priceLine ? numberFromText(priceLine.text) : null };
  });
  const totalLine = lines.find((line) => line.x > 0.65 && normalized(line.text).includes('vnd'));
  return { items, totalAmountVnd: totalLine ? numberFromText(totalLine.text) : null };
}
function pairItems(truth, predicted) {
  const remaining = new Set(predicted.map((_, index) => index));
  const pairs = [];
  for (const item of truth) {
    const matches = [...remaining].filter((index) => normalized(predicted[index].name) === normalized(item.name));
    const match = matches.find((index) => predicted[index].quantity === item.quantity
      && predicted[index].totalPriceVnd === item.totalPriceVnd)
      ?? matches.find((index) => predicted[index].totalPriceVnd === item.totalPriceVnd)
      ?? matches[0];
    if (match === undefined) continue;
    pairs.push([item, predicted[match]]);
    remaining.delete(match);
  }
  return pairs;
}
function score(run, truth, image, engine) {
  const parsed = Array.isArray(run.observations) ? parseObservations(run.observations) : run;
  if (!Array.isArray(parsed.items) || !Number.isFinite(run.latencyMs) || run.latencyMs < 0) {
    throw new Error(`RESULTS_INVALID: ${run.case}:${run.variant}`);
  }
  const pairs = pairItems(truth.items, parsed.items);
  const actualNames = truth.items.map((item) => normalized(item.name));
  const predictedNames = parsed.items.map((item) => normalized(item.name));
  const characterCount = actualNames.reduce((sum, name) => sum + name.length, 0);
  const count = truth.items.length;
  const result = {
    case: run.case, variant: run.variant, engine, inputBytes: image.bytes,
    inputWidth: image.width, inputHeight: image.height, latencyMs: run.latencyMs,
    expectedItemCount: count, detectedItemCount: parsed.items.length,
    exactNormalizedNameCount: pairs.length, nameAccuracy: pairs.length / count,
    quantityCount: pairs.filter(([a, b]) => a.quantity === b.quantity && a.unit === b.unit).length,
    priceCount: pairs.filter(([a, b]) => a.totalPriceVnd === b.totalPriceVnd).length,
    totalExact: truth.totalAmountVnd === parsed.totalAmountVnd,
    characterErrorRate: characterCount ? minimumNameEdits(actualNames, predictedNames) / characterCount : null,
    canonicalMappingRate: engine.startsWith('Apple Vision') ? null
      : parsed.items.length ? parsed.items.filter((item) => item.canonicalId).length / parsed.items.length : null,
    providerAttempts: run.providerAttempts ?? null,
    modelEscalations: run.modelEscalations ?? null,
    inputTokens: run.inputTokens ?? null,
    outputTokens: run.outputTokens ?? null,
    estimatedCostUsd: run.estimatedCostUsd ?? null,
  };
  result.quantityAccuracy = result.quantityCount / count;
  result.priceAccuracy = result.priceCount / count;
  const target = targets[run.case];
  result.provisionalTargetsMet = target ? result.nameAccuracy >= target.name
    && result.quantityAccuracy >= target.quantity && result.priceAccuracy >= target.price
    && Number(result.totalExact) >= target.total : null;
  return result;
}

const [expected, prepared, results] = await Promise.all([load(expectedPath), load(preparedPath), load(resultsPath)]);
const names = Object.keys(expected.receipts || {});
if (expected.classification !== 'SYNTHETIC_OCR_CERTIFICATION' || expected.seed !== prepared.seed
  || names.length !== 4 || !Array.isArray(results.runs) || results.runs.length !== 16) {
  throw new Error('RESULTS_INVALID: dataset metadata or 16-run matrix mismatch');
}
const images = new Map(prepared.cases.map((image) => [`${image.case}:${image.variant}`, image]));
const seen = new Set();
const scores = [];
for (const run of results.runs) {
  const key = `${run.case}:${run.variant}`;
  const image = images.get(key);
  if (!image || !names.includes(run.case) || !variants.includes(run.variant) || seen.has(key)) {
    throw new Error(`RESULTS_INVALID: unknown or duplicate ${key}`);
  }
  seen.add(key);
  scores.push(score(run, expected.receipts[run.case], image, results.engine || 'unknown'));
}
const output = { version: 1, classification: 'SYNTHETIC_OCR_CERTIFICATION', seed: expected.seed,
  engine: results.engine || 'unknown', productOcrCertified: false, scores };
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`Scored ${scores.length} synthetic runs with ${output.engine}; product Qwen OCR certification remains separate.\n`);
