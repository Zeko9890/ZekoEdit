import path from 'node:path';
import { access, mkdir } from 'node:fs/promises';
import { FFPROBE, FFMPEG, run, assertToolchain } from './ffmpeg';
import { dataDir, LIMITS } from './env';

/**
 * Boot-time self check. It is deliberately cached: `/api/health` is polled by the
 * UI, and spawning FFmpeg every few seconds would be wasteful.
 */

export interface HealthReport {
  ok: boolean;
  ffmpeg: { path: string; version: string | null; ok: boolean; error?: string };
  ffprobe: { path: string; ok: boolean; error?: string };
  libass: boolean;
  encoders: { libx264: boolean; aac: boolean };
  dataDir: string;
  dataWritable: boolean;
  limits: typeof LIMITS;
  model: string;
}

let cached: { report: HealthReport; at: number } | null = null;
const TTL_MS = 30_000;

function firstLine(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim().length > 0);
  return line ? line.trim().slice(0, 160) : null;
}

export async function checkHealth(force = false): Promise<HealthReport> {
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.report;

  const report: HealthReport = {
    ok: false,
    ffmpeg: { path: FFMPEG, version: null, ok: false },
    ffprobe: { path: FFPROBE, ok: false },
    libass: false,
    encoders: { libx264: false, aac: false },
    dataDir: dataDir(),
    dataWritable: false,
    limits: LIMITS,
    model: process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
  };

  try {
    await assertToolchain();
    report.ffmpeg.ok = true;
    report.ffprobe.ok = true;

    const version = await run(FFMPEG, ['-hide_banner', '-version'], 20_000);
    report.ffmpeg.version = firstLine(version.stdout) ?? firstLine(version.stderr);

    const filters = await run(FFMPEG, ['-hide_banner', '-filters'], 20_000);
    report.libass = /\sass\s/.test(filters.stdout);

    const encoders = await run(FFMPEG, ['-hide_banner', '-encoders'], 20_000);
    report.encoders.libx264 = /libx264/.test(encoders.stdout);
    report.encoders.aac = /\saac\s/.test(encoders.stdout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.ffmpeg.error = message.slice(0, 300);
    report.ffprobe.error = report.ffmpeg.ok ? 'ffprobe missing' : 'not checked — ffmpeg unavailable';
  }

  try {
    await mkdir(report.dataDir, { recursive: true });
    await access(report.dataDir);
    report.dataWritable = true;
  } catch {
    report.dataWritable = false;
  }

  report.ok = report.ffmpeg.ok && report.ffprobe.ok && report.dataWritable;

  cached = { report, at: Date.now() };
  return report;
}
