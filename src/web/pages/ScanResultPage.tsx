import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useScanStore } from '../stores/useScanStore';
import { api } from '../services/api';
import { TopBar } from '../components/common/TopBar';
import { Button } from '../components/common/Button';
import { BottomSheet } from '../design-system/primitives';
import { getIngredientImage } from '../lib/ingredient-images';
import { Plus, Trash2, CheckCircle2, AlertCircle } from 'lucide-react';
import { StandardUnit } from '@frigo/domain';
import { capturePrivateSession } from '../lib/private-session';
import { invalidateInventoryDependents } from '../lib/query-invalidation';
import { presentConfidence, presentDomainError, presentRefetchOutcome } from '../lib/inventory-truth';
import { ApiError } from '../services/http';
import { ScanProcessingState } from '../components/scan/ScanProcessingState';
import { describeScanFailure } from '../lib/scan-errors';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/queryKeys';

const UNITS: StandardUnit[] = ['piece', 'g', 'kg', 'ml', 'l', 'pack', 'bunch', 'slice'];
const fieldClass = 'mt-1 w-full min-w-0 h-11 px-3 rounded-lg border border-semantic-border text-sm text-semantic-text-primary bg-white focus:border-takosan-green focus:outline-none';
const confidenceClass = {
  unknown: 'text-semantic-text-secondary bg-semantic-border/60',
  low: 'text-semantic-warning-strong bg-semantic-warning-soft',
  medium: 'text-semantic-warning-strong bg-semantic-warning-soft',
  high: 'text-takosan-green-deep bg-takosan-mint',
};

type FailureDetail = { quotaNote?: string; supportCode?: string };

export const ScanResultPage: React.FC = () => {
  const { id: paramScanId } = useParams<{ id: string }>();
  const scanId = useScanStore((state) => state.scanId);
  const targetScanId = paramScanId || scanId || '';
  return <ScanReview key={targetScanId} effectiveScanId={targetScanId} />;
};

const ScanReview: React.FC<{ effectiveScanId: string }> = ({ effectiveScanId }) => {
  const navigate = useNavigate();
  const { scanId, reviewStatus, items: storedItems, updateItem, addItem, removeItem, reset } = useScanStore();
  // A route change must hide the previous scan before hydration's first effect.
  const matchesScan = scanId === effectiveScanId;
  const items = matchesScan ? storedItems : [];
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const [isConfirming, setIsConfirming] = useState(false);
  const confirmBarRef = useRef<HTMLDivElement>(null);
  const restoreConfirmFocus = useRef(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [isManualAddOpen, setIsManualAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addQty, setAddQty] = useState(1);
  const [addUnit, setAddUnit] = useState<StandardUnit>('piece');
  const [pollError, setPollError] = useState<string | null>(null);
  const [failureDetail, setFailureDetail] = useState<FailureDetail | null>(null);
  const [scanStatus, setScanStatus] = useState<'pending' | 'ready' | 'confirmed' | 'failed'>(
    !effectiveScanId ? 'failed'
      : matchesScan && reviewStatus ? reviewStatus
        : items.length > 0 || (matchesScan && effectiveScanId.startsWith('scan_offline_')) ? 'ready' : 'pending'
  );
  const [loadError, setLoadError] = useState<string | null>(
    effectiveScanId ? null : 'Không tìm thấy bản quét. Vui lòng quay lại và quét ảnh mới.'
  );
  const [retryIndex, setRetryIndex] = useState(0);
  const canEdit = matchesScan && scanStatus === 'ready' && !isConfirming;
  const isConfirmed = matchesScan && scanStatus === 'confirmed';
  const acceptedCount = items.filter((item) => !item.rejected).length;
  const announcedStatus = useRef<string | null>(null);
  const [lifecycleAnnouncement, setLifecycleAnnouncement] = useState('');

  useEffect(() => {
    if (isConfirming || !restoreConfirmFocus.current) return;
    restoreConfirmFocus.current = false;
    // Native disabled buttons can drop focus during confirmation; never override a new focus target.
    if (document.activeElement === document.body) {
      confirmBarRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }
  }, [isConfirming, isConfirmed]);

  useEffect(() => {
    // Snapshot counts at transitions, not on every edit to the review list.
    if (announcedStatus.current === scanStatus) return;
    announcedStatus.current = scanStatus;
    setLifecycleAnnouncement(scanStatus === 'ready'
      ? `Kết quả quét đã sẵn sàng. Có ${items.length} nguyên liệu cần kiểm tra.`
      : scanStatus === 'confirmed'
        ? `Đã xác nhận ${acceptedCount} nguyên liệu.`
        : scanStatus === 'failed'
          ? `Bản quét không thể xử lý. ${loadError ?? pollError ?? 'Vui lòng thử lại.'}`
          : '');
  }, [scanStatus, items.length, acceptedCount, loadError, pollError]);

  useEffect(() => {
    if (!effectiveScanId || scanStatus !== 'pending') return;
    let cancelled = false;
    let attempts = 0;
    let timer: number | undefined;
    const isCurrent = capturePrivateSession();
    const active = () => !cancelled && isCurrent();
    const poll = async () => {
      if (!active()) return;
      try {
        const scan = await api.getScan(effectiveScanId);
        if (!active()) return;
        if (scan.id !== effectiveScanId) {
          setScanStatus('failed');
          setLoadError('Dữ liệu trả về không khớp với bản quét đang mở. Vui lòng tải lại.');
          return;
        }
        setPollError(null);
        if (scan.status === 'ready' || scan.status === 'confirmed') {
          setScanStatus(scan.status);
          void queryClient.invalidateQueries({ queryKey: queryKeys.me() });
          if (!active()) return;
          useScanStore.getState().setScanResults(effectiveScanId, scan.items || [], scan.status);
          return;
        }
        if (scan.status === 'failed') {
          const failure = describeScanFailure({
            code: scan.errorCode,
            scanType: scan.scanType === 'food' ? 'food' : 'fridge',
            quotaStatus: scan.quotaStatus,
            supportRef: scan.supportRef,
          });
          setScanStatus('failed');
          setPollError(failure.message);
          setFailureDetail({ quotaNote: failure.quotaNote, supportCode: failure.supportCode });
          void queryClient.invalidateQueries({ queryKey: queryKeys.me() });
          return;
        }
      } catch {
        if (!active()) return;
        setPollError('Không thể cập nhật trạng thái bản quét. Kiểm tra kết nối rồi thử lại.');
      }
      attempts += 1;
      if (active() && attempts < 45) {
        timer = window.setTimeout(poll, 2000);
      } else if (active()) {
        setPollError('Bản quét đang xử lý lâu hơn dự kiến. Bạn có thể kiểm tra lại hoặc chọn ảnh mới.');
      }
    };
    timer = window.setTimeout(poll, 500);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [effectiveScanId, scanStatus, retryIndex]);

  const handleEstimateExpiry = (id: string, days: number) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    const expiryDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    updateItem(id, { expiryDate, expiryEstimated: true });
  };

  const handleConfirm = async () => {
    if (items.length === 0 || !canEdit || useScanStore.getState().scanId !== effectiveScanId) return;
    const isCurrent = capturePrivateSession();
    const active = () => mounted.current && isCurrent()
      && useScanStore.getState().scanId === effectiveScanId;
    if (!active()) return;
    setConfirmError(null);
    restoreConfirmFocus.current = confirmBarRef.current?.contains(document.activeElement) ?? false;
    setIsConfirming(true);
    try {
      await api.confirmScan(effectiveScanId, items);
      if (!active()) return;
      void invalidateInventoryDependents();
      if (!active()) return;
      reset();
      navigate('/fridge');
    } catch (error) {
      if (!active()) return;
      const presentation = presentDomainError(error instanceof ApiError ? error.code : null,
        'Chưa lưu được nguyên liệu. Vui lòng thử lại.');
      if (presentation.refetch) {
        try {
          const scan = await api.getScan(effectiveScanId);
          if (!active()) return;
          if (scan.id !== effectiveScanId) throw new Error('Mismatched scan response');
          // Conflicts invalidate local edits; review authoritative evidence again.
          setScanStatus(scan.status === 'ready' || scan.status === 'confirmed' ? scan.status : 'failed');
          if (!active()) return;
          useScanStore.getState().setScanResults(effectiveScanId, scan.items || [],
            scan.status === 'ready' || scan.status === 'confirmed' ? scan.status : null);
          if (!active()) return;
          void invalidateInventoryDependents();
        } catch {
          if (!active()) return;
          setScanStatus('failed');
          if (!active()) return;
          setLoadError('Thông tin đã thay đổi nhưng chưa tải lại được. Vui lòng tải lại trước khi thử xác nhận.');
          if (!active()) return;
          setIsConfirming(false);
          return;
        }
      }
      if (!active()) return;
      setConfirmError(presentRefetchOutcome(presentation, presentation.refetch ? true : null).message);
      if (!active()) return;
      setIsConfirming(false);
    }
  };

  const handleAddManualItem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!addName.trim() || !canEdit) return;
    addItem({
      rawName: addName.trim(),
      estimatedQuantity: Number(addQty),
      unit: addUnit,
      storage: 'fridge',
    });
    setAddName('');
    setAddQty(1);
    setIsManualAddOpen(false);
  };

  return (
    <div className="min-h-screen bg-takosan-cream pb-28">
      <TopBar showBack title="Kết quả nhận diện AI"
        subtitle={isConfirmed ? 'Bản quét đã xác nhận · Chỉ xem' : 'Kiểm tra & chỉnh sửa trước khi xác nhận'} />

      <div className="px-4 pt-3 space-y-4">
        {scanStatus === 'pending' && <ScanProcessingState stage="analyzing" kind="fridge" compact />}
        <p role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="scan-lifecycle-status">
          {lifecycleAnnouncement}
        </p>
        {confirmError && <p role={isConfirmed ? undefined : 'alert'} className="text-sm text-semantic-danger-strong">{confirmError}</p>}
        {loadError && <p role={scanStatus === 'failed' ? undefined : 'alert'} className="text-sm text-semantic-danger-strong">
          {loadError}
          {effectiveScanId && <button className="ml-2 underline tap-target" onClick={() => {
            setLoadError(null);
            setScanStatus('pending');
            setRetryIndex((value) => value + 1);
          }}>Thử tải lại</button>}
        </p>}
        {/* Banner Alert */}
        <div className={scanStatus === 'failed'
          ? 'bg-semantic-danger-soft border border-semantic-danger/30 rounded-xl p-3.5 flex items-start gap-3'
          : 'bg-takosan-mint/80 border border-takosan-mint-deep/70 rounded-xl p-3.5 flex items-start gap-3'}
          >
          {scanStatus === 'failed'
            ? <AlertCircle className="w-5 h-5 text-semantic-danger shrink-0 mt-0.5" />
            : <CheckCircle2 className="w-5 h-5 text-takosan-green shrink-0 mt-0.5" />}
          <div className="text-xs">
            <p className="font-heading font-bold text-sm text-semantic-text-primary">
              {isConfirmed
                ? `Đã xác nhận ${acceptedCount} nguyên liệu`
                : items.length > 0
                ? `${items.length} nguyên liệu cần kiểm tra`
                : scanStatus === 'failed'
                  ? 'Bản quét không thể xử lý'
                  : scanStatus === 'ready'
                    ? 'Chưa có nguyên liệu trong danh sách'
                    : 'Đang chờ AI hoàn tất bản quét'}
            </p>
            <p className="text-semantic-text-secondary mt-0.5">
              {isConfirmed
                ? 'Thông tin bản quét đã được lưu. Bạn có thể xem hoặc chỉnh sửa lô từ trang tủ lạnh.'
                : items.length > 0
                ? 'Sửa tên, số lượng, đơn vị, nơi bảo quản, hạn dùng hoặc từ chối từng dòng trước khi lưu.'
                : scanStatus === 'failed'
                  ? 'Vui lòng quay lại và thử lại với ảnh khác.'
                  : scanStatus === 'ready'
                    ? 'Bạn có thể thêm nguyên liệu thủ công trước khi xác nhận.'
                    : 'Kết quả sẽ tự động xuất hiện khi queue xử lý xong.'}
            </p>
          </div>
        </div>
        {pollError && (
          <div role={scanStatus === 'pending' ? 'alert' : undefined} className="rounded-xl border border-semantic-warning/30 bg-semantic-warning-soft px-3 py-2 text-xs text-semantic-warning-strong flex items-center justify-between gap-3">
            <span>
              <span className="block">{pollError}</span>
              {scanStatus === 'failed' && failureDetail?.quotaNote && (
                <span className="block mt-0.5">{failureDetail.quotaNote}</span>
              )}
              {scanStatus === 'failed' && failureDetail?.supportCode && (
                <span className="block mt-0.5">Mã hỗ trợ: <span className="font-mono">{failureDetail.supportCode}</span></span>
              )}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              {scanStatus === 'pending' && (
                <button className="underline font-semibold" onClick={() => { setPollError(null); setRetryIndex((value) => value + 1); }}>
                  Kiểm tra lại
                </button>
              )}
              {scanStatus === 'failed' && (
                <button className="underline font-semibold" onClick={() => { reset(); navigate('/scan'); }}>
                  Quét ảnh mới
                </button>
              )}
            </div>
          </div>
        )}

        {/* Detected Items List */}
        <p className="text-xs text-semantic-text-secondary">
          Bản quét tủ lạnh bổ sung số lượng vào nguyên liệu phù hợp đã có; không đổi nơi bảo quản hay hạn dùng của lô cũ.
        </p>
        <form id="scan-review" className="space-y-3" onSubmit={(event) => {
          event.preventDefault();
          void handleConfirm();
        }}>
          {items.map((item, index) => {
            const confidence = presentConfidence(item.confidence);
            const persisted = item.sourceItemId !== undefined;
            const raw = item.rawEvidence;
            const corrected = raw && (
              (raw.rawName != null && raw.rawName !== item.rawName)
              || (raw.estimatedQuantity != null && raw.estimatedQuantity !== item.estimatedQuantity)
              || (raw.unit != null && raw.unit !== item.unit)
            );
            return (
              <article key={item.id} data-scan-item-id={item.id} aria-label={`Nguyên liệu ${index + 1}`}
                className={`rounded-xl p-3 border shadow-xs ${item.rejected ? 'bg-semantic-danger-soft border-semantic-danger/30' : 'bg-white border-semantic-border'}`}>
                <div className="flex items-start gap-3">
                  <img src={getIngredientImage(item.canonicalId ?? undefined, item.rawName)} alt=""
                    className="w-10 h-10 object-contain shrink-0" />
                  <div className="min-w-0 flex-1">
                    <h2 className="font-heading font-semibold text-sm text-semantic-text-primary break-words">{item.rawName}</h2>
                    {persisted ? (
                      <span className={`inline-block text-xs px-1.5 py-0.5 rounded font-semibold ${confidenceClass[confidence.tone]}`}>
                        {confidence.label}
                      </span>
                    ) : <span className="text-xs text-semantic-text-secondary">Nhập thủ công</span>}
                    {persisted && (
                      <p className="text-xs text-semantic-text-secondary mt-1 break-words" data-raw-evidence>
                        AI đọc: {raw
                          ? `${raw.rawName ?? 'Không rõ tên'} · ${raw.estimatedQuantity ?? 'Không rõ số lượng'} ${raw.unit ?? 'Không rõ đơn vị'}`
                          : 'Không có dữ liệu gốc'}
                      </p>
                    )}
                    {corrected && <p className="text-xs text-semantic-warning-strong mt-1">Đã chỉnh sửa so với dữ liệu gốc</p>}
                    {item.rejected && <p className="text-xs font-semibold text-semantic-danger-strong mt-1">Đã từ chối · Không thêm vào tủ lạnh</p>}
                  </div>
                  <button type="button" disabled={!canEdit}
                    onClick={() => persisted ? updateItem(item.id, { rejected: !item.rejected }) : removeItem(item.id)}
                    aria-pressed={persisted ? Boolean(item.rejected) : undefined}
                    className="p-2 rounded-lg text-semantic-danger-strong hover:bg-semantic-danger-soft tap-target shrink-0 text-xs font-semibold"
                    aria-label={persisted ? (item.rejected ? 'Khôi phục dòng này' : 'Từ chối dòng này') : 'Xóa dòng thủ công'}>
                    {persisted ? (item.rejected ? 'Khôi phục' : 'Từ chối') : <Trash2 className="w-4 h-4" />}
                  </button>
                </div>
                <fieldset disabled={!canEdit} className="mt-3 grid grid-cols-2 gap-3 min-w-0">
                  <label className="col-span-2 text-xs font-semibold text-semantic-text-secondary">
                    Tên nguyên liệu
                    <input className={fieldClass} value={item.rawName} required pattern=".*\S.*"
                      onChange={(event) => updateItem(item.id, { rawName: event.target.value })} />
                  </label>
                  <label className="text-xs font-semibold text-semantic-text-secondary">
                    Số lượng
                    <input className={fieldClass} type="number" min="0.001" max="10000" step="any" required
                      value={item.estimatedQuantity || ''}
                      onChange={(event) => updateItem(item.id, { estimatedQuantity: Number(event.target.value) })} />
                  </label>
                  <label className="text-xs font-semibold text-semantic-text-secondary">
                    Đơn vị
                    <select className={fieldClass} value={item.unit}
                      onChange={(event) => updateItem(item.id, { unit: event.target.value as StandardUnit })}>
                      {UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                    </select>
                  </label>
                  <label className="text-xs font-semibold text-semantic-text-secondary">
                    Bảo quản
                    <select className={fieldClass} value={item.storage}
                      onChange={(event) => updateItem(item.id, { storage: event.target.value as typeof item.storage })}>
                      <option value="fridge">Ngăn mát</option>
                      <option value="freezer">Ngăn đông</option>
                      <option value="pantry">Kệ bếp</option>
                    </select>
                  </label>
                  <label className="text-xs font-semibold text-semantic-text-secondary">
                    Hạn dùng
                    <input className={`${fieldClass} px-1`} type="date" value={item.expiryDate ?? ''}
                      onChange={(event) => updateItem(item.id, {
                        expiryDate: event.target.value || undefined, expiryEstimated: false,
                      })} />
                  </label>
                  <div className="col-span-2">
                    <p className="text-xs text-semantic-text-secondary" data-expiry-state>
                      {isConfirmed
                        // A confirmed line reports the review the server recorded
                        // (T13R-A P2-B): the accepted date, its estimate basis, or
                        // an explicit "no expiry accepted" — never a fresh guess.
                        ? (item.rejected ? 'Đã bỏ qua: không có hạn dùng'
                          : !item.expiryDate ? 'Đã xác nhận không rõ hạn dùng'
                            : item.expiryEstimated ? 'Hạn dùng ước tính đã xác nhận' : 'Ngày do bạn xác nhận')
                        : (!item.expiryDate ? 'Chưa rõ hạn dùng' : item.expiryEstimated ? 'Hạn dùng ước tính' : 'Ngày do bạn xác nhận')}
                    </p>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {[3, 7].map((days) => (
                        <button key={days} type="button" className="text-xs px-2 py-1.5 rounded-lg border border-semantic-border tap-target"
                          onClick={() => handleEstimateExpiry(item.id, days)}>Ước tính {days} ngày</button>
                      ))}
                      <button type="button" className="text-xs px-2 py-1.5 rounded-lg border border-semantic-border tap-target"
                        onClick={() => updateItem(item.id, { expiryDate: undefined, expiryEstimated: false })}>Không rõ hạn dùng</button>
                    </div>
                  </div>
                </fieldset>
              </article>
            );
          })}
        </form>

        {/* Add Missing Item Button */}
        {!isConfirmed && <Button
          variant="outline"
          fullWidth
          size="md"
          disabled={!canEdit}
          onClick={() => setIsManualAddOpen(true)}
          className="flex items-center justify-center gap-1.5 text-xs"
        >
          <Plus className="w-4 h-4 text-takosan-green" aria-hidden="true" />
          <span>Thêm nguyên liệu AI còn thiếu</span>
        </Button>}
      </div>

      {/* Fixed Confirm CTA Bar */}
      <div className="fixed bottom-[calc(68px+env(safe-area-inset-bottom,0px))] sm:bottom-0 left-0 right-0 sm:left-20 lg:left-64 p-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] bg-white/95 backdrop-blur-md border-t border-semantic-border z-40 shadow-lg">
        <div ref={confirmBarRef} className="mx-auto w-full max-w-[var(--content-wide)]">
          {isConfirmed ? <Button fullWidth size="lg" onClick={() => navigate('/fridge')}>
            Xem tủ lạnh
          </Button> : <Button
            fullWidth
            size="lg"
            type="submit"
            form="scan-review"
            isLoading={isConfirming}
            disabled={items.length === 0 || !canEdit}
            className="flex items-center justify-center gap-2"
          >
            <CheckCircle2 className="w-5 h-5" />
            <span>Xác nhận nguyên liệu ({acceptedCount} món)</span>
          </Button>}
        </div>
      </div>

      {/* Manual add sheet (components/BOTTOM_SHEET.md): labelled modal with
          focus trap, Escape and focus return. */}
      <BottomSheet open={isManualAddOpen && canEdit} title="Thêm nguyên liệu thủ công" onClose={() => setIsManualAddOpen(false)}>
        <form onSubmit={handleAddManualItem} className="space-y-3.5">
          <div>
            <label htmlFor="scan-add-name" className="block text-xs font-semibold text-semantic-text-secondary mb-1.5">Tên nguyên liệu</label>
            <input
              id="scan-add-name"
              type="text"
              required
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder="Ví dụ: Nấm hương, Hành lá..."
              className="w-full h-11 px-3 rounded-lg border border-semantic-border text-sm font-medium text-semantic-text-primary bg-white focus:border-takosan-green focus:outline-none transition-colors"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="scan-add-quantity" className="block text-xs font-semibold text-semantic-text-secondary mb-1.5">Số lượng</label>
              <input
                id="scan-add-quantity"
                type="number"
                min="0.001"
                max="10000"
                step="any"
                required
                value={addQty}
                onChange={(e) => setAddQty(Number(e.target.value))}
                className="w-full h-11 px-3 rounded-lg border border-semantic-border text-sm font-medium text-semantic-text-primary bg-white focus:border-takosan-green focus:outline-none transition-colors"
              />
            </div>

            <div>
              <label htmlFor="scan-add-unit" className="block text-xs font-semibold text-semantic-text-secondary mb-1.5">Đơn vị</label>
              <select
                id="scan-add-unit"
                value={addUnit}
                onChange={(e) => setAddUnit(e.target.value as StandardUnit)}
                className="w-full h-11 px-2.5 rounded-lg border border-semantic-border text-xs font-semibold text-semantic-text-primary bg-white focus:border-takosan-green focus:outline-none transition-colors"
              >
                {UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
              </select>
            </div>
          </div>

          <div className="pt-2">
            <Button fullWidth size="md" type="submit">
              Thêm vào danh sách
            </Button>
          </div>
        </form>
      </BottomSheet>
    </div>
  );
};
