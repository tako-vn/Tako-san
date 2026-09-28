#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';

const version = 1;
const seed = 20260929;
const output = resolve(process.argv[2] || '.artifacts/ocr-synthetic');
const manifestPath = resolve(process.argv[3] || 'qa/ocr/synthetic/expected.synthetic.json');
const source = [
  ['CÀ CHUA', 1, 'kg', 42000], ['THỊT BÒ', 500, 'g', 119000],
  ['TRỨNG GÀ', 10, 'piece', 36000], ['SỮA TƯƠI', 1, 'l', 32000],
  ['RAU CẢI', 2, 'bunch', 26000], ['HÀNH TÂY', 500, 'g', 18000],
  ['KHOAI TÂY', 1, 'kg', 39000], ['ĐẬU PHỤ', 3, 'piece', 21000],
  ['CÁ HỒI', 350, 'g', 98000], ['TÔM TƯƠI', 400, 'g', 76000],
  ['NẤM RƠM', 250, 'g', 29000], ['GẠO TẺ', 2, 'kg', 56000],
  ['DẦU ĂN', 1, 'l', 49000], ['NƯỚC MẮM', 500, 'ml', 37000],
  ['CHUỐI', 1, 'kg', 28000], ['TÁO ĐỎ', 1, 'kg', 65000],
  ['CAM SÀNH', 1, 'kg', 34000], ['SỮA CHUA', 4, 'piece', 28000],
  ['PHÔ MAI', 200, 'g', 59000], ['CÀ CHUA BI', 500, 'g', 34000],
  ['THỊT HEO', 600, 'g', 78000], ['RAU MUỐNG', 2, 'bunch', 24000],
  ['NẤM KIM CHÂM', 200, 'g', 25000], ['BẮP CẢI', 1, 'kg', 33000],
  ['CA CHUA', 500, 'g', 19000], ['HÀNH LÁ', 100, 'g', 11000],
  ['CÁ THU', 450, 'g', 87000], ['TOM TƯƠI', 200, 'g', 41000],
  ['KHOAI LANG', 1, 'kg', 31000], ['ĐẬU XANH', 500, 'g', 35000],
];
const cases = [
  { name: 'synthetic_easy', count: 8, font: 29, row: 49, width: 1040, rotation: 0, quality: null },
  { name: 'synthetic_medium', count: 14, font: 25, row: 43, width: 900, rotation: 1.1, quality: 86 },
  { name: 'synthetic_hard', count: 21, font: 20, row: 52, width: 1700, rotation: -2.1, quality: 68 },
  { name: 'synthetic_veryhard', count: 29, font: 16, row: 46, width: 1650, rotation: 2.8, quality: 49 },
];
const units = { kg: 'KG', g: 'G', l: 'L', ml: 'ML', piece: 'QUẢ', bunch: 'BÓ' };
const money = (amount) => amount.toLocaleString('en-US');
const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const font = (await readFile(resolve('tests/e2e/t17-ui/fonts/nunito-400.ttf'))).toString('base64');

await mkdir(output, { recursive: true, mode: 0o700 });
await mkdir(dirname(manifestPath), { recursive: true });
const expected = {
  version, classification: 'SYNTHETIC_OCR_CERTIFICATION', generator: 'scripts/generate-synthetic-ocr.mjs', seed,
  receipts: Object.fromEntries(cases.map(({ name, count }) => {
    const items = source.slice(0, count).map(([label, quantity, unit, totalPriceVnd]) => ({
      name: label, quantity, unit, totalPriceVnd,
    }));
    return [name, { items, totalAmountVnd: items.reduce((sum, item) => sum + item.totalPriceVnd, 0) }];
  })),
};
// Ground truth is written from source records before any image is rendered.
await writeFile(manifestPath, `${JSON.stringify(expected, null, 2)}\n`);

const prepared = { version, seed, renderer: `sharp ${sharp.versions.sharp}; librsvg ${sharp.versions.rsvg}`, cases: [] };
for (const config of cases) {
  const truth = expected.receipts[config.name];
  const height = 340 + config.count * config.row;
  const rows = truth.items.map((item, index) => {
    const y = 203 + index * config.row;
    const ink = config.name === 'synthetic_veryhard' && index % 7 === 4 ? '#5f5b52' : '#252923';
    return `<g fill="${ink}" font-size="${config.font}"><text x="57" y="${y}">${escape(item.name)}</text><text x="708" y="${y}" text-anchor="end">${item.quantity} ${units[item.unit]}</text><text x="985" y="${y}" text-anchor="end">${money(item.totalPriceVnd)}</text></g>`;
  }).join('');
  const totalY = 220 + config.count * config.row;
  const wrinkles = config.name.includes('hard') ? `<path d="M38 ${height * 0.36} Q450 ${height * 0.33} 1002 ${height * 0.37} M26 ${height * 0.68} Q480 ${height * 0.71} 1011 ${height * 0.67}" fill="none" stroke="#b9b5a9" stroke-opacity="0.22" stroke-width="6"/>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="${height}" viewBox="0 0 1040 ${height}">
    <style>@font-face{font-family:QA-Nunito;src:url(data:font/ttf;base64,${font})}text{font-family:QA-Nunito,'Arial',sans-serif}</style>
    <rect width="1040" height="${height}" fill="#efece3"/><rect x="28" y="18" width="984" height="${height - 36}" rx="5" fill="#faf9f3"/>
    <text x="520" y="78" text-anchor="middle" font-size="39" font-weight="700" fill="#20241f">TAKOSAN QA MART</text>
    <text x="520" y="121" text-anchor="middle" font-size="22" fill="#41443e">PHIẾU THỬ NGHIỆM - KHÔNG PHẢI HÓA ĐƠN THẬT</text>
    <path d="M48 150 H992" stroke="#555a50" stroke-width="2" stroke-dasharray="8 7"/>
    <g fill="#3b403a" font-size="21"><text x="57" y="177">MẶT HÀNG</text><text x="708" y="177" text-anchor="end">SL</text><text x="985" y="177" text-anchor="end">THÀNH TIỀN</text></g>
    ${rows}${wrinkles}
    <path d="M48 ${totalY - 27} H992" stroke="#62665e" stroke-width="2"/>
    <g fill="#222720" font-size="31" font-weight="700"><text x="57" y="${totalY + 18}">TỔNG CỘNG</text><text x="985" y="${totalY + 18}" text-anchor="end">${money(truth.totalAmountVnd)} VND</text></g>
    <text x="520" y="${height - 46}" text-anchor="middle" font-size="19" fill="#676b62">SYNTHETIC QA - SEED ${seed}</text>
  </svg>`;
  let image = sharp(Buffer.from(svg)).resize({ width: config.width }).rotate(config.rotation, { background: '#ece9e0' });
  if (config.name === 'synthetic_veryhard') image = image.blur(0.8).linear(0.73, 34);
  else if (config.name === 'synthetic_hard') image = image.linear(0.86, 18);
  const original = config.quality ? await image.jpeg({ quality: config.quality }).toBuffer() : await image.png().toBuffer();
  const originalExt = config.quality ? '.jpg' : '.png';
  const currentJpeg = await sharp(original).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  const meta = await sharp(original).metadata();
  const keepOriginal = Math.max(meta.width, meta.height) <= 2000 && currentJpeg.length >= original.length;
  const variants = {
    original: [original, originalExt],
    current_2000_q82: [keepOriginal ? original : currentJpeg, keepOriginal ? originalExt : '.jpg'],
    candidate_2400_q90: [await sharp(original).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer(), '.jpg'],
    lossless_png: [await sharp(original).rotate().png({ compressionLevel: 9 }).toBuffer(), '.png'],
  };
  for (const [variant, [bytes, extension]] of Object.entries(variants)) {
    const path = join(output, `${config.name}_${variant}${extension}`);
    await writeFile(path, bytes, { mode: 0o600 });
    const dimensions = await sharp(bytes).metadata();
    prepared.cases.push({ case: config.name, variant, path, bytes: bytes.length,
      width: dimensions.width, height: dimensions.height, sha256: sha256(bytes) });
  }
}
await writeFile(join(output, 'prepared.synthetic.json'), `${JSON.stringify(prepared, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`Generated ${cases.length} synthetic receipts and ${prepared.cases.length} image variants in ${output}.\n`);
