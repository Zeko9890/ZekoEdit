import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getJob } from '@/lib/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serves only files we generated inside the job's own directory. `kind` is an
 * allowlist, never a path — a caller cannot walk out of the job folder.
 */
const FILES: Record<string, { file: string; type: string; downloadName: string }> = {
  video: { file: 'output.mp4', type: 'video/mp4', downloadName: 'zekoedit-short.mp4' },
  plan: { file: 'edit-plan.json', type: 'application/json', downloadName: 'zekoedit-edit-plan.json' },
};

function parseRange(rangeHeader: string | null, size: number): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  let start = startRaw ? Number(startRaw) : 0;
  let end = endRaw ? Number(endRaw) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  start = Math.max(0, Math.min(start, size - 1));
  end = Math.max(start, Math.min(end, size - 1));
  return { start, end };
}

export async function GET(request: Request, context: { params: { id: string; kind: string } }) {
  const { id, kind } = context.params;
  const job = getJob(id);
  if (!job) {
    return NextResponse.json({ error: { code: 'job_missing', message: 'This edit is no longer in memory.' } }, { status: 404 });
  }
  if (job.stage !== 'done') {
    return NextResponse.json(
      { error: { code: 'not_ready', message: 'The render is not finished yet.' } },
      { status: 409 },
    );
  }

  const entry = FILES[kind];
  if (!entry) {
    return NextResponse.json({ error: { code: 'not_found', message: 'Unknown media type.' } }, { status: 404 });
  }

  const filePath = path.join(job.dir, entry.file);
  const info = await stat(filePath).catch(() => null);
  if (!info || !info.isFile()) {
    return NextResponse.json(
      { error: { code: 'file_missing', message: 'The rendered file is missing from disk.' } },
      { status: 404 },
    );
  }

  const url = new URL(request.url);
  const download = url.searchParams.get('download') === '1';
  const disposition = `${download ? 'attachment' : 'inline'}; filename="${entry.downloadName}"`;
  const range = parseRange(request.headers.get('range'), info.size);

  const baseHeaders: Record<string, string> = {
    'Content-Type': entry.type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Disposition': disposition,
    'X-Content-Type-Options': 'nosniff',
  };

  if (range) {
    const stream = createReadStream(filePath, { start: range.start, end: range.end });
    return new NextResponse(stream as unknown as ReadableStream, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
        'Content-Length': String(range.end - range.start + 1),
      },
    });
  }

  const stream = createReadStream(filePath);
  return new NextResponse(stream as unknown as ReadableStream, {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(info.size) },
  });
}
