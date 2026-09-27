import { Env } from '../types';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
// Cloudflare publishes this pair for automated tests. Staging advertises the test site key,
// so a retained real Worker secret must not make every registration fail.
const STAGING_TEST_SITE_KEY = '1x00000000000000000000AA';
const STAGING_TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';

export async function verifyTurnstileToken(
  env: Env,
  token: unknown,
  clientIp?: string
): Promise<{ ok: boolean; error?: string }> {
  const stagingTestWidget = env.ENVIRONMENT === 'staging' && env.TURNSTILE_SITE_KEY?.trim() === STAGING_TEST_SITE_KEY;
  const secret = stagingTestWidget ? STAGING_TEST_SECRET_KEY : env.TURNSTILE_SECRET_KEY?.trim();
  if (env.ENVIRONMENT === 'production' && (!secret || !env.TURNSTILE_SITE_KEY?.trim())) {
    return { ok: false, error: 'Turnstile chưa được cấu hình' };
  }
  if (!secret) {
    return { ok: env.ENVIRONMENT === 'development' };
  }

  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'Thiếu mã xác thực Turnstile' };
  }

  try {
    const body = new FormData();
    body.append('secret', secret);
    body.append('response', token);
    if (clientIp) body.append('remoteip', clientIp);

    const res = await fetch(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(8000) });
    const data = (await res.json()) as { success: boolean; 'error-codes'?: string[] };

    if (res.ok && data.success === true) return { ok: true };
    return { ok: false, error: `Turnstile: ${(data['error-codes'] || ['unknown']).join(',')}` };
  } catch {
    console.error(JSON.stringify({ event: 'turnstile_verification_failed' }));
    return { ok: false, error: 'Không thể xác minh Turnstile' };
  }
}
