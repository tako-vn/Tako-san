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
import { ApiError } from '../services/http';
import { scanApiErrorMessage, type ScanQuota } from '../lib/scan-errors';

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
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [retryIsRecovery, setRetryIsRecovery] = useState(false);
  const [quota, setQuota] = useState<ScanQuota | null>(null);
  const [processingStage, setProcessingStage] = useState<ScanProcessingStage>('uploading');

  const refreshQuota = async () => {
    const isCurrent = capturePrivateSession();
    try {
      const me = await api.getMe({ requireServer: true });
      if (isCurrent()) setQuota(me?.user?.subscription ?? null);
    } catch {
      if (isCurrent()) setQuota(null);
    }
  };

  useEffect(() => { void refreshQuota(); }, []);

  const tabs = [
    { id: 'fridge' as const, label: 'Tủ lạnh' },
    { id: 'food' as const, label: 'Nguyên liệu' },
    { id: 'receipt' as const, label: 'Hóa đơn' },
  ];

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    cancelRead.current?.();
    commandRef.current = null;
    setErrorMsg(null);
    setErrorCode(null);
    setRetryIsRecovery(false);
    cancelRead.current = readPrivateImage(file, (base64) => {
      setImage(base64, base64);
      void startAIScan(base64);
    });
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
    setErrorMsg(null);
    setErrorCode(null);
    setRetryIsRecovery(false);
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
        void refreshQuota();
        navigate(`/scan/receipt-review?scanId=${encodeURIComponent(receiptRes.id)}`);
      } catch (error) {
        if (!isCurrent()) return;
        setErrorCode(error instanceof ApiError ? error.code : null);
        setRetryIsRecovery(error instanceof ApiError && (error.kind === 'offline' && error.retryable === true
            || ['QUEUE_UNAVAILABLE', 'NETWORK_ERROR'].includes(error.code || ''))
          && (error.payload?.scan as { status?: string } | undefined)?.status !== 'failed');
        setErrorMsg(scanApiErrorMessage(error, 'receipt', quota));
        void refreshQuota();
        setProcessing(false);
      } finally {
        stageTimers.forEach(clearTimeout);
        inFlight.current = false;
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
      void refreshQuota();
      setScanResults(scanRes.id, scanRes.items);
      navigate(`/scan/${scanRes.id}/review`);
    } catch (error) {
      if (!isCurrent()) return;
      setErrorCode(error instanceof ApiError ? error.code : null);
      setRetryIsRecovery(error instanceof ApiError && (error.kind === 'offline' && error.retryable === true
          || ['QUEUE_UNAVAILABLE', 'NETWORK_ERROR'].includes(error.code || ''))
        && (error.payload?.scan as { status?: string } | undefined)?.status !== 'failed');
      setErrorMsg(scanApiErrorMessage(error, activeTab, quota));
      void refreshQuota();
      setProcessing(false);
    } finally {
      // Delayed presentation stages must not restart processing after failure.
      stageTimers.forEach(clearTimeout);
      inFlight.current = false;
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

      {quota?.plan === 'free' && (
        <p className="z-10 mx-auto mt-3 text-xs text-white/85" data-testid="scan-quota">
          Còn {quota.remaining}/{quota.limit} lượt quét miễn phí trong tháng
        </p>
      )}

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

        {errorMsg && (
          <div role="alert" className="mt-3 bg-semantic-danger/25 border border-semantic-danger/50 rounded-xl p-3 text-xs text-white flex items-center gap-2 max-w-sm w-full">
            <AlertCircle className="w-4 h-4 shrink-0 text-white" />
            <span>{errorMsg}</span>
            {errorCode !== 'SCAN_QUOTA_EXCEEDED' && (
              <button className="underline shrink-0" onClick={() => {
                if (!commandRef.current) return;
                const image = commandRef.current.image;
                if (!retryIsRecovery) commandRef.current = null;
                void startAIScan(image);
              }}>{retryIsRecovery ? 'Kiểm tra lại' : 'Thử xử lý lại'}</button>
            )}
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
