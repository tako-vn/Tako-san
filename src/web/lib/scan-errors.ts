import { ApiError } from '../services/http';

export type ScanErrorContext = 'fridge' | 'food' | 'receipt';
export type ScanQuota = { plan: string; limit: number; used: number; remaining: number; resetAt: string };

const quality = {
  receipt: 'Không đọc được dòng hàng đủ rõ. Hãy chụp toàn bộ hóa đơn, thẳng và đủ sáng.',
  fridge: 'Ảnh chưa đủ rõ để nhận diện thực phẩm. Hãy chụp gần hơn, đủ sáng và tránh lóa.',
  food: 'Ảnh chưa đủ rõ để nhận diện thực phẩm. Hãy chụp gần hơn, đủ sáng và tránh lóa.',
};

function resetDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString('vi-VN', { timeZone: 'UTC' });
}

export function scanErrorMessage(
  code: string | null | undefined,
  context: ScanErrorContext,
  options: { quota?: ScanQuota | null; requestId?: string | null; resetAt?: string | null } = {},
): string {
  const resetAt = resetDate(options.resetAt || options.quota?.resetAt);
  const quotaLimit = options.quota?.plan === 'free' ? options.quota.limit : null;
  let message: string;
  switch (code) {
    case 'SCAN_QUOTA_EXCEEDED':
      message = quotaLimit === null
        ? `Hạn mức quét của gói hiện tại đã hết.${resetAt ? ` Lượt mới sẽ mở lại vào ${resetAt}.` : ''}`
        : `Bạn đã dùng hết ${quotaLimit} lượt quét miễn phí trong tháng này.${resetAt ? ` Lượt mới sẽ mở lại vào ${resetAt}.` : ''}`;
      break;
    case 'RATE_LIMIT_EXCEEDED':
    case 'RATE_LIMITED':
      message = 'Yêu cầu đang bị giới hạn tạm thời. Vui lòng thử lại sau ít phút.';
      break;
    case 'RATE_LIMIT_UNAVAILABLE':
    case 'QUOTA_UNAVAILABLE':
      message = 'Chưa thể kiểm tra hạn mức quét. Vui lòng thử lại sau.';
      break;
    case 'PAYLOAD_TOO_LARGE':
    case 'AI_IMAGE_TOO_LARGE':
    case 'QUEUE_PAYLOAD_TOO_LARGE':
      message = 'Ảnh quá lớn để xử lý. Hãy chọn ảnh có dung lượng nhỏ hơn.';
      break;
    case 'IMAGE_REQUIRED':
      message = 'Hãy chọn một ảnh để quét.';
      break;
    case 'IMAGE_STORAGE_FAILED':
    case 'IMAGE_UNAVAILABLE':
    case 'IMAGE_NOT_FOUND':
      message = 'Ảnh quét không còn khả dụng. Hãy chọn và tải lên ảnh mới.';
      break;
    case 'QUEUE_UNAVAILABLE':
      message = 'Chưa thể xếp hàng xử lý. Hãy kiểm tra lại trạng thái bản quét trước khi gửi lại.';
      break;
    case 'REQUEST_TIMEOUT':
    case 'AI_SCAN_TIMEOUT':
      message = context === 'receipt'
        ? 'Dịch vụ đọc hóa đơn phản hồi quá lâu. Bản quét lỗi không trừ lượt quét.'
        : 'Dịch vụ nhận diện phản hồi quá lâu. Bản quét lỗi không trừ lượt quét.';
      break;
    case 'NETWORK_ERROR':
      message = 'Dịch vụ quét bị mất kết nối. Hãy kiểm tra lại trạng thái trước khi gửi lại.';
      break;
    case 'UPSTREAM_ERROR':
    case 'AI_SCAN_UNAVAILABLE':
    case 'AI_UNAVAILABLE':
    case 'MODEL_NOT_FOUND':
    case 'AUTHENTICATION_FAILED':
    case 'PERMISSION_DENIED':
    case 'LICENSE_REQUIRED':
    case 'MAX_ATTEMPTS_EXCEEDED':
    case 'RESERVATION_EXPIRED':
      message = 'Dịch vụ AI đang tạm thời không khả dụng. Bản quét lỗi không trừ lượt quét.';
      break;
    case 'INVALID_RESPONSE':
    case 'SCHEMA_VALIDATION':
    case 'AI_SCAN_NO_USABLE_ITEMS':
      message = quality[context];
      break;
    case 'IDEMPOTENCY_CONFLICT':
      message = 'Ảnh hoặc chế độ quét đã thay đổi. Hãy bắt đầu một lượt quét mới.';
      break;
    case 'DATABASE_ERROR':
      message = 'Chưa thể lưu bản quét. Vui lòng thử lại sau.';
      break;
    case 'SCAN_FAILED':
      message = 'Bản quét trước đã thất bại. Hãy tạo lượt quét mới.';
      break;
    default:
      message = context === 'receipt'
        ? 'Chưa thể xử lý hóa đơn. Vui lòng thử lại sau.'
        : 'Chưa thể xử lý bản quét. Vui lòng thử lại sau.';
  }
  const requestId = options.requestId?.match(/^[A-Za-z0-9_-]{8,64}$/)?.[0];
  return requestId ? `${message} Mã hỗ trợ: ${requestId.slice(0, 12)}.` : message;
}

export function scanApiErrorMessage(error: unknown, context: ScanErrorContext, quota?: ScanQuota | null): string {
  if (!(error instanceof ApiError)) return scanErrorMessage(null, context, { quota });
  if (error.kind === 'offline' && error.retryable) return scanErrorMessage('NETWORK_ERROR', context, { quota });
  const resetAt = typeof error.payload?.resetAt === 'string' ? error.payload.resetAt : null;
  const serverQuota = error.payload?.quota;
  const authoritativeQuota = serverQuota && typeof serverQuota === 'object'
    ? serverQuota as ScanQuota : quota;
  return scanErrorMessage(error.code, context, { quota: authoritativeQuota, requestId: error.requestId, resetAt });
}
