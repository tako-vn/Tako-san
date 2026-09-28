import { Context, Hono } from 'hono';
import { InventoryWriterAuthorityError, InventoryWriterSnapshotError, readInventoryAuthorityMode, readLegacyInventoryRevision, runLegacyInventoryBatch } from '../../../packages/db/src/inventory-writer-fence';
import { composeInventoryLotCommands, readAdoptedLotSnapshot, type LotCommandSpec } from '../../../packages/db/src/inventory-lot-commands';
import { LotCommandError, type InventoryScanEvidence } from '../../../packages/domain/src/inventory-lot-commands';
import { inventoryAuthorityFailure } from '../utils/inventory-authority';
import {
  lotExpiryFromEvidence, rawEvidenceAbsent, rawScanEvidence, receiptLineFacts, reviewedScanExpiry,
  scanCorrectionLine, scanProvenance,
  type ExpiryBasis, type ScanProvenanceType,
} from '../utils/scan-evidence';
import { buildInventoryObservation, guardedObservationInsertStatement } from '../../../packages/db/src/inventory-observations';
import { ObservationError } from '../../../packages/domain/src/inventory-observations';
import { Env, AuthContext } from '../types';
import { AIRouter } from '@frigo/ai';
import { SQL } from '@frigo/db';
import {
  areUnitsCompatible,
  computeFreshness,
  convertUnit,
  findCanonicalIngredient,
  findCanonicalIngredientById,
  StandardUnit,
} from '@frigo/domain';
import { tenancyGuard } from '../middleware/tenancy';
import { rateLimiter } from '../middleware/rate-limit';
import { ScanConfirmSchema } from '../validation/schemas';
import { fetchHouseholdInventoryFromDb } from './inventory';
import { getScanQuota, reserveScanQuota, finalizeScanQuota, type ScanReservationSpec } from '../services/scan-quota';
import { ensureScanQueueIntent } from '../services/scan-queue';
import { sha256Hex } from '../utils/session';
import { aiConfigFromEnv, logAIUsage } from '../config/ai';

export const scanRoutes = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

const RETRYABLE_SCAN_CODES = new Set([
  'REQUEST_TIMEOUT',
  'AI_SCAN_TIMEOUT',
  'NETWORK_ERROR',
  'RATE_LIMITED',
  'UPSTREAM_ERROR',
  'AI_SCAN_UNAVAILABLE',
]);

function scanFailureCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  const message = error instanceof Error ? error.message : String(error);
  const explicit = message.match(/\b(?:AI_SCAN_[A-Z_]+|AI_BUDGET_EXCEEDED|AI_ESCALATION_EXHAUSTED|AI_UNAVAILABLE|AI_IMAGE_TOO_LARGE|UNSUPPORTED_REQUEST_OPTION|REQUEST_TIMEOUT|NETWORK_ERROR|RATE_LIMITED|UPSTREAM_ERROR|MODEL_NOT_FOUND|AUTHENTICATION_FAILED|PERMISSION_DENIED|LICENSE_REQUIRED|INVALID_RESPONSE|SCHEMA_VALIDATION|IMAGE_NOT_FOUND|IMAGE_UNAVAILABLE)\b/);
  if (explicit?.[0]) return explicit[0];
  if (/timeout|timed out|abort/i.test(message)) return 'REQUEST_TIMEOUT';
  if (/network|fetch failed|connection reset|econn/i.test(message)) return 'NETWORK_ERROR';
  if (/\b429\b|rate limit/i.test(message)) return 'RATE_LIMITED';
  if (/\b5\d\d\b|upstream|service unavailable/i.test(message)) return 'UPSTREAM_ERROR';
  return 'AI_SCAN_UNAVAILABLE';
}

// scan_items.confidence is NOT NULL with a historical 0.9 default, so it
// cannot represent "the provider reported no confidence". T13 keeps writing it
// for legacy readers but treats ocr_confidence (nullable) as the truth.
const LEGACY_CONFIDENCE_FILLER = 0.9;

// T09 bounds a lot-command client key at 200 characters. A receipt scan id is
// itself a 64-char digest and the generated lot id embeds it, so the composed
// key `scan-confirm:<scanId>:<lotId>:<suffix>` overflowed that bound and the
// authority rejected the whole confirmation with INVALID_COMMAND. The key must
// stay DETERMINISTIC (replay identity depends on it), so an over-long key is
// collapsed into a stable digest of itself rather than truncated — truncation
// could make two different lots share one key and therefore one command.
const MAX_LOT_CLIENT_KEY = 200;

async function scanCommandKey(scanId: string, itemId: string, suffix: 'create' | 'correct'): Promise<string> {
  const key = `scan-confirm:${scanId}:${itemId}:${suffix}`;
  if (key.length <= MAX_LOT_CLIENT_KEY) return key;
  const digest = await sha256Hex(key);
  return `scan-confirm:${digest}:${suffix}`;
}

// Observation source refs are bounded at 200 characters by the T10 contract
// and carry observation identity, so they are collapsed the same way: a stable
// digest instead of a truncation that could collide two different lines.
const MAX_OBSERVATION_SOURCE_REF = 200;

export async function scanObservationSourceRef(scanId: string, lineId: string): Promise<string> {
  const ref = `${scanId}:${lineId}`;
  if (ref.length <= MAX_OBSERVATION_SOURCE_REF) return ref;
  return `${scanId.slice(0, 80)}:${await sha256Hex(ref)}`;
}

// Adopted-household scan confirmation: one atomic batch of canonical lot
// commands plus the reviewed draft writes, the T10 evidence observations and
// the completion-last status flip. Receipts are keyed per scan item so a
// response-loss retry replays the same confirmation identity instead of
// double-adding stock.
//
// T13 authority chain: OCR/vision evidence -> user review -> T10 observation
// -> T09 command -> lots. The observation is evidence, never a second writer:
// it is a plain INSERT into inventory_observations guarded by the same READY
// predicate as every other statement in the batch, so evidence and stock
// commit together or not at all.
async function confirmAdoptedScan(c: Context<{ Bindings: Env; Variables: { auth: AuthContext } }>, db: any,
  kv: any, auth: AuthContext, scanId: string, plan: {
    selectedIds: string[];
    batchStatements: any[];
    updates: Map<string, { id: string; quantityDelta: number; unit: string }>;
    inserts: Array<{ id: string; quantity: number; unit: string; expiryDate: string; ingredientId: string | null; name: string; storage: string; expiryBasis: ExpiryBasis; lineIds: string[] }>;
    provenance: ScanProvenanceType;
    evidenceByItemId: Map<string, InventoryScanEvidence>;
    purchase: { purchasedAt: string | null; purchasePriceFor: (lineIds: string[]) => { currency: 'VND'; amountMinor: number; minorDigits: 0 } | null };
    observations: Array<{ sourceRef: string; ingredientId: string | null; rawName: string | null;
      legacyItemId: string | null; quantity: number; unit: string; storage: 'fridge' | 'freezer' | 'pantry';
      expiryDate: string | null; expiryBasis: ExpiryBasis; note: string | null }>;
    readyGuard: { sql: string; bindings: unknown[] };
  }) {
  const scope = { householdId: auth.householdId, actorId: auth.userId };
  try {
    const snapshot = await readAdoptedLotSnapshot(db, scope);
    const now = new Date().toISOString();
    const specs: LotCommandSpec[] = [];
    for (const update of plan.updates.values()) {
      const mapped = snapshot.lots.find((entry) => entry.legacyItemId === update.id);
      const row = snapshot.legacyRows.find((candidate) => candidate.id === update.id);
      if (!mapped || !row) throw new LotCommandError('ADOPTION_REQUIRED');
      specs.push({
        clientKey: await scanCommandKey(scanId, update.id, 'correct'),
        input: {
          type: 'CORRECT', lotId: mapped.lot.id, expectedVersion: mapped.lot.version,
          changes: { quantity: Number(row.quantity) + update.quantityDelta, unit: update.unit },
          reason: 'Xác nhận từ nhận diện thông minh',
          revive: mapped.lot.state !== 'ACTIVE',
          scanEvidence: plan.evidenceByItemId.get(update.id),
        },
      });
    }
    for (const insert of plan.inserts) {
      const location = snapshot.locations.find((entry) => entry.isDefault
        && entry.type.toLowerCase() === insert.storage);
      if (!location) throw new LotCommandError('DRIFT_DETECTED');
      // Expiry truth: a user-supplied date is KNOWN; an inferred shelf-life
      // date is ESTIMATED; no basis is UNKNOWN. Never silently upgraded.
      const expiry = lotExpiryFromEvidence(insert.expiryDate, insert.expiryBasis);
      specs.push({
        clientKey: await scanCommandKey(scanId, insert.id, 'create'),
        input: {
          type: 'CREATE', lotId: insert.id, ingredientId: insert.ingredientId, rawName: insert.name,
          quantity: insert.quantity, unit: insert.unit, storageLocationId: location.id,
          expiryAt: expiry.expiryAt, estimatedExpiryAt: expiry.estimatedExpiryAt,
          expiryKind: expiry.expiryKind,
          // Real receipt facts only; absent facts stay null rather than
          // becoming 0₫ or "purchased today".
          purchasedAt: plan.purchase.purchasedAt, openedAt: null,
          purchasePrice: plan.purchase.purchasePriceFor(insert.lineIds),
          // Authoritative server-side provenance: receipts are RECEIPT, fridge
          // photos are SCAN. Never inferred from client-supplied text.
          sourceType: plan.provenance, sourceId: scanId,
          scanEvidence: plan.evidenceByItemId.get(insert.id),
        },
      });
    }
    const composed = await composeInventoryLotCommands(db, scope, specs, now);
    const observationStatements = plan.observations.map((observation) => {
      const expiry = lotExpiryFromEvidence(observation.expiryDate, observation.expiryBasis);
      const expiryClaim = expiry.expiryKind === 'KNOWN'
        ? { expiryDate: expiry.expiryAt, expiryKind: 'KNOWN' as const }
        : expiry.expiryKind === 'ESTIMATED'
          ? { expiryDate: expiry.estimatedExpiryAt, expiryKind: 'ESTIMATED' as const }
          : { expiryDate: null, expiryKind: null };
      const built = buildInventoryObservation(scope, {
        sourceType: plan.provenance,
        sourceRef: observation.sourceRef,
        observedAt: now,
        ingredientId: observation.ingredientId,
        rawName: observation.rawName,
        lotId: null,
        legacyItemId: observation.legacyItemId,
        // The user reviewed and confirmed these values in the review UI; an
        // inferred expiry keeps the claim ESTIMATED instead.
        evidence: expiry.expiryKind === 'ESTIMATED' ? 'ESTIMATED' : 'CONFIRMED',
        note: observation.note,
        claim: {
          quantity: observation.quantity, unit: observation.unit as any,
          quantityMilli: null, canonicalUnit: null,
          storage: observation.storage, openedAt: null, ...expiryClaim,
        },
      }, snapshot.inventoryVersion, now);
      return guardedObservationInsertStatement(db, built, plan.readyGuard.sql, plan.readyGuard.bindings);
    });
    const statusStatement = db
      .prepare(
        `UPDATE scans SET status = 'confirmed', updated_at = datetime('now')
         WHERE id = ? AND household_id = ? AND status = 'ready'`
      )
      .bind(scanId, auth.householdId);
    const results = await db.batch([...composed.statements, ...plan.batchStatements,
      ...observationStatements, statusStatement]);
    const statusResult = results[results.length - 1] as any;
    if (statusResult?.meta?.changes !== 1) {
      const committed = await db
        .prepare('SELECT status FROM scans WHERE id = ? AND household_id = ?')
        .bind(scanId, auth.householdId)
        .first();
      if ((committed as any)?.status === 'confirmed') {
        const updatedList = await fetchHouseholdInventoryFromDb(db, auth.householdId, kv, { strict: true, actorId: auth.userId });
        return c.json({
          success: true, idempotentReplay: true, message: 'Bản quét này đã được xác nhận trước đó',
          inventoryCount: updatedList.length, items: updatedList,
        });
      }
      throw new Error('Scan confirmation state transition did not commit');
    }
    if (kv) await kv.delete(`inv_${auth.householdId}`).catch(() => {});
    const updatedList = await fetchHouseholdInventoryFromDb(db, auth.householdId, kv, { strict: true, actorId: auth.userId });
    return c.json({
      success: true, message: 'Đã cập nhật nguyên liệu vào tủ lạnh thành công',
      inventoryCount: updatedList.length, items: updatedList, confirmedItemIds: plan.selectedIds,
    });
  } catch (error: any) {
    // A committed twin can win after our READY read. Recover through the same
    // status-based replay contract, never by retrying the stock writes.
    try {
      const committed = await db.prepare('SELECT status FROM scans WHERE id = ? AND household_id = ?')
        .bind(scanId, auth.householdId).first();
      if (committed?.status === 'confirmed') {
        const updatedList = await fetchHouseholdInventoryFromDb(db, auth.householdId, kv,
          { strict: true, actorId: auth.userId });
        return c.json({ success: true, idempotentReplay: true,
          message: 'Bản quét này đã được xác nhận trước đó', inventoryCount: updatedList.length, items: updatedList });
      }
    } catch (recoveryError) {
      error = recoveryError;
    }
    if (error instanceof LotCommandError) {
      const failure = inventoryAuthorityFailure(error);
      return c.json({ error: error.message, code: failure.code }, failure.status);
    }
    if (error instanceof ObservationError) {
      // Evidence that cannot be represented must not silently vanish while the
      // stock command commits; the whole confirmation fails closed instead.
      return c.json({ error: 'Không thể ghi nhận bằng chứng từ bản quét', code: 'INVALID_OBSERVATION' }, 422);
    }
    console.error('Adopted scan confirmation failed:', error);
    return c.json({ error: 'Lỗi xác nhận đưa nguyên liệu vào tủ lạnh', code: 'DATABASE_ERROR' }, 500);
  }
}

function assertBatchSucceeded(results: any[] | undefined): void {
  if (results?.some((result) => result && result.success === false)) {
    throw new Error('D1 batch reported an unsuccessful statement');
  }
}

const STANDARD_UNITS = new Set<StandardUnit>([
  'g',
  'kg',
  'ml',
  'l',
  'piece',
  'pack',
  'bunch',
  'slice',
]);

function isStandardUnit(value: unknown): value is StandardUnit {
  return typeof value === 'string' && STANDARD_UNITS.has(value as StandardUnit);
}

/** Error raised while reconciling client review data with persisted scan rows. */
export class ScanConfirmationError extends Error {
  constructor(
    readonly code: 'INVALID_SCAN_ITEM' | 'DUPLICATE_SCAN_ITEM' | 'UNIT_MISMATCH' | 'INVALID_QUANTITY',
    message: string,
    readonly status = code === 'UNIT_MISMATCH' ? 422 : 400
  ) {
    super(message);
    this.name = 'ScanConfirmationError';
  }
}

export interface PersistedScanItem {
  id: string;
  raw_name: string;
  canonical_id?: string | null;
  estimated_quantity: number;
  unit: string;
  category?: string | null;
  storage?: string | null;
  is_confirmed?: number | boolean | null;
  unit_price_vnd?: number | null;
  total_price_vnd?: number | null;
  ocr_raw_name?: string | null;
  ocr_quantity?: number | null;
  ocr_unit?: string | null;
  ocr_canonical_id?: string | null;
  ocr_category?: string | null;
  ocr_storage?: string | null;
}

export interface ResolvedScanItem {
  /** ID of the persisted prediction; undefined for a user-added row. */
  sourceId?: string;
  /** Stable client ID for a manual row, when supplied. */
  clientId?: string;
  name: string;
  quantity: number;
  unit: StandardUnit;
  canonicalId: string | null;
  category: string;
  storage: 'fridge' | 'freezer' | 'pantry';
  expiryDate?: string;
  /** How the confirmed expiry was established; decides KNOWN vs ESTIMATED. */
  expiryBasis: ExpiryBasis;
  /** The reviewer explicitly rejected this line; it must not become stock. */
  rejected: boolean;
  isManual: boolean;
}

/**
 * Convert a reviewed scan quantity into the unit used by an existing stock
 * row.  Returning the original number for incompatible units would silently
 * corrupt inventory (for example, treating 500g as 500 pieces), so this
 * helper fails closed instead.
 */
export function convertScanQuantity(quantity: number, from: StandardUnit, to: StandardUnit): number {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new ScanConfirmationError('INVALID_QUANTITY', 'Số lượng nguyên liệu không hợp lệ');
  }
  if (!areUnitsCompatible(from, to)) {
    throw new ScanConfirmationError(
      'UNIT_MISMATCH',
      `Không thể quy đổi đơn vị ${from} sang ${to}`
    );
  }
  const converted = convertUnit(quantity, from, to);
  if (!Number.isFinite(converted) || converted <= 0) {
    throw new ScanConfirmationError('INVALID_QUANTITY', 'Số lượng nguyên liệu không hợp lệ');
  }
  return converted;
}

function normalizeStorage(value: unknown): 'fridge' | 'freezer' | 'pantry' {
  return value === 'freezer' || value === 'pantry' ? value : 'fridge';
}

function publicScanErrorMessage(code: unknown): string | undefined {
  switch (code) {
    case 'AI_SCAN_NO_USABLE_ITEMS':
      return 'Không nhận diện được dữ liệu đủ rõ từ ảnh. Vui lòng chụp lại gần hơn, đủ sáng và không bị lóa.';
    case 'AI_SCAN_TIMEOUT':
    case 'REQUEST_TIMEOUT':
      return 'Dịch vụ nhận diện phản hồi quá lâu. Vui lòng thử lại với ảnh nhỏ và rõ hơn.';
    case 'NETWORK_ERROR':
    case 'RATE_LIMITED':
    case 'UPSTREAM_ERROR':
      return 'Dịch vụ nhận diện đang bận hoặc mất kết nối. Vui lòng thử lại sau ít phút.';
    case 'AI_SCAN_UNAVAILABLE':
    case 'AI_UNAVAILABLE':
    case 'AI_ESCALATION_EXHAUSTED':
    case 'AI_PROVIDER_MODEL_UNAVAILABLE':
    case 'AI_PROVIDER_AUTH':
    case 'AI_PROVIDER_LICENSE':
    case 'UNSUPPORTED_REQUEST_OPTION':
    case 'MODEL_NOT_FOUND':
    case 'AUTHENTICATION_FAILED':
    case 'PERMISSION_DENIED':
    case 'LICENSE_REQUIRED':
      return 'Dịch vụ nhận diện đang tạm thời không khả dụng. Vui lòng thử lại sau hoặc nhập thủ công.';
    case 'AI_IMAGE_TOO_LARGE':
      return 'Ảnh quá lớn để xử lý nhanh. Vui lòng chọn ảnh nhỏ hơn 5MB hoặc chụp lại với độ phân giải thấp hơn.';
    case 'INVALID_RESPONSE':
    case 'SCHEMA_VALIDATION':
      return 'Không nhận diện được dữ liệu đủ rõ từ ảnh. Vui lòng chụp lại gần hơn, đủ sáng và không bị lóa.';
    case 'IMAGE_NOT_FOUND':
    case 'IMAGE_UNAVAILABLE':
      return 'Ảnh quét không còn khả dụng. Vui lòng tải lên ảnh mới.';
    case 'MAX_ATTEMPTS_EXCEEDED':
      return 'Bản quét đã hết số lần xử lý tự động. Vui lòng thử lại với ảnh mới.';
    case 'RESERVATION_EXPIRED':
      return 'Bản quét đã hết thời gian chờ xử lý. Vui lòng gửi lại ảnh để tạo bản quét mới.';
    default:
      return code ? 'Không thể xử lý bản quét. Vui lòng thử lại với ảnh rõ hơn.' : undefined;
  }
}

function scanFailureStatus(code: string): 400 | 413 | 422 | 429 | 500 | 503 | 504 {
  if (code === 'RATE_LIMITED') return 429;
  if (code === 'REQUEST_TIMEOUT' || code === 'AI_SCAN_TIMEOUT') return 504;
  if (code === 'AI_SCAN_NO_USABLE_ITEMS' || code === 'INVALID_RESPONSE' || code === 'SCHEMA_VALIDATION') return 422;
  if (code === 'IMAGE_NOT_FOUND' || code === 'IMAGE_UNAVAILABLE') return 400;
  if (code === 'AI_BUDGET_EXCEEDED') return 422;
  if (code === 'AI_IMAGE_TOO_LARGE') return 413;
  if (RETRYABLE_SCAN_CODES.has(code) || code === 'MODEL_NOT_FOUND' || code === 'UNSUPPORTED_REQUEST_OPTION' || code === 'AUTHENTICATION_FAILED' ||
      code === 'PERMISSION_DENIED' || code === 'LICENSE_REQUIRED' || code === 'RESERVATION_EXPIRED') return 503;
  return 500;
}

function withScanTimeout<T>(operation: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`REQUEST_TIMEOUT: ${timeoutMessage}`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Hydrate a confirmation payload against the scan snapshot.  AI rows must use
 * an ID belonging to this scan; only explicit draft IDs (or rows without an
 * ID) are treated as manual additions.  This prevents a caller from smuggling
 * arbitrary scan IDs into another scan while retaining the review UI's
 * add-manual-item affordance.
 */
export function resolveScanConfirmationItems(
  persistedItems: readonly PersistedScanItem[],
  submittedItems: readonly any[]
): ResolvedScanItem[] {
  const byId = new Map(persistedItems.map((item) => [item.id, item]));
  const seenIds = new Set<string>();

  return submittedItems.map((submitted, index) => {
    const submittedId = typeof submitted?.id === 'string' ? submitted.id.trim() : '';
    if (submittedId && seenIds.has(submittedId)) {
      throw new ScanConfirmationError(
        'DUPLICATE_SCAN_ITEM',
        `Nguyên liệu bị lặp trong yêu cầu xác nhận: ${submittedId}`
      );
    }
    if (submittedId) seenIds.add(submittedId);

    const persisted = submittedId ? byId.get(submittedId) : undefined;
    const isManual = !persisted;
    if (submittedId && !persisted && !submittedId.startsWith('draft_')) {
      throw new ScanConfirmationError(
        'INVALID_SCAN_ITEM',
        'Nguyên liệu xác nhận không thuộc bản quét này'
      );
    }
    const alreadyConfirmed =
      persisted?.is_confirmed === true || Number(persisted?.is_confirmed) === 1;
    if (alreadyConfirmed) {
      throw new ScanConfirmationError(
        'INVALID_SCAN_ITEM',
        'Nguyên liệu trong bản quét đã được xác nhận trước đó',
        409
      );
    }

    const name = String(
      submitted?.rawName ?? submitted?.name ?? persisted?.raw_name ?? ''
    ).trim();
    if (!name) {
      throw new ScanConfirmationError('INVALID_SCAN_ITEM', `Nguyên liệu thứ ${index + 1} cần có tên`);
    }

    const canonicalFromName = findCanonicalIngredient(name);
    const canonicalFromPayload = submitted?.canonicalId
      ? findCanonicalIngredient(String(submitted.canonicalId))
      : null;
    const canonicalFromScan = persisted?.canonical_id
      ? findCanonicalIngredientById(persisted.canonical_id)
      : null;
    // A user-edited name is authoritative; otherwise retain the scan's
    // canonical mapping, then accept a valid explicit canonicalId.
    const canonical = canonicalFromName || canonicalFromScan || canonicalFromPayload;

    const rawQuantity = submitted?.estimatedQuantity ?? submitted?.quantity ?? persisted?.estimated_quantity ?? 1;
    const quantity = Number(rawQuantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new ScanConfirmationError('INVALID_QUANTITY', `Số lượng của ${name} không hợp lệ`);
    }

    const candidateUnit = submitted?.unit ?? persisted?.unit ?? canonical?.defaultUnit ?? 'piece';
    if (!isStandardUnit(candidateUnit)) {
      throw new ScanConfirmationError('INVALID_SCAN_ITEM', `Đơn vị của ${name} không hợp lệ`);
    }

    const category = String(
      submitted?.category ?? persisted?.category ?? canonical?.category ?? 'other'
    ).trim() || 'other';

    return {
      sourceId: persisted?.id,
      clientId: submittedId || undefined,
      name,
      quantity,
      unit: candidateUnit,
      canonicalId: canonical?.id || null,
      category,
      storage: normalizeStorage(submitted?.storage ?? persisted?.storage),
      expiryDate: submitted?.expiryDate,
      // A date the reviewer picked is a supplied fact; a day-chip estimate is
      // explicitly flagged by the client and stays ESTIMATED. Absence is
      // absence — the caller never turns it into a KNOWN date.
      expiryBasis: submitted?.expiryDate
        ? (submitted?.expiryEstimated === true ? 'inferred' : 'supplied')
        : 'absent',
      rejected: submitted?.rejected === true,
      isManual,
    };
  });
}

function hashScanPart(value: string): string {
  // Small deterministic hash keeps generated D1 IDs stable across retries
  // without embedding user-controlled names or relying on random IDs.
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableScanPart(item: ResolvedScanItem, index: number): string {
  const source = item.sourceId || item.clientId;
  if (source) {
    const safe = source.replace(/[^A-Za-z0-9_-]/g, '_');
    // Truncation must not destroy identity. A real receipt scan id is a
    // 64-char digest, so `receipt_item_<scanId>_<n>` exceeds 80 characters and
    // every line of one receipt used to truncate to the SAME id — the lots
    // then collided and the confirmation failed with LOT_EXISTS. Keep a
    // deterministic, collision-resistant suffix instead of a blind prefix.
    if (safe.length <= 80) return safe;
    return `${safe.slice(0, 60)}_${hashScanPart(safe)}`;
  }
  return `manual_${index}_${hashScanPart(`${item.name}|${item.quantity}|${item.unit}`)}`;
}

/**
 * Review DTO for one scan line. Surfaces what is actually known: the retained
 * raw extraction, the model's own confidence (null when it reported none — the
 * UI must show "unknown", never a fabricated high score), and the explicit
 * review lifecycle including rejection.
 */
export function scanItemDto(row: any, scanId: string) {
  const raw = rawScanEvidence(row);
  const reviewState = row.review_state === 'CONFIRMED' || row.review_state === 'REJECTED'
    ? row.review_state : 'PENDING';
  // T13R-A P2-B: the expiry the reviewer accepted, exposed only for a
  // CONFIRMED line and in the exact shape the review UI submits, so a
  // reopened review hydrates KNOWN/ESTIMATED/UNKNOWN faithfully.
  const reviewedExpiry = reviewState === 'CONFIRMED' ? reviewedScanExpiry(row) : null;
  return {
    id: row.id,
    scanId: row.scan_id ?? scanId,
    rawName: row.raw_name,
    canonicalId: row.canonical_id,
    estimatedQuantity: row.estimated_quantity,
    unit: row.unit,
    // Truthful confidence: undefined when the provider reported none.
    confidence: row.ocr_confidence == null ? undefined : Number(row.ocr_confidence),
    category: row.category,
    storage: row.storage,
    isConfirmed: Boolean(row.is_confirmed),
    reviewState,
    unitPriceVnd: row.unit_price_vnd == null ? undefined : Number(row.unit_price_vnd),
    totalPriceVnd: row.total_price_vnd == null ? undefined : Number(row.total_price_vnd),
    ...(reviewedExpiry ?? {}),
    // Raw extraction kept separable from the confirmed value so a correction
    // can still be explained after the fact.
    rawEvidence: rawEvidenceAbsent(raw) ? undefined : {
      rawName: raw.rawName ?? undefined,
      estimatedQuantity: raw.quantity ?? undefined,
      unit: raw.unit ?? undefined,
      canonicalId: raw.canonicalId ?? undefined,
      category: raw.category ?? undefined,
      storage: raw.storage ?? undefined,
    },
  };
}

// Enforce multi-tenancy on all scan routes
scanRoutes.use('/scans*', tenancyGuard);

// Rate limit AI vision operations (max 12 per minute)
scanRoutes.use('/scans/fridge', rateLimiter({ maxRequests: 12, windowSeconds: 60, prefix: 'rl_scan' }));
scanRoutes.use('/scans/receipt', rateLimiter({ maxRequests: 12, windowSeconds: 60, prefix: 'rl_receipt' }));

// Helper to init AI Router with Cloudflare Workers AI GPU binding
function getAIRouter(env: Env, backgroundExecutor?: (promise: Promise<unknown>) => void) {
  return new AIRouter(aiConfigFromEnv(env, backgroundExecutor), logAIUsage);
}

// Keep the HTTP rejection aligned with the runtime's configured image budget.
function validateBase64Payload(base64: string, maxBytes = 5 * 1024 * 1024): { valid: boolean; error?: string } {
  if (!base64) return { valid: false, error: 'Vui lòng tải lên một ảnh để quét' };
  // Approximate size in bytes: length * (3/4)
  const estimatedBytes = (base64.length * 3) / 4;
  if (estimatedBytes > maxBytes) {
    const limitLabel = maxBytes >= 1024 * 1024
      ? `${Math.round(maxBytes / (1024 * 1024))}MB`
      : `${Math.round(maxBytes / 1024)}KiB`;
    return { valid: false, error: `Dung lượng ảnh vượt quá giới hạn cho phép (tối đa ${limitLabel})` };
  }
  return { valid: true };
}

function configuredImageLimit(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed)
    ? Math.min(20 * 1024 * 1024, Math.max(64 * 1024, parsed))
    : 5 * 1024 * 1024;
}

type NormalizedImagePayload = {
  base64: string;
  mimeType: string;
  bytes: Uint8Array;
  dataUrl: string;
};

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Normalize data URLs and raw base64 so retries hash the same bytes. */
function normalizeImagePayload(value: unknown): NormalizedImagePayload | null {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (!input) return null;
  const dataUrl = input.match(/^data:(image\/[A-Za-z0-9.+-]+);base64,([\s\S]*)$/i);
  const mimeType = (dataUrl?.[1] || 'image/jpeg').toLowerCase();
  const encoded = (dataUrl?.[2] || input).replace(/\s+/g, '');
  if (!encoded) return null;
  try {
    const bytes = decodeBase64(encoded);
    if (bytes.length === 0) return null;
    const canonicalBase64 = encodeBase64(bytes);
    return {
      base64: canonicalBase64,
      mimeType,
      bytes,
      dataUrl: `data:${mimeType};base64,${canonicalBase64}`,
    };
  } catch {
    return null;
  }
}

async function scanRequestFingerprint(
  scanType: 'fridge' | 'food' | 'receipt',
  image: Pick<NormalizedImagePayload, 'mimeType' | 'base64'>,
): Promise<string> {
  // Include the operation and MIME so the same idempotency key cannot replay
  // a receipt as a fridge scan or reinterpret identical bytes as another type.
  return sha256Hex(`${scanType}\n${image.mimeType}\n${image.base64}`);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function imageFromBytes(bytes: Uint8Array, mimeType: string): NormalizedImagePayload {
  const base64 = encodeBase64(bytes);
  const normalizedMime = mimeType.toLowerCase() || 'image/jpeg';
  return { base64, mimeType: normalizedMime, bytes, dataUrl: `data:${normalizedMime};base64,${base64}` };
}

function scanReservationSpec(
  imageKey: string | null,
  scanType: 'fridge' | 'food' | 'receipt',
  image: Pick<NormalizedImagePayload, 'mimeType'>,
  requestFingerprint: string,
): ScanReservationSpec {
  return { imageKey, scanType, imageMimeType: image.mimeType, requestFingerprint };
}

async function persistScanFailure(
  db: Env['DB'],
  scanId: string,
  auth: AuthContext,
  code: string,
): Promise<void> {
  try {
    await db.prepare(
      `UPDATE scans SET status = 'failed', updated_at = datetime('now')
       WHERE id = ? AND user_id = ? AND household_id = ? AND status IN ('pending', 'processing')`,
    ).bind(scanId, auth.userId, auth.householdId).run();
    // A queue row may already exist after an ambiguous enqueue. Keep its
    // durable error metadata aligned with the scan when present.
    await db.prepare(
      `UPDATE scan_queue_jobs SET status = 'failed', error_code = ?, error_message = ?,
         completed_at = datetime('now'), updated_at = datetime('now')
       WHERE scan_id = ? AND status IN ('pending', 'processing')`,
    ).bind(code, publicScanErrorMessage(code) || 'Không thể xử lý bản quét.', scanId).run().catch(() => {});
  } catch {
    // The original provider error remains the useful response; failure to
    // record a terminal status is surfaced by the next idempotent replay.
  }
}

async function scanCommand(c: Context<{ Bindings: Env; Variables: { auth: AuthContext } }>, scanType: string) {
  const key = c.req.header('Idempotency-Key');
  if (key !== undefined && !/^[A-Za-z0-9:_-]{1,128}$/.test(key)) return null;
  const auth = c.get('auth');
  const digest = key ? await sha256Hex(JSON.stringify([auth.userId, auth.householdId, key])) : crypto.randomUUID();
  const scanId = `${scanType === 'receipt' ? 'receipt' : 'scan'}_${digest}`;
  return { scanId, idempotencyKey: key ? `scan-command:${digest}` : `scan:${scanId}:v1` };
}

async function recoverScan(
  c: Context<{ Bindings: Env; Variables: { auth: AuthContext } }>,
  scanId: string,
  scanType: 'fridge' | 'food' | 'receipt',
  idempotencyKey: string,
  reservationId: string,
  image: NormalizedImagePayload,
  requestFingerprint: string,
) {
  const auth = c.get('auth');
  const row: any = await c.env.DB.prepare('SELECT * FROM scans WHERE id = ? AND user_id = ? AND household_id = ?')
    .bind(scanId, auth.userId, auth.householdId).first();
  if (!row) {
    // A quota row without its scan record is a data-integrity failure. Never
    // fabricate a pending DTO because clients would poll an ID that cannot be
    // processed by the queue.
    return c.json({ error: 'Bản quét chưa được lưu đầy đủ, vui lòng thử lại', code: 'SCAN_RECORD_MISSING' }, 503);
  }
  if (row.scan_type !== scanType) {
    return c.json({ error: 'Idempotency key đã được sử dụng', code: 'IDEMPOTENCY_CONFLICT' }, 409);
  }

  let replayImage = image;
  const persistedMime = typeof row.image_mime_type === 'string' && row.image_mime_type
    ? row.image_mime_type.toLowerCase()
    : null;
  if (row.request_fingerprint && row.request_fingerprint !== requestFingerprint) {
    return c.json({ error: 'Idempotency key đã được sử dụng cho ảnh khác', code: 'IDEMPOTENCY_CONFLICT' }, 409);
  }
  if (persistedMime && persistedMime !== image.mimeType) {
    return c.json({ error: 'Idempotency key đã được sử dụng với MIME khác', code: 'IDEMPOTENCY_CONFLICT' }, 409);
  }

  // Legacy rows created before migration 0023 have no fingerprint. They are
  // replayable only when their original R2 object can be read and verified.
  if (!row.request_fingerprint) {
    if (!row.image_key || !c.env.IMAGES) {
      return c.json({ error: 'Không thể xác minh ảnh của bản quét cũ', code: 'IDEMPOTENCY_REPLAY_UNVERIFIABLE' }, 409);
    }
    const original = await c.env.IMAGES.get(row.image_key);
    if (!original) {
      return c.json({ error: 'Ảnh bản quét không còn khả dụng', code: 'IMAGE_NOT_FOUND' }, 400);
    }
    const originalMime = original.httpMetadata?.contentType || persistedMime || image.mimeType;
    replayImage = imageFromBytes(new Uint8Array(await original.arrayBuffer()), originalMime);
    const originalFingerprint = await scanRequestFingerprint(scanType, replayImage);
    if (originalFingerprint !== requestFingerprint) {
      return c.json({ error: 'Idempotency key đã được sử dụng cho ảnh khác', code: 'IDEMPOTENCY_CONFLICT' }, 409);
    }
    await c.env.DB.prepare(
      `UPDATE scans SET request_fingerprint = ?, image_mime_type = ?, updated_at = datetime('now')
       WHERE id = ? AND user_id = ? AND household_id = ? AND request_fingerprint IS NULL`,
    ).bind(originalFingerprint, replayImage.mimeType, scanId, auth.userId, auth.householdId).run();
  }

  if (row.status === 'failed') {
    const failedJob = await c.env.DB.prepare(
      `SELECT error_code, attempts, max_attempts FROM scan_queue_jobs
       WHERE scan_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
    ).bind(scanId).first<{ error_code: string | null; attempts: number; max_attempts: number }>();
    const code = failedJob?.error_code || 'AI_SCAN_UNAVAILABLE';
    await finalizeScanQuota(c.env.DB, reservationId, 'released');
    return c.json({
      error: publicScanErrorMessage(code) || 'Không thể xử lý bản quét.',
      code,
      retryable: RETRYABLE_SCAN_CODES.has(code),
      scan: { id: scanId, userId: auth.userId, householdId: auth.householdId, scanType, status: 'failed' },
    }, scanFailureStatus(code));
  }

  if (row.status === 'ready' || row.status === 'confirmed') {
    await finalizeScanQuota(c.env.DB, reservationId, 'consumed');
  }

  // A send may have reached the queue even when its response was lost.
  // Redelivery uses the same job; the queue claim fences duplicate processing.
  if (row?.status === 'pending' && c.env.SCAN_QUEUE_MODE === 'async' && c.env.SCAN_QUEUE) {
    const imageKey = row.image_key || null;
    if (imageKey && !c.env.IMAGES) {
      return c.json({ error: 'Ảnh bản quét không còn khả dụng', code: 'IMAGE_UNAVAILABLE' }, 503);
    }
    if (imageKey && c.env.IMAGES) {
      try {
        // Re-upload only after the request fingerprint has matched the
        // persisted command, repairing an ambiguous/expired R2 write safely.
        await c.env.IMAGES.put(imageKey, replayImage.bytes, {
          httpMetadata: { contentType: persistedMime || replayImage.mimeType },
        });
      } catch {
        return c.json({ error: 'Không thể lưu ảnh để xử lý nền', code: 'IMAGE_STORAGE_FAILED' }, 503);
      }
    }
    try {
      await ensureScanQueueIntent(c.env, {
        type: 'scan.process.v1', jobId: `scan_job_${scanId}`, scanId,
        userId: auth.userId, householdId: auth.householdId, scanType,
        imageKey: imageKey || undefined,
        imageBase64: imageKey ? undefined : replayImage.base64,
        mimeType: persistedMime || replayImage.mimeType,
        idempotencyKey,
        requestFingerprint,
      });
      await c.env.SCAN_QUEUE.send({
        type: 'scan.process.v1', jobId: `scan_job_${scanId}`, scanId,
        userId: auth.userId, householdId: auth.householdId, scanType,
        imageKey: imageKey || undefined,
        imageBase64: imageKey ? undefined : replayImage.base64,
        mimeType: persistedMime || replayImage.mimeType,
        idempotencyKey,
        requestFingerprint,
      });
    } catch {
      return c.json({ error: 'Không thể xếp hàng bản quét', code: 'QUEUE_UNAVAILABLE' }, 503);
    }
    // The consumer settles quota in the same fenced batch as the scan result.
  }
  const items = row ? await c.env.DB.prepare(SQL.GET_SCAN_ITEMS).bind(scanId).all() : { results: [] };
  const scan = {
    id: scanId, userId: auth.userId, householdId: auth.householdId,
    scanType, status: row?.status || 'pending', imageKey: row?.image_key,
    createdAt: row?.created_at,
    merchantName: row?.merchant_name, invoiceNumber: row?.invoice_number,
    purchaseDate: row?.purchase_date, totalAmountVnd: row?.total_amount_vnd,
    items: (items.results || []).map((item: any) => scanItemDto(item, scanId)),
  };
  return c.json({ success: true, idempotentReplay: true, scan, ...(scanType === 'receipt' ? { receipt: scan } : {}) },
    ['pending', 'processing'].includes(scan.status) ? 202 : 200);
}

// POST /api/v1/scans/fridge
scanRoutes.post('/scans/fridge', async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const imageInput = typeof body?.imageBase64 === 'string' ? body.imageBase64 : '';
  const scanType = body?.scanType || 'fridge';

  if (scanType !== 'fridge' && scanType !== 'food') {
    return c.json({ error: 'Loại bản quét không hợp lệ', code: 'INVALID_SCAN_TYPE' }, 400);
  }

  if (!db) {
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  const image = normalizeImagePayload(imageInput);
  if (!image) {
    return c.json({ error: 'Vui lòng tải lên một ảnh hợp lệ để quét', code: 'IMAGE_REQUIRED' }, 400);
  }

  // SEC-08 FIX: Check payload size limit before reserving quota.
  const sizeCheck = validateBase64Payload(image.base64, configuredImageLimit(c.env.AI_MAX_IMAGE_BYTES));
  if (!sizeCheck.valid) {
    return c.json({ error: sizeCheck.error, code: 'PAYLOAD_TOO_LARGE' }, 413);
  }

  const command = await scanCommand(c, scanType);
  if (!command) return c.json({ error: 'Invalid idempotency key', code: 'INVALID_IDEMPOTENCY_KEY' }, 400);
  const { scanId, idempotencyKey } = command;
  const imageKey = c.env.IMAGES ? `users/${auth.userId}/scans/${scanId}/original.webp` : null;
  const requestFingerprint = await scanRequestFingerprint(scanType, image);
  const quota = await reserveScanQuota(db, {
    userId: auth.userId,
    householdId: auth.householdId,
    scanId,
    idempotencyKey,
    scan: scanReservationSpec(imageKey, scanType, image, requestFingerprint),
  });
  if (!quota.ok) {
    const status = quota.reason === 'exceeded' ? 429 : quota.reason === 'conflict' ? 409 : 503;
    const quotaState = quota.reason === 'exceeded' ? await getScanQuota(db, auth.userId).catch(() => null) : null;
    return c.json({ error: quota.reason === 'exceeded' ? 'Đã vượt hạn mức quét trong tháng' : quota.reason === 'conflict' ? 'Idempotency key đã được sử dụng cho bản quét khác' : 'Không thể kiểm tra hạn mức quét', code: quota.reason === 'exceeded' ? 'SCAN_QUOTA_EXCEEDED' : quota.reason === 'conflict' ? 'IDEMPOTENCY_CONFLICT' : 'QUOTA_UNAVAILABLE', resetAt: quotaState?.resetAt, quota: quotaState }, status);
  }
  const reservationId = quota.reservation.reservationId;
  if (!quota.acquired) return recoverScan(c, scanId, scanType, idempotencyKey, reservationId, image, requestFingerprint);
  let imageStored = false;

  // R2 upload if configured
  if (c.env.IMAGES) {
    try {
      await c.env.IMAGES.put(imageKey!, image.bytes, {
        httpMetadata: { contentType: image.mimeType },
      });
      imageStored = true;
    } catch {
      console.warn('R2 upload failed');
    }
  }

  // Optional async canary: persist a pending scan and let the durable queue
  // perform vision processing. The default remains synchronous to preserve the
  // existing client response contract until the canary is explicitly enabled.
  if (c.env.SCAN_QUEUE_MODE === 'async' && c.env.SCAN_QUEUE) {
    if (c.env.IMAGES && !imageStored) {
      await persistScanFailure(db, scanId, auth, 'IMAGE_STORAGE_FAILED');
      await finalizeScanQuota(db, reservationId, 'released');
      return c.json({ error: 'Không thể lưu ảnh để xử lý nền', code: 'IMAGE_STORAGE_FAILED' }, 503);
    }
    // Cloudflare Queue messages are intentionally kept small; production has
    // R2 configured, while local canary environments may not. Avoid enqueueing
    // a multi-megabyte base64 body that would be rejected by the platform.
    if (!c.env.IMAGES && image.base64.length > 120_000) {
      await persistScanFailure(db, scanId, auth, 'QUEUE_PAYLOAD_TOO_LARGE');
      await finalizeScanQuota(db, reservationId, 'released');
      return c.json({ error: 'Môi trường xử lý nền cần R2 để lưu ảnh lớn', code: 'QUEUE_PAYLOAD_TOO_LARGE' }, 413);
    }
    try {
      await ensureScanQueueIntent(c.env, {
        type: 'scan.process.v1',
        jobId: `scan_job_${scanId}`,
        scanId,
        userId: auth.userId,
        householdId: auth.householdId,
        scanType: scanType === 'food' ? 'food' : 'fridge',
        imageKey: imageKey || undefined,
        imageBase64: imageKey ? undefined : image.base64,
        mimeType: image.mimeType,
        idempotencyKey,
        requestFingerprint,
      });
    } catch {
      await persistScanFailure(db, scanId, auth, 'DATABASE_ERROR');
      await finalizeScanQuota(db, reservationId, 'released');
      return c.json({ error: 'Không thể lưu yêu cầu xử lý nền', code: 'DATABASE_ERROR' }, 503);
    }
    try {
      await c.env.SCAN_QUEUE.send({
        type: 'scan.process.v1',
        jobId: `scan_job_${scanId}`,
        scanId,
        userId: auth.userId,
        householdId: auth.householdId,
        scanType: scanType === 'food' ? 'food' : 'fridge',
        imageKey: imageKey || undefined,
        imageBase64: imageKey ? undefined : image.base64,
        mimeType: image.mimeType,
        idempotencyKey,
        requestFingerprint,
      });
      // Queue acceptance reserves a slot; only a ready scan consumes it.
      return c.json({
        success: true,
        queued: true,
        scan: { id: scanId, userId: auth.userId, householdId: auth.householdId, imageKey, scanType, status: 'pending', items: [], createdAt: new Date().toISOString() },
      }, 202);
    } catch {
      console.error('Scan queue enqueue failed');
      return c.json({ error: 'Không thể xếp hàng bản quét', code: 'QUEUE_UNAVAILABLE' }, 503);
    }
  }

  // Bound the provider call so a hung request cannot hold the Worker open
  // indefinitely; Qwen full-page OCR/vision may legitimately use most of the
  // 75-second request budget.
  let visionResult;
  try {
    const aiRouter = getAIRouter(c.env, (promise) => c.executionCtx.waitUntil(promise));
    visionResult = await withScanTimeout(
      aiRouter.vision({ imageBase64OrUrl: image.dataUrl, mimeType: image.mimeType }),
      75_000,
      'Phân tích ảnh quá lâu. Vui lòng thử lại.',
    );
  } catch (error) {
    const code = scanFailureCode(error);
    await persistScanFailure(db, scanId, auth, code);
    await finalizeScanQuota(db, reservationId, 'released');
    return c.json({
      error: publicScanErrorMessage(code) || 'Không thể xử lý bản quét.',
      code,
      retryable: RETRYABLE_SCAN_CODES.has(code),
    }, scanFailureStatus(code));
  }

  const scanItems = visionResult.items.map((item, idx) => {
    const canonical = findCanonicalIngredient(item.raw_name);
    const providerCanonical = item.canonical_id
      ? findCanonicalIngredientById(item.canonical_id)
      : null;
    return {
      id: `scan_item_${scanId}_${idx}`,
      scanId,
      rawName: item.raw_name,
      canonicalId: canonical?.id || providerCanonical?.id || null,
      estimatedQuantity: item.estimated_quantity,
      unit: item.unit as StandardUnit,
      confidence: item.confidence,
      category: canonical?.category || item.category || 'other',
      storage: (item.storage || 'fridge') as 'fridge' | 'freezer' | 'pantry',
    };
  });

  const scanRecord = {
    id: scanId,
    userId: auth.userId,
    householdId: auth.householdId,
    imageKey: imageStored ? imageKey : null,
    scanType,
    status: 'ready',
    items: scanItems,
    createdAt: new Date().toISOString(),
  };

  // Persist to D1 with batch operations
  try {
    const statements = [
      db
        .prepare('INSERT OR IGNORE INTO households (id, name, created_by) VALUES (?, ?, ?)')
        .bind(auth.householdId, 'Tủ lạnh gia đình', auth.userId),
      db
        .prepare(`UPDATE scans SET image_key = ?, status = 'ready', scan_type = ?,
          request_fingerprint = ?, image_mime_type = ?, updated_at = datetime('now')
          WHERE id = ? AND user_id = ? AND household_id = ? AND status IN ('pending', 'processing')`)
        .bind(imageStored ? imageKey : null, scanType, requestFingerprint, image.mimeType,
          scanId, auth.userId, auth.householdId),
    ];

    for (const item of scanItems) {
      statements.push(
        db
          .prepare(SQL.INSERT_SCAN_ITEM)
          .bind(
            item.id,
            scanId,
            item.rawName,
            item.canonicalId,
            item.estimatedQuantity,
            item.unit,
            // The legacy NOT NULL column keeps its historical filler; the
            // ocr_* columns carry what the model actually reported.
            item.confidence ?? LEGACY_CONFIDENCE_FILLER,
            item.category,
            item.storage,
            item.rawName,
            item.estimatedQuantity,
            item.unit,
            item.confidence ?? null,
            // T13R-A: the ingested mapping, retained before any review can
            // rewrite the working canonical_id/category/storage.
            item.canonicalId,
            item.category,
            item.storage
          )
      );
    }

    const batchResults = await db.batch(statements);
    assertBatchSucceeded(batchResults);
  } catch (err) {
    console.error('D1 CREATE_SCAN batch failed:', err);
    await persistScanFailure(db, scanId, auth, 'DATABASE_ERROR');
    await finalizeScanQuota(db, reservationId, 'released');
    return c.json({ error: 'Không thể lưu kết quả quét', code: 'DATABASE_ERROR' }, 500);
  }

  await finalizeScanQuota(db, reservationId, 'consumed');

  return c.json({
    success: true,
    scan: scanRecord,
  });
});

// POST /api/v1/scans/receipt
scanRoutes.post('/scans/receipt', async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const imageInput = typeof body?.imageBase64 === 'string' ? body.imageBase64 : '';

  if (!db) {
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  const image = normalizeImagePayload(imageInput);
  if (!image) {
    return c.json({ error: 'Vui lòng tải lên một ảnh hợp lệ để đọc hóa đơn', code: 'IMAGE_REQUIRED' }, 400);
  }

  // SEC-08 FIX: Check payload size limit before reserving quota.
  const sizeCheck = validateBase64Payload(image.base64, configuredImageLimit(c.env.AI_MAX_OCR_IMAGE_BYTES));
  if (!sizeCheck.valid) {
    return c.json({ error: sizeCheck.error, code: 'PAYLOAD_TOO_LARGE' }, 413);
  }

  const command = await scanCommand(c, 'receipt');
  if (!command) return c.json({ error: 'Invalid idempotency key', code: 'INVALID_IDEMPOTENCY_KEY' }, 400);
  const { scanId, idempotencyKey } = command;
  const imageKey = c.env.IMAGES ? `users/${auth.userId}/scans/${scanId}/original.webp` : null;
  const requestFingerprint = await scanRequestFingerprint('receipt', image);
  const quota = await reserveScanQuota(db, {
    userId: auth.userId,
    householdId: auth.householdId,
    scanId,
    idempotencyKey,
    scan: scanReservationSpec(imageKey, 'receipt', image, requestFingerprint),
  });
  if (!quota.ok) {
    const status = quota.reason === 'exceeded' ? 429 : quota.reason === 'conflict' ? 409 : 503;
    const quotaState = quota.reason === 'exceeded' ? await getScanQuota(db, auth.userId).catch(() => null) : null;
    return c.json({ error: quota.reason === 'exceeded' ? 'Đã vượt hạn mức quét trong tháng' : quota.reason === 'conflict' ? 'Idempotency key đã được sử dụng cho bản quét khác' : 'Không thể kiểm tra hạn mức quét', code: quota.reason === 'exceeded' ? 'SCAN_QUOTA_EXCEEDED' : quota.reason === 'conflict' ? 'IDEMPOTENCY_CONFLICT' : 'QUOTA_UNAVAILABLE', resetAt: quotaState?.resetAt, quota: quotaState }, status);
  }
  const reservationId = quota.reservation.reservationId;
  if (!quota.acquired) return recoverScan(c, scanId, 'receipt', idempotencyKey, reservationId, image, requestFingerprint);
  let imageStored = false;

  if (c.env.IMAGES) {
    try {
      await c.env.IMAGES.put(imageKey!, image.bytes, {
        httpMetadata: { contentType: image.mimeType },
      });
      imageStored = true;
    } catch {
      console.warn('R2 receipt upload failed');
    }
  }

  if (c.env.SCAN_QUEUE_MODE === 'async' && c.env.SCAN_QUEUE) {
    if (c.env.IMAGES && !imageStored) {
      await persistScanFailure(db, scanId, auth, 'IMAGE_STORAGE_FAILED');
      await finalizeScanQuota(db, reservationId, 'released');
      return c.json({ error: 'Không thể lưu ảnh để xử lý nền', code: 'IMAGE_STORAGE_FAILED' }, 503);
    }
    if (!c.env.IMAGES && image.base64.length > 120_000) {
      await persistScanFailure(db, scanId, auth, 'QUEUE_PAYLOAD_TOO_LARGE');
      await finalizeScanQuota(db, reservationId, 'released');
      return c.json({ error: 'Môi trường xử lý nền cần R2 để lưu ảnh lớn', code: 'QUEUE_PAYLOAD_TOO_LARGE' }, 413);
    }

    try {
      await ensureScanQueueIntent(c.env, {
        type: 'scan.process.v1',
        jobId: `scan_job_${scanId}`,
        scanId,
        userId: auth.userId,
        householdId: auth.householdId,
        scanType: 'receipt',
        imageKey: imageKey || undefined,
        imageBase64: imageKey ? undefined : image.base64,
        mimeType: image.mimeType,
        idempotencyKey,
        requestFingerprint,
      });
    } catch {
      await persistScanFailure(db, scanId, auth, 'DATABASE_ERROR');
      await finalizeScanQuota(db, reservationId, 'released');
      return c.json({ error: 'Không thể lưu yêu cầu xử lý nền', code: 'DATABASE_ERROR' }, 503);
    }
    try {
      await c.env.SCAN_QUEUE.send({
        type: 'scan.process.v1',
        jobId: `scan_job_${scanId}`,
        scanId,
        userId: auth.userId,
        householdId: auth.householdId,
        scanType: 'receipt',
        imageKey: imageKey || undefined,
        imageBase64: imageKey ? undefined : image.base64,
        mimeType: image.mimeType,
        idempotencyKey,
        requestFingerprint,
      });
      // Queue acceptance reserves a slot; only a ready scan consumes it.
      return c.json({
        success: true,
        queued: true,
        receipt: {
          id: scanId,
          userId: auth.userId,
          householdId: auth.householdId,
          imageKey,
          scanType: 'receipt',
          status: 'pending',
          items: [],
          createdAt: new Date().toISOString(),
        },
      }, 202);
    } catch {
      console.error('Receipt queue enqueue failed');
      return c.json({ error: 'Không thể xếp hàng hóa đơn', code: 'QUEUE_UNAVAILABLE' }, 503);
    }
  }

  let receiptResult;
  try {
    const aiRouter = getAIRouter(c.env, (promise) => c.executionCtx.waitUntil(promise));
    receiptResult = await withScanTimeout(
      aiRouter.receiptScan({ imageBase64OrUrl: image.dataUrl, mimeType: image.mimeType }),
      75_000,
      'Đọc hóa đơn quá lâu. Vui lòng thử lại.',
    );
  } catch (error) {
    const code = scanFailureCode(error);
    await persistScanFailure(db, scanId, auth, code);
    await finalizeScanQuota(db, reservationId, 'released');
    return c.json({
      error: publicScanErrorMessage(code) || 'Không thể đọc hóa đơn.',
      code,
      retryable: RETRYABLE_SCAN_CODES.has(code),
    }, scanFailureStatus(code));
  }

  const receiptRecord = {
    id: scanId,
    userId: auth.userId,
    householdId: auth.householdId,
    imageKey: imageStored ? imageKey : null,
    scanType: 'receipt',
    status: 'ready',
    merchantName: receiptResult.merchant_name,
    invoiceNumber: receiptResult.invoice_number,
    purchaseDate: receiptResult.purchase_date,
    totalAmountVnd: receiptResult.total_amount_vnd,
    items: receiptResult.items.map((item, idx) => {
      const canonical = findCanonicalIngredient(item.raw_name);
      const providerCanonical = item.canonical_id
        ? findCanonicalIngredientById(item.canonical_id)
        : null;
      return {
        id: `receipt_item_${scanId}_${idx}`,
        rawName: item.raw_name,
        canonicalId: canonical?.id || providerCanonical?.id || null,
        estimatedQuantity: item.estimated_quantity,
        unit: item.unit as StandardUnit,
        unitPriceVnd: item.unit_price_vnd,
        totalPriceVnd: item.total_price_vnd,
        category: item.category || 'other',
        storage: item.storage || 'fridge',
        confidence: item.confidence,
      };
    }),
    createdAt: new Date().toISOString(),
  };

  try {
    const statements = [
      db
        .prepare('INSERT OR IGNORE INTO households (id, name, created_by) VALUES (?, ?, ?)')
        .bind(auth.householdId, 'Tủ lạnh gia đình', auth.userId),
      db
        .prepare(`UPDATE scans SET image_key = ?, status = 'ready', scan_type = ?,
          request_fingerprint = ?, image_mime_type = ?, merchant_name = ?, invoice_number = ?,
          purchase_date = ?, total_amount_vnd = ?, updated_at = datetime('now')
          WHERE id = ? AND user_id = ? AND household_id = ? AND status IN ('pending', 'processing')`)
        .bind(
          imageStored ? imageKey : null,
          'receipt',
          requestFingerprint,
          image.mimeType,
          receiptRecord.merchantName ?? null,
          receiptRecord.invoiceNumber ?? null,
          receiptRecord.purchaseDate ?? null,
          receiptRecord.totalAmountVnd ?? null,
          scanId,
          auth.userId,
          auth.householdId,
        ),
    ];

    for (const item of receiptRecord.items) {
      statements.push(
        db
          .prepare(SQL.INSERT_RECEIPT_SCAN_ITEM)
          .bind(
            item.id,
            scanId,
            item.rawName,
            item.canonicalId,
            item.estimatedQuantity,
            item.unit,
            item.confidence ?? LEGACY_CONFIDENCE_FILLER,
            item.category,
            item.storage,
            item.unitPriceVnd ?? null,
            item.totalPriceVnd ?? null,
            item.rawName,
            item.estimatedQuantity,
            item.unit,
            item.confidence ?? null,
            item.canonicalId,
            item.category,
            item.storage,
          )
      );
    }

    const batchResults = await db.batch(statements);
    assertBatchSucceeded(batchResults);
  } catch (err) {
    console.error('D1 receipt scan batch save failed:', err);
    await persistScanFailure(db, scanId, auth, 'DATABASE_ERROR');
    await finalizeScanQuota(db, reservationId, 'released');
    return c.json({ error: 'Không thể lưu kết quả hóa đơn', code: 'DATABASE_ERROR' }, 500);
  }

  await finalizeScanQuota(db, reservationId, 'consumed');

  return c.json({
    success: true,
    receipt: receiptRecord,
  });
});

// GET /api/v1/scans/:id
scanRoutes.get('/scans/:id', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  const db = c.env.DB;

  if (!db) {
    return c.json({ error: 'Database service unavailable' }, 503);
  }

  try {
    // SEC-05 FIX: Enforce tenancy check - only owner of scan can read it
    const scan = await db
      .prepare('SELECT * FROM scans WHERE id = ? AND household_id = ?')
      .bind(id, auth.householdId)
      .first<any>();

    if (!scan) {
      return c.json({ error: 'Bản quét không tồn tại hoặc bạn không có quyền xem', code: 'NOT_FOUND' }, 404);
    }

    const [itemsRes, queueJob] = await Promise.all([
      db.prepare(SQL.GET_SCAN_ITEMS).bind(id).all(),
      db.prepare(`SELECT error_code, attempts, max_attempts
        FROM scan_queue_jobs WHERE scan_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1`)
        .bind(id)
        .first<{ error_code: string | null; attempts: number; max_attempts: number }>(),
    ]);
    const items = (itemsRes.results || []).map((row: any) => scanItemDto(row, scan.id));

    return c.json({
      scan: {
        id: scan.id,
        userId: scan.user_id,
        householdId: scan.household_id,
        imageKey: scan.image_key,
        scanType: scan.scan_type,
        status: scan.status,
        merchantName: scan.merchant_name ?? undefined,
        invoiceNumber: scan.invoice_number ?? undefined,
        purchaseDate: scan.purchase_date ?? undefined,
        totalAmountVnd: scan.total_amount_vnd == null ? undefined : Number(scan.total_amount_vnd),
        errorCode: scan.status === 'failed' ? queueJob?.error_code ?? undefined : undefined,
        supportId: (await sha256Hex(scan.id)).slice(0, 12),
        errorMessage: scan.status === 'failed' ? publicScanErrorMessage(queueJob?.error_code) : undefined,
        attempts: queueJob?.attempts == null ? undefined : Number(queueJob.attempts),
        maxAttempts: queueJob?.max_attempts == null ? undefined : Number(queueJob.max_attempts),
        items,
        createdAt: scan.created_at,
      },
    });
  } catch (err) {
    console.error('D1 GET_SCAN failed:', err);
    return c.json({ error: 'Lỗi truy vấn bản quét', code: 'DATABASE_ERROR' }, 500);
  }
});

// POST /api/v1/scans/:id/confirm
scanRoutes.post('/scans/:id/confirm', async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const kv = c.env.CACHE;
  const id = c.req.param('id');

  const rawBody = await c.req.json().catch(() => ({}));
  const parseResult = ScanConfirmSchema.safeParse(rawBody);

  if (!parseResult.success) {
    return c.json(
      {
        error: parseResult.error.errors[0]?.message || 'Dữ liệu xác nhận không hợp lệ',
        code: 'VALIDATION_ERROR',
      },
      400
    );
  }

  const confirmedItems = parseResult.data.items;

  if (!db) {
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  try {
    // SEC-05 FIX: Verify that the scan belongs to this household
    const scan = await db
      .prepare('SELECT id, status, scan_type, purchase_date FROM scans WHERE id = ? AND household_id = ?')
      .bind(id, auth.householdId)
      .first<any>();

    if (!scan) {
      return c.json({ error: 'Bản quét không tồn tại hoặc không thuộc hộ gia đình của bạn', code: 'NOT_FOUND' }, 404);
    }

    if (scan.status === 'confirmed') {
      const updatedList = await fetchHouseholdInventoryFromDb(db, auth.householdId, kv, { strict: true, actorId: auth.userId });
      return c.json({
        success: true,
        idempotentReplay: true,
        message: 'Bản quét này đã được xác nhận trước đó',
        inventoryCount: updatedList.length,
        items: updatedList,
      });
    }
    if (scan.status !== 'ready') {
      return c.json(
        { error: 'Bản quét chưa sẵn sàng để xác nhận', code: 'INVALID_SCAN_STATE' },
        409
      );
    }

    // Hydrate the review payload from the server-side scan snapshot. This
    // both preserves fields omitted by older clients (notably the unit) and
    // ensures an AI row from another scan cannot be smuggled into this command.
    const scanItemsResult = await db
      .prepare(
        `SELECT id, raw_name, canonical_id, estimated_quantity, unit, category, storage, is_confirmed,
                unit_price_vnd, total_price_vnd, ocr_raw_name, ocr_quantity, ocr_unit, ocr_confidence,
                ocr_canonical_id, ocr_category, ocr_storage
         FROM scan_items WHERE scan_id = ?`
      )
      .bind(id)
      .all();
    const persistedItems = (scanItemsResult.results || []) as PersistedScanItem[];
    const allResolvedItems = resolveScanConfirmationItems(persistedItems, confirmedItems);
    // T13: an explicitly rejected line is durable review evidence, not stock.
    // It is recorded as REJECTED below and never reaches the lot authority.
    const rejectedItems = allResolvedItems.filter((item) => item.rejected);
    const resolvedItems = allResolvedItems.filter((item) => !item.rejected);
    // Authoritative provenance comes from the server's own scan row.
    const provenance = scanProvenance(scan.scan_type);
    const persistedById = new Map(persistedItems.map((item) => [item.id, item]));
    const adopted = await readInventoryAuthorityMode(db, auth.householdId) === 'native';
    const separateReceiptLots = adopted && provenance === 'RECEIPT';

    type ResolvedGroup = {
      key: string;
      items: ResolvedScanItem[];
      existing?: {
        id: string;
        quantity: number;
        unit: string;
        ingredient_id?: string | null;
        name?: string;
        expiry_date?: string | null;
      };
    };

    // Receipts prove new purchases: keep each line's lot and purchase facts.
    // Fridge observations retain the existing grouped CORRECT semantics.
    const groups = new Map<string, ResolvedGroup>();
    for (const item of resolvedItems) {
      const key = separateReceiptLots ? `purchase:${groups.size}` : item.canonicalId
        ? `canonical:${item.canonicalId}`
        : `name:${item.name.toLocaleLowerCase()}`;
      const group = groups.get(key);
      if (group) {
        group.items.push(item);
      } else {
        groups.set(key, { key, items: [item] });
      }
    }

    type InventoryUpdate = {
      id: string;
      quantityDelta: number;
      unit: StandardUnit;
      expiryDate: string | null;
      freshness: string;
      ingredientId: string | null;
    };
    type InventoryInsert = {
      id: string;
      quantity: number;
      unit: StandardUnit;
      expiryDate: string;
      freshness: string;
      ingredientId: string | null;
      name: string;
      category: string;
      storage: 'fridge' | 'freezer' | 'pantry';
      expiryBasis: ExpiryBasis;
      /** scan_item ids that fed this lot; used to attribute receipt prices. */
      lineIds: string[];
    };

    const updates = new Map<string, InventoryUpdate>();
    const inserts: InventoryInsert[] = [];
    const evidenceByItemId = new Map<string, InventoryScanEvidence>();
    const affectedItemIds = new Map<ResolvedScanItem, string>();
    const events: Array<{
      id: string;
      itemId: string;
      quantity: number;
      unit: StandardUnit;
      metadata: string;
    }> = [];

    const inventoryRevision = await readLegacyInventoryRevision(db, auth.householdId);
    let groupIndex = 0;
    for (const group of groups.values()) {
      const first = group.items[0];
      const existingResult = separateReceiptLots ? { results: [] } : await db
        .prepare(
          `SELECT id, quantity, unit, ingredient_id, name, expiry_date
           FROM inventory_items
           WHERE household_id = ?
             AND ((? IS NOT NULL AND ingredient_id = ?) OR LOWER(name) = LOWER(?))
           ORDER BY updated_at ASC`
        )
        .bind(auth.householdId, first.canonicalId, first.canonicalId, first.name)
        .all();
      const candidates = (existingResult.results || []) as Array<NonNullable<ResolvedGroup['existing']>>;
      const exactCandidate = candidates.find((candidate) => candidate.unit === first.unit);
      const compatibleCandidate = candidates.find(
        (candidate) =>
          isStandardUnit(candidate.unit) && areUnitsCompatible(first.unit, candidate.unit)
      );
      const existing = exactCandidate || compatibleCandidate;
      if (!existing && candidates.length > 0) {
        throw new ScanConfirmationError(
          'UNIT_MISMATCH',
          `Không thể quy đổi đơn vị ${first.unit} sang đơn vị tồn kho của ${first.name}`
        );
      }
      group.existing = existing || undefined;

      const targetUnitValue = existing?.unit || first.unit;
      if (!isStandardUnit(targetUnitValue)) {
        throw new ScanConfirmationError(
          'INVALID_SCAN_ITEM',
          `Đơn vị tồn kho của ${first.name} không hợp lệ`
        );
      }
      const targetUnit = targetUnitValue;

      let totalDelta = 0;
      const deltas: number[] = [];
      for (const item of group.items) {
        const delta = convertScanQuantity(item.quantity, item.unit, targetUnit);
        totalDelta += delta;
        deltas.push(delta);
      }
      if (!Number.isFinite(totalDelta) || totalDelta <= 0) {
        throw new ScanConfirmationError('INVALID_QUANTITY', `Số lượng của ${first.name} không hợp lệ`);
      }

      const shelfLife = findCanonicalIngredient(first.canonicalId || first.name)?.defaultShelfLifeDays || 7;
      const submittedExpiries = group.items
        .map((item) => item.expiryDate)
        .filter((value): value is string => Boolean(value));
      const existingExpiry = existing?.expiry_date || null;
      const expiryDate = [...submittedExpiries, ...(existingExpiry ? [existingExpiry] : [])]
        .sort()[0] || new Date(Date.now() + shelfLife * 86400000).toISOString().split('T')[0];
      const freshness = computeFreshness(expiryDate, undefined, shelfLife);
      // T13 expiry truth. The winning date decides the evidence class: a
      // reviewer-supplied date is KNOWN; a day-chip estimate or the default
      // shelf-life fallback is ESTIMATED. The pre-T13 code wrote every one of
      // these as KNOWN, which manufactured dated facts out of a guess.
      const expiryBasis: ExpiryBasis = group.items.some((item) => item.expiryDate === expiryDate
        && item.expiryBasis === 'supplied') ? 'supplied' : 'inferred';

      let itemId: string;
      if (existing) {
        const currentQuantity = Number(existing.quantity);
        if (!Number.isFinite(currentQuantity) || currentQuantity < 0) {
          throw new ScanConfirmationError('INVALID_QUANTITY', `Tồn kho của ${first.name} không hợp lệ`);
        }
        itemId = existing.id;
        const previous = updates.get(itemId);
        updates.set(itemId, {
          id: itemId,
          quantityDelta: (previous?.quantityDelta || 0) + totalDelta,
          unit: targetUnit,
          expiryDate,
          freshness,
          ingredientId: existing.ingredient_id || first.canonicalId,
        });
        if (!Number.isFinite(currentQuantity + totalDelta)) {
          throw new ScanConfirmationError('INVALID_QUANTITY', `Số lượng của ${first.name} quá lớn`);
        }
      } else {
        itemId = `item_${id}_${stableScanPart(first, groupIndex)}`;
        inserts.push({
          id: itemId,
          quantity: totalDelta,
          unit: targetUnit,
          expiryDate,
          freshness,
          ingredientId: first.canonicalId,
          name: first.name,
          category: first.category,
          storage: first.storage,
          expiryBasis,
          lineIds: group.items.map((item) => item.sourceId).filter((value): value is string => Boolean(value)),
        });
      }

      const evidence = evidenceByItemId.get(itemId) ?? { scanId: id, sourceType: provenance, lines: [] };
      for (const item of group.items) {
        affectedItemIds.set(item, itemId);
        const persisted = item.sourceId ? persistedById.get(item.sourceId) : undefined;
        evidence.lines.push(scanCorrectionLine(item.sourceId ?? null, rawScanEvidence(persisted ?? {}), {
          name: item.name, quantity: item.quantity, unit: item.unit, storage: item.storage,
          ...lotExpiryFromEvidence(item.expiryDate, item.expiryBasis),
        }));
      }
      evidenceByItemId.set(itemId, evidence);

      group.items.forEach((item, itemIndex) => {
        const sourceKey = stableScanPart(item, itemIndex);
        events.push({
          id: `evt_scan_${id}_${sourceKey}`,
          itemId,
          quantity: deltas[itemIndex],
          unit: targetUnit,
          metadata: JSON.stringify({
            scanId: id,
            scanItemId: item.sourceId || null,
            sourceQuantity: item.quantity,
            sourceUnit: item.unit,
          }),
        });
      });
      groupIndex += 1;
    }

    const selectedItems = resolvedItems.filter(
      (item): item is ResolvedScanItem & { sourceId: string } => Boolean(item.sourceId)
    );
    const selectedIds = selectedItems.map((item) => item.sourceId);
    // Every mutation below is guarded by the same READY predicate. The scan
    // status transition is deliberately the final statement; a concurrent
    // confirmation therefore turns all stale mutations into no-ops.
    const readyScanPredicate =
      `EXISTS (SELECT 1 FROM scans WHERE id = ? AND household_id = ? AND status = 'ready')`;
    const batchStatements: any[] = [];
    if (selectedItems.length > 0) {
      // Persist the user's reviewed values alongside the confirmation flag so
      // a later GET of the scan reflects exactly what was imported. Omitted
      // predictions remain unconfirmed and retain their original AI values.
      for (const item of selectedItems) {
        // T13R-A P2-B: record the expiry the reviewer accepted for THIS line
        // (KNOWN / ESTIMATED / UNKNOWN) so a reopened review reports the
        // review, not an absence re-derived from stock.
        const reviewed = lotExpiryFromEvidence(item.expiryDate, item.expiryBasis);
        batchStatements.push(
          db
            .prepare(
              `UPDATE scan_items
               SET raw_name = ?, canonical_id = ?, estimated_quantity = ?, unit = ?,
                   category = ?, storage = ?, is_confirmed = 1, review_state = 'CONFIRMED',
                   reviewed_expiry_date = ?, reviewed_expiry_kind = ?
               WHERE id = ? AND scan_id = ? AND ${readyScanPredicate}`
            )
            .bind(
              item.name,
              item.canonicalId,
              item.quantity,
              item.unit,
              item.category,
              item.storage,
              reviewed.expiryAt ?? reviewed.estimatedExpiryAt ?? null,
              reviewed.expiryKind,
              item.sourceId,
              id,
              id,
              auth.householdId
            )
        );
      }
    }

    // T13: an explicitly rejected line is recorded as durable review evidence.
    // Modelling rejection as "the line vanished from the request" would leave
    // it indistinguishable from a not-yet-reviewed line forever.
    for (const rejected of rejectedItems) {
      if (!rejected.sourceId) continue;
      batchStatements.push(
        db
          .prepare(
            `UPDATE scan_items SET review_state = 'REJECTED', is_confirmed = 0
             WHERE id = ? AND scan_id = ? AND is_confirmed = 0 AND ${readyScanPredicate}`
          )
          .bind(rejected.sourceId, id, id, auth.householdId)
      );
    }

    // Adopted households confirm through the lot authority: reviewed scan
    // values and the status transition commit in the same atomic batch as the
    // native commands, status update last.
    if (adopted) {
      return confirmAdoptedScan(c, db, kv, auth, id, {
        selectedIds, batchStatements, updates, inserts,
        provenance, evidenceByItemId,
        purchase: {
          // Receipt facts are read from the server-side scan row, never from
          // the client payload, and stay null when the receipt lacked them.
          purchasedAt: provenance === 'RECEIPT'
            ? receiptLineFacts(provenance, scan, {}).purchasedAt : null,
          purchasePriceFor: (lineIds: string[]) => {
            if (provenance !== 'RECEIPT') return null;
            // Only attribute a price when exactly one receipt line feeds the
            // lot; a merged lot has no single provable line price.
            if (lineIds.length !== 1) return null;
            const line = persistedById.get(lineIds[0]);
            return line ? receiptLineFacts(provenance, scan, line).purchasePrice : null;
          },
        },
        observations: await Promise.all(resolvedItems.map(async (item, index) => {
          // T10 rawName is machine evidence, not the reviewed identity.
          const rawName = rawScanEvidence(item.sourceId ? persistedById.get(item.sourceId) ?? {} : {})
            .rawName?.trim().slice(0, 200).trim() ?? null;
          return {
            sourceRef: await scanObservationSourceRef(id, item.sourceId ?? item.clientId ?? `manual-${index}`),
            ingredientId: item.canonicalId,
            rawName,
            // Unmapped/manual lines without retained OCR still need a real subject.
            legacyItemId: rawName === null && item.canonicalId === null ? affectedItemIds.get(item) ?? null : null,
            quantity: item.quantity,
            unit: item.unit,
            storage: item.storage,
            expiryDate: item.expiryDate ?? null,
            expiryBasis: item.expiryBasis,
            note: null,
          };
        })),
        readyGuard: { sql: readyScanPredicate, bindings: [id, auth.householdId] },
      });
    }

    for (const update of updates.values()) {
      batchStatements.push(
        db
          .prepare(
            `UPDATE inventory_items
             SET quantity = quantity + ?, unit = ?, ingredient_id = COALESCE(ingredient_id, ?),
                 expiry_date = ?, freshness = ?, version = version + 1, updated_at = datetime('now')
             WHERE id = ? AND household_id = ? AND ${readyScanPredicate}`
          )
          .bind(
            update.quantityDelta,
            update.unit,
            update.ingredientId,
            update.expiryDate,
            update.freshness,
            update.id,
            auth.householdId,
            id,
            auth.householdId
          )
      );
    }

    for (const insert of inserts) {
      batchStatements.push(
        db
          .prepare(
            `INSERT INTO inventory_items
             (id, household_id, ingredient_id, name, quantity, unit, category, storage,
              expiry_date, added_date, freshness, data_source)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE ${readyScanPredicate}`
          )
          .bind(
            insert.id,
            auth.householdId,
            insert.ingredientId,
            insert.name,
            insert.quantity,
            insert.unit,
            insert.category,
            insert.storage,
            insert.expiryDate,
            new Date().toISOString(),
            insert.freshness,
            'scan',
            id,
            auth.householdId
          )
      );
    }

    for (const event of events) {
      batchStatements.push(
        db
          .prepare(
            `INSERT INTO inventory_events
             (id, household_id, inventory_item_id, event_type, quantity_delta, unit, reason, metadata)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?
             WHERE ${readyScanPredicate}`
          )
          .bind(
            event.id,
            auth.householdId,
            event.itemId,
            'SCAN_CONFIRM',
            event.quantity,
            event.unit,
            'Xác nhận từ nhận diện thông minh',
            event.metadata,
            id,
            auth.householdId
          )
      );
    }

    batchStatements.push(
      db
        .prepare(
          `UPDATE scans SET status = 'confirmed', updated_at = datetime('now')
           WHERE id = ? AND household_id = ? AND status = 'ready'`
        )
        .bind(id, auth.householdId)
    );

    // D1 batch executes the state transition, projection, and audit events as
    // one transaction. A failed event insert therefore rolls back the status.
    const batchResults = await runLegacyInventoryBatch(db, auth.householdId, batchStatements, inventoryRevision,
      { sql: readyScanPredicate, bindings: [id, auth.householdId] });
    assertBatchSucceeded(batchResults);
    const statusResult = batchResults?.[batchResults.length - 1] as any;
    if (statusResult?.meta?.changes !== 1) {
      const committed = await db
        .prepare('SELECT status FROM scans WHERE id = ? AND household_id = ?')
        .bind(id, auth.householdId)
        .first();
      if ((committed as any)?.status === 'confirmed') {
        const updatedList = await fetchHouseholdInventoryFromDb(db, auth.householdId, kv, { strict: true, actorId: auth.userId });
        return c.json({
          success: true,
          idempotentReplay: true,
          message: 'Bản quét này đã được xác nhận trước đó',
          inventoryCount: updatedList.length,
          items: updatedList,
        });
      }
      throw new Error('Scan confirmation state transition did not commit');
    }

    if (kv) {
      await kv.delete(`inv_${auth.householdId}`).catch(() => {});
    }

    // Fetch fresh updated inventory from D1
    const updatedList = await fetchHouseholdInventoryFromDb(db, auth.householdId, kv, { strict: true, actorId: auth.userId });

    return c.json({
      success: true,
      message: 'Đã cập nhật nguyên liệu vào tủ lạnh thành công',
      inventoryCount: updatedList.length,
      items: updatedList,
      confirmedItemIds: selectedIds,
    });
  } catch (err: any) {
    if (err instanceof ScanConfirmationError) {
      return c.json(
        { error: err.message, code: err.code },
        err.status as 400 | 409 | 422
      );
    }
    // If another request confirmed this scan between our state read and the
    // batch, the unique event IDs make this batch fail atomically. Re-read the
    // state and expose the committed result as an idempotent replay.
    try {
      const committed = await db
        .prepare('SELECT status FROM scans WHERE id = ? AND household_id = ?')
        .bind(id, auth.householdId)
        .first();
      if ((committed as any)?.status === 'confirmed') {
        const updatedList = await fetchHouseholdInventoryFromDb(db, auth.householdId, kv, { strict: true, actorId: auth.userId });
        return c.json({
          success: true,
          idempotentReplay: true,
          message: 'Bản quét này đã được xác nhận trước đó',
          inventoryCount: updatedList.length,
          items: updatedList,
        });
      }
    } catch {
      // Fall through to the database error response.
    }
    if (err instanceof InventoryWriterAuthorityError || err instanceof InventoryWriterSnapshotError) {
      return c.json({ error: err.message, code: err.code }, 409);
    }
    console.error('D1 confirmScan items insert failed:', err);
    return c.json({ error: 'Lỗi xác nhận đưa nguyên liệu vào tủ lạnh', code: 'DATABASE_ERROR' }, 500);
  }
});
