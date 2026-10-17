import { NextResponse } from 'next/server';
import { checkHealth } from '@/lib/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/health?refresh=1 — the UI uses this to warn about missing FFmpeg before upload. */
export async function GET(request: Request) {
  const refresh = new URL(request.url).searchParams.get('refresh') === '1';
  const report = await checkHealth(refresh);
  return NextResponse.json(report, {
    status: report.ok ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
