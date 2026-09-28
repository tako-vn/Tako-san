import { ApiError } from '../services/http';

/**
 * Single client taxonomy for scan failures (POST errors and polled terminal
 * states). Machine codes decide the message and the offered action; HTTP status
 * alone never does (429 is both quota exhaustion and rate limiting).
 */
export type ScanKind = 'fridge' | 'food' | 'receipt';
export type ScanQuotaStatus = 'reserved' | 'consumed' | 'released';
export type ScanFailureAction = 'retry' | 'wait' | 'choose-image' | 'new-scan' | 'upgrade' | 'sign-in' | 'none';
export type ScanFailureCategory =
  | 'quota' | 'rate-limit' | 'service' | 'input' | 'provider-unavailable' | 'provider-busy'
  | 'timeout' | 'quality' | 'expired' | 'conflict' | 'auth' | 'offline' | 'unknown';

export interface ScanQuotaSnapshot {
  plan?: string | null;
  isPlus?: boolean;
  limit?: number | null;
  used?: number | null;
  remaining?: number | null;
  resetAt?: string | null;
}

export interface ScanFailure {
  code: string;
  category: ScanFailureCategory;
  message: string;
  action: ScanFailureAction;
  /** Re-sending the same command can succeed without the user changing anything. */
  canRetry: boolean;
  retryAfterSeconds?: number;
  quotaNote?: string;
  supportCode?: string;
}

export interface ScanFailureInput {
  code?: string | null;
  status?: number;
  kind?: 'offline' | 'http' | 'auth';
  scanType: ScanKind;
  quota?: ScanQuotaSnapshot | null;
  quotaStatus?: unknown;
  requestId?: string | null;
  supportRef?: string | null;
  retryAfterSeconds?: number | null;
}

const CATEGORY_BY_CODE: Record<string, ScanFailureCategory> = {
  SCAN_QUOTA_EXCEEDED: 'quota',
  RATE_LIMIT_EXCEEDED: 'rate-limit',
  RATE_LIMIT_UNAVAILABLE: 'service',
  QUOTA_UNAVAILABLE: 'service',
  QUEUE_UNAVAILABLE: 'service',
  QUEUE_PAYLOAD_TOO_LARGE: 'service',
  IMAGE_STORAGE_FAILED: 'service',
  DATABASE_ERROR: 'service',
  DATABASE_UNAVAILABLE: 'service',
  SCAN_RECORD_MISSING: 'service',
  CLAIM_LOST: 'service',
  CLAIM_FAILED: 'service',
  PAYLOAD_TOO_LARGE: 'input',
  AI_IMAGE_TOO_LARGE: 'input',
  IMAGE_REQUIRED: 'input',
  INVALID_SCAN_TYPE: 'input',
  AI_SCAN_UNAVAILABLE: 'provider-unavailable',
  AI_UNAVAILABLE: 'provider-unavailable',
  AI_ESCALATION_EXHAUSTED: 'provider-unavailable',
  MODEL_NOT_FOUND: 'provider-unavailable',
  AUTHENTICATION_FAILED: 'provider-unavailable',
  PERMISSION_DENIED: 'provider-unavailable',
  LICENSE_REQUIRED: 'provider-unavailable',
  UNSUPPORTED_REQUEST_OPTION: 'provider-unavailable',
  PROVIDER_REQUEST_REJECTED: 'provider-unavailable',
  RESOURCE_NOT_FOUND: 'provider-unavailable',
  RATE_LIMITED: 'provider-busy',
  NETWORK_ERROR: 'provider-busy',
  UPSTREAM_ERROR: 'provider-busy',
  UPSTREAM_BUSY: 'provider-busy',
  AI_SCAN_FAILED: 'provider-busy',
  REQUEST_TIMEOUT: 'timeout',
  AI_SCAN_TIMEOUT: 'timeout',
  AI_SCAN_NO_USABLE_ITEMS: 'quality',
  INVALID_RESPONSE: 'quality',
  SCHEMA_VALIDATION: 'quality',
  AI_BUDGET_EXCEEDED: 'quality',
  IMAGE_NOT_FOUND: 'expired',
  IMAGE_UNAVAILABLE: 'expired',
  RESERVATION_EXPIRED: 'expired',
  MAX_ATTEMPTS_EXCEEDED: 'expired',
  IDEMPOTENCY_CONFLICT: 'conflict',
  IDEMPOTENCY_REPLAY_UNVERIFIABLE: 'conflict',
  INVALID_IDEMPOTENCY_KEY: 'conflict',
};

// Rejected before any reservation, or refunded by contract (ADR-039).
const NOT_CHARGED_CODES = new Set([
  'RATE_LIMIT_EXCEEDED', 'RATE_LIMIT_UNAVAILABLE', 'QUOTA_UNAVAILABLE', 'PAYLOAD_TOO_LARGE', 'IMAGE_REQUIRED',
  'INVALID_SCAN_TYPE', 'IMAGE_STORAGE_FAILED', 'QUEUE_PAYLOAD_TOO_LARGE', 'INVALID_IDEMPOTENCY_KEY',
]);

const RETRYABLE_CATEGORIES = new Set<ScanFailureCategory>([
  'rate-limit', 'service', 'provider-unavailable', 'provider-busy', 'timeout', 'quality', 'offline', 'unknown',
]);

const QUOTA_NOTE: Record<ScanQuotaStatus, string | undefined> = {
  released: 'Lượt quét này không bị trừ vào hạn mức.',
  reserved: 'Lượt quét đang được tạm giữ và sẽ được hoàn lại nếu bản quét không được xử lý.',
  consumed: undefined,
};

/** Unlimited-in-practice plans (Plus is 999999/month) are shown without a count. */
const UNLIMITED_THRESHOLD = 100_000;

export function formatQuotaResetDate(resetAt?: string | null): string | null {
  if (!resetAt) return null;
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh',
  }).format(date);
}

function isPlusQuota(quota?: ScanQuotaSnapshot | null): boolean {
  return quota?.isPlus === true || quota?.plan === 'plus';
}

function quotaMessage(quota?: ScanQuotaSnapshot | null): string {
  const limit = typeof quota?.limit === 'number' ? quota.limit : null;
  const resetDate = formatQuotaResetDate(quota?.resetAt);
  const reopen = resetDate ? ` Lượt mới sẽ được mở lại vào ${resetDate}.` : '';
  if (limit === null) return `Bạn đã dùng hết lượt quét trong tháng này.${reopen}`;
  if (isPlusQuota(quota)) return `Bạn đã dùng hết ${limit} lượt quét của tháng này.${reopen}`;
  return `Bạn đã dùng hết ${limit} lượt quét miễn phí trong tháng này.${reopen}`;
}

function messageFor(category: ScanFailureCategory, code: string, input: ScanFailureInput): string {
  const receipt = input.scanType === 'receipt';
  const subject = input.scanType === 'food' ? 'thực phẩm' : 'nguyên liệu';
  switch (category) {
    case 'quota':
      return quotaMessage(input.quota);
    case 'rate-limit': {
      const wait = input.retryAfterSeconds && input.retryAfterSeconds > 0 ? `${Math.ceil(input.retryAfterSeconds)} giây` : 'giây lát';
      return `Bạn đang gửi ảnh quá nhanh. Vui lòng đợi ${wait} rồi thử lại.`;
    }
    case 'service':
      return 'Hệ thống xử lý bản quét đang gặp sự cố tạm thời. Vui lòng thử lại sau ít phút.';
    case 'input':
      return code === 'IMAGE_REQUIRED' || code === 'INVALID_SCAN_TYPE'
        ? 'Không đọc được tệp ảnh. Hãy chọn một ảnh JPG hoặc PNG khác.'
        : 'Ảnh quá lớn để xử lý (tối đa 5MB). Hãy chọn ảnh khác hoặc chụp lại.';
    case 'provider-unavailable':
      return receipt
        ? 'Dịch vụ đọc hóa đơn đang tạm thời không khả dụng. Bạn có thể thử lại sau hoặc nhập thủ công.'
        : 'Dịch vụ nhận diện đang tạm thời không khả dụng. Hãy thử lại sau hoặc nhập thủ công.';
    case 'provider-busy':
      return receipt
        ? 'Dịch vụ đọc hóa đơn đang bận hoặc mất kết nối. Vui lòng thử lại sau ít phút.'
        : 'Dịch vụ nhận diện đang bận hoặc mất kết nối. Vui lòng thử lại sau ít phút.';
    case 'timeout':
      return receipt
        ? 'Dịch vụ đọc hóa đơn phản hồi quá lâu. Hãy thử lại với ảnh gọn và rõ hơn.'
        : 'Dịch vụ nhận diện phản hồi quá lâu. Hãy thử lại với ảnh nhỏ và rõ hơn.';
    case 'quality':
      if (code === 'AI_BUDGET_EXCEEDED') {
        return receipt
          ? 'Hóa đơn có quá nhiều chi tiết để xử lý một lần. Hãy chụp gần hơn hoặc chia thành nhiều ảnh.'
          : 'Ảnh có quá nhiều chi tiết để xử lý. Hãy chụp gần hơn một nhóm nhỏ nguyên liệu.';
      }
      return receipt
        ? 'Không đọc được dòng hàng đủ rõ. Hãy chụp toàn bộ hóa đơn, thẳng và đủ sáng.'
        : `Ảnh chưa đủ rõ để nhận diện ${subject}. Hãy chụp gần hơn, đủ sáng và không bị lóa.`;
    case 'expired':
      if (code === 'RESERVATION_EXPIRED') return 'Bản quét đã hết thời gian chờ xử lý. Hãy gửi lại ảnh để quét lại.';
      if (code === 'MAX_ATTEMPTS_EXCEEDED') return 'Bản quét đã hết số lần xử lý tự động. Hãy thử lại sau ít phút hoặc chọn ảnh mới.';
      return receipt
        ? 'Ảnh hóa đơn không còn khả dụng. Hãy chọn và tải lên ảnh mới.'
        : 'Ảnh quét không còn khả dụng. Hãy chọn và tải lên ảnh mới.';
    case 'conflict':
      return 'Yêu cầu này trùng với một bản quét khác. Hãy bắt đầu lượt quét mới.';
    case 'auth':
      return 'Phiên đăng nhập đã hết hạn hoặc đã thay đổi. Vui lòng đăng nhập lại để tiếp tục quét.';
    case 'offline':
      return 'Không có kết nối mạng. Kiểm tra kết nối rồi thử lại.';
    default:
      return receipt ? 'Không thể đọc hóa đơn. Vui lòng thử lại.' : 'Không thể xử lý bản quét. Vui lòng thử lại.';
  }
}

function actionFor(category: ScanFailureCategory, input: ScanFailureInput): ScanFailureAction {
  switch (category) {
    case 'quota':
      return isPlusQuota(input.quota) ? 'none' : 'upgrade';
    case 'rate-limit':
      return 'wait';
    case 'input':
    case 'quality':
      return 'choose-image';
    case 'expired':
    case 'conflict':
      return 'new-scan';
    case 'auth':
      return 'sign-in';
    default:
      return 'retry';
  }
}

function quotaStatusOf(value: unknown): ScanQuotaStatus | undefined {
  return value === 'reserved' || value === 'consumed' || value === 'released' ? value : undefined;
}

/** Short support code: the async scan reference, else the failed request's correlation id prefix. */
export function scanSupportCode(input: { supportRef?: string | null; requestId?: string | null }): string | undefined {
  if (input.supportRef) return input.supportRef;
  return input.requestId ? input.requestId.slice(0, 8) : undefined;
}

export function describeScanFailure(input: ScanFailureInput): ScanFailure {
  const code = (input.code || '').toUpperCase();
  const category: ScanFailureCategory = input.kind === 'offline'
    ? 'offline'
    : input.kind === 'auth' || input.status === 401 || input.status === 403
      ? 'auth'
      : CATEGORY_BY_CODE[code] ?? 'unknown';
  const quotaStatus = quotaStatusOf(input.quotaStatus) ?? (NOT_CHARGED_CODES.has(code) ? 'released' : undefined);
  return {
    code: code || (category === 'offline' ? 'OFFLINE' : 'UNKNOWN'),
    category,
    message: messageFor(category, code, input),
    action: actionFor(category, input),
    canRetry: RETRYABLE_CATEGORIES.has(category),
    retryAfterSeconds: input.retryAfterSeconds ?? undefined,
    quotaNote: category === 'quota' ? undefined : quotaStatus && QUOTA_NOTE[quotaStatus],
    supportCode: scanSupportCode(input),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

/** Map a failed scan POST (ApiError or unexpected throw) through the taxonomy. */
export function scanFailureFromError(error: unknown, scanType: ScanKind): ScanFailure {
  if (!(error instanceof ApiError)) return describeScanFailure({ scanType });
  const payload = error.payload ?? {};
  const retryAfter = error.retryAfterSeconds ?? (typeof payload.retryAfterSeconds === 'number' ? payload.retryAfterSeconds : undefined);
  return describeScanFailure({
    code: error.code,
    status: error.status,
    kind: error.kind,
    scanType,
    quota: isRecord(payload.quota) ? payload.quota as ScanQuotaSnapshot : null,
    quotaStatus: payload.quotaStatus,
    requestId: error.requestId,
    retryAfterSeconds: retryAfter,
  });
}

/** Server-authoritative quota line for the scan screen, or null when unknown. */
export function formatScanQuota(subscription?: ScanQuotaSnapshot | null): string | null {
  if (!subscription || typeof subscription.limit !== 'number' || typeof subscription.remaining !== 'number') return null;
  const { limit, remaining } = subscription;
  if (isPlusQuota(subscription)) {
    return limit >= UNLIMITED_THRESHOLD ? 'Gói Plus · quét không giới hạn' : `Gói Plus · còn ${remaining}/${limit} lượt quét tháng này`;
  }
  if (remaining > 0) return `Còn ${remaining}/${limit} lượt quét miễn phí tháng này`;
  const resetDate = formatQuotaResetDate(subscription.resetAt);
  return `Đã dùng hết ${limit} lượt quét miễn phí${resetDate ? ` · mở lại ${resetDate}` : ''}`;
}
