import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useScanStore } from '../stores/useScanStore';
import { api } from '../services/api';
import { CameraViewfinder } from '../components/scan/CameraViewfinder';
import { ScanProcessingState, type ScanProcessingStage } from '../components/scan/ScanProcessingState';
import { ArrowLeft, AlertCircle } from 'lucide-react';
import { clsx } from 'clsx';
import { capturePrivateSession } from '../lib/private-session';
import { readPrivateImage } from '../lib/private-image';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/queryKeys';
import { scanFailureFromError, type ScanFailure } from '../lib/scan-errors';
import { ScanQuotaBadge } from '../components/scan/ScanQuotaBadge';

// Quota is reserved/refunded server-side on every POST outcome; re-read it.
function refreshServerQuota() {
  void queryClient.invalidateQueries({ queryKey: queryKeys.me() });
}

export const ScanPage: React.FC = () => {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const commandRef = useRef<{ id: string; image: string; type: string; owner: string } | null>(null);
  const inFlight = useRef(false);
  const cancelRead = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    cancelRead.current?.();
    commandRef.current = null;
  }, []);

  const {
    imagePreviewUrl,
    isProcessing,
    statusText,
    setImage,
    setScanType,
    setProcessing,
    setScanResults,
    reset,
  } = useScanStore();

  const [activeTab, setActiveTab] = useState<'fridge' | 'food' | 'receipt'>('fridge');
  const [failure, setFailure] = useState<ScanFailure | null>(null);
  const [processingStage, setProcessingStage] = useState<ScanProcessingStage>('uploading');

  const tabs = [
    { id: 'fridge' as const, label: 'Tủ lạnh' },
    { id: 'food' as const, label: 'Thực phẩm' },
    { id: 'receipt' as const, label: 'Hóa đơn' },
  ];

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    cancelRead.current?.();
    commandRef.current = null;
    setFailure(null);
    cancelRead.current = readPrivateImage(file, (base64) => {
      setImage(base64, base64);
      void startAIScan(base64);
    });
  };

  const chooseAnotherImage = () => {
    cancelRead.current?.();
    commandRef.current = null;
    setFailure(null);
    reset();
    setScanType(activeTab);
  };

  const startAIScan = async (base64: string) => {
    if (inFlight.current) return;
    const owner = `${localStorage.getItem('frigo_user_id')}:${localStorage.getItem('frigo_household_id')}`;
    if (!commandRef.current || commandRef.current.image !== base64 || commandRef.current.type !== activeTab || commandRef.current.owner !== owner) {
      commandRef.current = { id: crypto.randomUUID(), image: base64, type: activeTab, owner };
    }
    const commandId = commandRef.current.id;
    const sessionIsCurrent = capturePrivateSession();
    const isCurrent = () => sessionIsCurrent() && commandRef.current?.id === commandId;
    const stageTimers: ReturnType<typeof setTimeout>[] = [];
    const scheduleStage = (stage: ScanProcessingStage, text: string, delay: number) => {
      stageTimers.push(setTimeout(() => {
        if (isCurrent()) { setProcessingStage(stage); setProcessing(true, text); }
      }, delay));
    };
    inFlight.current = true;
    setFailure(null);
    if (activeTab === 'receipt') {
      setProcessingStage('uploading');
      setProcessing(true, 'Đang quét hóa đơn mua sắm...');
      try {
        scheduleStage('queued', 'Đã nhận ảnh, đang xếp hàng xử lý...', 450);
        scheduleStage('analyzing', 'AI Vision đang nhận diện tên hàng & đơn giá...', 1100);
        scheduleStage('validating', 'Bóc tách mặt hàng và kiểm tra đối chiếu...', 2200);

        const receiptRes = await api.scanReceipt(base64, commandId);

        if (!isCurrent()) return;
        setProcessing(false);
        navigate(`/scan/receipt-review?scanId=${encodeURIComponent(receiptRes.id)}`);
      } catch (error) {
        if (!isCurrent()) return;
        setFailure(scanFailureFromError(error, 'receipt'));
        setProcessing(false);
      } finally {
        stageTimers.forEach(clearTimeout);
        inFlight.current = false;
        refreshServerQuota();
      }
      return;
    }

    setProcessing(true, 'Đang tải ảnh lên...');
    setProcessingStage('uploading');
    try {
      scheduleStage('queued', 'Đã nhận ảnh, đang xếp hàng xử lý...', 450);
      scheduleStage('analyzing', 'AI Vision đang nhận diện nguyên liệu...', 1100);
      scheduleStage('validating', 'Chuẩn hóa định lượng & kiểm tra độ tươi...', 2200);

      const scanRes = await api.scanFridge(base64, activeTab, commandId);

      if (!isCurrent()) return;
      setScanResults(scanRes.id, scanRes.items);
      navigate(`/scan/${scanRes.id}/review`);
    } catch (error) {
      if (!isCurrent()) return;
      setFailure(scanFailureFromError(error, activeTab));
      setProcessing(false);
    } finally {
      // Delayed presentation stages must not restart processing after failure.
      stageTimers.forEach(clearTimeout);
      inFlight.current = false;
      refreshServerQuota();
    }
  };

  return (
    <div className="min-h-screen bg-takosan-navy text-white flex flex-col justify-between p-4 relative overflow-hidden select-none">
      {/* Top Header: the page heading is visually the mode switcher, so the
          h1 is screen-reader-only (one h1 per surface). */}
      <h1 className="sr-only">Quét nguyên liệu bằng AI</h1>
      <div className="flex items-center justify-between z-10 pt-2">
        <button
          onClick={() => {
            reset();
            navigate('/');
          }}
          className="w-10 h-10 rounded-xl bg-white/10 hover:bg-white/20 active:scale-95 text-white flex items-center justify-center tap-target transition-tap"
          aria-label="Quay lại"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        {/* Tab Pills */}
        <div className="flex bg-semantic-overlay/50 rounded-xl p-1 backdrop-blur-md border border-white/10" role="group" aria-label="Chế độ quét">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-pressed={activeTab === tab.id}
              onClick={() => {
                setActiveTab(tab.id);
                setScanType(tab.id);
              }}
              className={clsx(
                'px-3.5 py-1.5 rounded-lg text-xs font-heading font-semibold transition-tap relative tap-target',
                activeTab === tab.id
                  ? 'bg-takosan-green text-white shadow-xs'
                  : 'text-white hover:text-white'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="w-10" />
      </div>

      <div className="z-10 flex justify-center pt-2 min-h-[26px]">
        <ScanQuotaBadge />
      </div>

      {/* Viewfinder Area */}
      <div className="flex-1 flex flex-col items-center justify-center my-2 z-10 w-full max-w-sm mx-auto">
        <div className="relative w-full">
          {imagePreviewUrl ? (
            <div className="relative w-full h-[360px] sm:h-[420px] rounded-2xl overflow-hidden border border-white/20 bg-black/40 shadow-2xl flex items-center justify-center">
              <img src={imagePreviewUrl} alt="Ảnh vừa chọn để quét" className="w-full h-full object-cover" />
            </div>
          ) : (
            <CameraViewfinder
              scanType={activeTab}
              onCapture={(base64) => {
                commandRef.current = null;
                setImage(base64, base64);
                startAIScan(base64);
              }}
              onSelectFromGallery={() => fileInputRef.current?.click()}
            />
          )}

          {/* Processing Overlay */}
          {isProcessing && (
            <div className="absolute inset-0 bg-semantic-overlay/85 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center z-30 rounded-2xl animate-fade-in">
              <div className="w-full max-w-sm"><ScanProcessingState stage={processingStage} kind={activeTab === 'receipt' ? 'receipt' : 'fridge'} /></div>
              <p className="sr-only">{statusText}</p>
            </div>
          )}
        </div>

        {failure && (
          <div
            role="alert"
            data-testid="scan-failure"
            data-code={failure.code}
            className="mt-3 bg-semantic-danger/25 border border-semantic-danger/50 rounded-xl p-3 text-xs text-white flex items-start gap-2 max-w-sm w-full"
          >
            <AlertCircle className="w-4 h-4 shrink-0 text-white mt-0.5" />
            <div className="min-w-0 flex-1 space-y-1">
              <p>{failure.message}</p>
              {failure.quotaNote && <p className="text-white/85">{failure.quotaNote}</p>}
              {failure.supportCode && (
                <p className="text-white/75">Mã hỗ trợ: <span className="font-mono">{failure.supportCode}</span></p>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
                {(failure.action === 'choose-image' || failure.action === 'new-scan') && (
                  <button type="button" className="underline font-semibold" onClick={chooseAnotherImage}>Chọn ảnh khác</button>
                )}
                {failure.action === 'upgrade' && (
                  <button type="button" className="underline font-semibold" onClick={() => navigate('/plus')}>Xem gói Plus</button>
                )}
                {failure.canRetry && (
                  <button type="button" className="underline" onClick={() => {
                    if (commandRef.current) void startAIScan(commandRef.current.image);
                  }}>Thử lại</button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Hidden File Input for fallback gallery upload */}
      <input
        type="file"
        ref={fileInputRef}
        accept="image/*"
        onChange={handleFileChange}
        className="hidden"
      />

    </div>
  );
};
