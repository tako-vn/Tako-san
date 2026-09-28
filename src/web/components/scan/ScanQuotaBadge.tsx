import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';
import { queryClient } from '../../lib/query-client';
import { queryKeys } from '../../lib/queryKeys';
import { formatScanQuota, type ScanQuotaSnapshot } from '../../lib/scan-errors';

/**
 * Remaining scans from `/me` (server subscription + ledger), never a client
 * counter. Uses the app's singleton client so it also renders outside the
 * provider; renders nothing while unknown instead of blocking a scan.
 */
export const ScanQuotaBadge: React.FC = () => {
  const { data } = useQuery({
    queryKey: queryKeys.me(),
    queryFn: () => api.getMe(),
    staleTime: 30_000,
    retry: false,
  }, queryClient);
  const line = formatScanQuota((data as { user?: { subscription?: ScanQuotaSnapshot | null } } | undefined)?.user?.subscription);
  if (!line) return null;
  return (
    <p
      data-testid="scan-quota"
      className="rounded-full bg-semantic-overlay/75 border border-white/15 px-3 py-1 text-[11px] font-semibold text-white"
    >
      {line}
    </p>
  );
};
