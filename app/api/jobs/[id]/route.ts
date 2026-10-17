import { NextResponse } from 'next/server';
import { getJob, snapshot } from '@/lib/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: { id: string } }) {
  const job = getJob(context.params.id);
  if (!job) {
    return NextResponse.json(
      {
        error: {
          code: 'job_missing',
          message: 'This edit is no longer in memory.',
          hint: 'Jobs live in memory only. Restart means re-uploading. Start a new edit.',
        },
      },
      { status: 404 },
    );
  }

  return NextResponse.json(snapshot(job), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
