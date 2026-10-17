import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { FFMPEG, probe, run } from './ffmpeg';
import { AppError, safeLog } from './errors';

/**
 * Multimodal evidence extraction.
 *
 * Gemini accepts video directly, but we do not rely on it for anything numeric
 * that must be exact: shot boundaries, loudness and silence are measured by
 * FFmpeg. Frames give the model a stable, cheap view of composition, caption
 * styling and layout; the downmixed audio track gives it speech.
 */

export interface FrameSample {
  path: string;
  filename: string;
  timestampSeconds: number;
  base64: string;
  mimeType: string;
}

export interface Loudness {
  integratedLufs: number | null;
  truePeak: number | null;
  silenceRegions: Array<{ start: number; end: number }>;
}

export interface VideoEvidence {
  path: string;
  filename: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  frames: FrameSample[];
  audioPath?: string;
  audioBytes: number;
  audioMime: string;
  sceneCuts: number[];
  averageShotSeconds: number | null;
  loudness: Loudness;
}

function hashPath(p: string): string {
  return createHash('sha1').update(p).digest('hex').slice(0, 8);
}

/** Evenly spaced sample times, nudged off the very start/end where frames are often black. */
export function sampleTimestamps(duration: number, count: number): number[] {
  if (duration <= 0 || count <= 0) return [];
  const inset = Math.min(0.35, duration * 0.02);
  const usable = Math.max(0.1, duration - inset * 2);
  const step = usable / count;
  return Array.from({ length: count }, (_, i) => Number((inset + step * (i + 0.5)).toFixed(3))).filter(
    (t) => t < duration,
  );
}

async function extractFrames(
  videoPath: string,
  outDir: string,
  duration: number,
  count: number,
): Promise<FrameSample[]> {
  await mkdir(outDir, { recursive: true });
  const timestamps = sampleTimestamps(duration, count);
  const frames: FrameSample[] = [];

  for (let i = 0; i < timestamps.length; i += 1) {
    const t = timestamps[i];
    const filename = `frame_${String(i).padStart(3, '0')}.jpg`;
    const outPath = path.join(outDir, filename);
    const res = await run(
      FFMPEG,
      [
        '-hide_banner', '-loglevel', 'error',
        '-ss', String(t),
        '-i', videoPath,
        '-frames:v', '1',
        '-vf', 'scale=480:-2:flags=lanczos',
        '-q:v', '3',
        '-y', outPath,
      ],
      90_000,
    );
    if (res.code !== 0) {
      // A frame at the very end can fail; that is not fatal for analysis.
      safeLog('frame extraction skipped at', t, res.stderr.slice(-200));
      continue;
    }
    try {
      const bytes = await readFile(outPath);
      frames.push({
        path: outPath,
        filename,
        timestampSeconds: t,
        base64: bytes.toString('base64'),
        mimeType: 'image/jpeg',
      });
    } catch {
      /* skip unreadable frame */
    }
  }
  return frames;
}

async function extractAudio(videoPath: string, outPath: string): Promise<boolean> {
  // Write the primary attempt somewhere the caller will never read, so a failed
  // libopus pass cannot leave a zero-byte .ogg that looks like real audio.
  const staging = outPath.replace(/\.(ogg|m4a)$/, '.staging.ogg');
  const res = await run(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error',
      '-i', videoPath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-y', staging,
    ],
    5 * 60_000,
  );

  const { rename, stat } = await import('node:fs/promises');
  if (res.code === 0) {
    const info = await stat(staging).catch(() => null);
    if (info && info.size > 1024) {
      await rename(staging, outPath);
      return true;
    }
  }

  // Fall back to AAC mono if libopus is missing from this build.
  const aacPath = outPath.replace(/\.ogg$/, '.m4a');
  const retry = await run(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error',
      '-i', videoPath,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '48k',
      '-y', aacPath,
    ],
    5 * 60_000,
  );
  if (retry.code !== 0) return false;
  const info = await stat(aacPath).catch(() => null);
  return Boolean(info && info.size > 1024);
}

export async function detectSceneCuts(videoPath: string, duration: number): Promise<number[]> {
  const res = await run(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'info',
      '-i', videoPath,
      '-vf', "select='gt(scene,0.32)',showinfo",
      '-vsync', 'vfr',
      '-an',
      '-f', 'null',
      '-',
    ],
    5 * 60_000,
  );
  const cuts: number[] = [];
  const re = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(res.stderr)) !== null) {
    const t = Number(match[1]);
    if (Number.isFinite(t) && t > 0.15 && t < duration - 0.15) cuts.push(Number(t.toFixed(2)));
  }
  const unique = [...new Set(cuts)].sort((a, b) => a - b).slice(0, 400);
  return unique;
}

export async function measureLoudness(videoPath: string): Promise<Loudness> {
  const result: Loudness = { integratedLufs: null, truePeak: null, silenceRegions: [] };

  const res = await run(
    FFMPEG,
    [
      '-hide_banner',
      '-i', videoPath,
      '-af', 'ebur128=peak=true',
      '-f', 'null',
      '-',
    ],
    5 * 60_000,
  );
  const summary = res.stderr.slice(res.stderr.lastIndexOf('Summary:'));
  const i = summary.match(/I:\s*(-?[0-9.]+)\s*LUFS/);
  const peak = summary.match(/Peak:\s*(-?[0-9.]+)\s*dBFS/);
  if (i) result.integratedLufs = Number(i[1]);
  if (peak) result.truePeak = Number(peak[1]);

  const silence = await run(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'info',
      '-i', videoPath,
      '-af', 'silencedetect=noise=-38dB:d=1.1',
      '-f', 'null',
      '-',
    ],
    5 * 60_000,
  );
  const starts = [...silence.stderr.matchAll(/silence_start:\s*(-?[0-9.]+)/g)].map((m) => Number(m[1]));
  const ends = [...silence.stderr.matchAll(/silence_end:\s*(-?[0-9.]+)/g)].map((m) => Number(m[1]));
  result.silenceRegions = starts
    .map((start, idx) => ({ start: Number(start.toFixed(2)), end: Number((ends[idx] ?? start + 1).toFixed(2)) }))
    .filter((r) => r.end > r.start)
    .slice(0, 60);

  return result;
}

export async function extractVideoEvidence(options: {
  videoPath: string;
  filename: string;
  workDir: string;
  frameCount: number;
  wantAudio: boolean;
}): Promise<VideoEvidence> {
  const { videoPath, filename, workDir, frameCount, wantAudio } = options;
  const tag = hashPath(videoPath);

  let meta;
  try {
    meta = await probe(videoPath);
  } catch (err) {
    throw new AppError('unreadable_video', `Could not read "${filename}".`, {
      hint: (err as Error).message,
    });
  }

  const frames = await extractFrames(videoPath, path.join(workDir, `frames_${tag}`), meta.duration, frameCount);

  let audioPath: string | undefined;
  let audioBytes = 0;
  let audioMime = 'audio/ogg';
  if (wantAudio && meta.hasAudio) {
    const oggPath = path.join(workDir, `audio_${tag}.ogg`);
    const ok = await extractAudio(videoPath, oggPath);
    if (ok) {
      const candidates = [oggPath, oggPath.replace(/\.ogg$/, '.m4a')];
      for (const candidate of candidates) {
        try {
          const bytes = await readFile(candidate);
          audioPath = candidate;
          audioBytes = bytes.length;
          audioMime = candidate.endsWith('.m4a') ? 'audio/mp4' : 'audio/ogg';
          break;
        } catch {
          /* try next candidate */
        }
      }
    }
  }

  const [sceneCuts, loudness] = await Promise.all([
    detectSceneCuts(videoPath, meta.duration),
    meta.hasAudio ? measureLoudness(videoPath) : Promise.resolve<Loudness>({ integratedLufs: null, truePeak: null, silenceRegions: [] }),
  ]);

  const measuredAverage =
    sceneCuts.length >= 2 ? Number((meta.duration / (sceneCuts.length + 1)).toFixed(2)) : null;

  return {
    path: videoPath,
    filename,
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
    fps: Number(meta.fps.toFixed(2)),
    hasAudio: meta.hasAudio,
    frames,
    audioPath,
    audioBytes,
    audioMime,
    sceneCuts,
    averageShotSeconds: measuredAverage,
    loudness,
  };
}

/** Human-readable evidence summary used inside prompts. Numbers come from FFmpeg, not from the model. */
export function describeMeasurements(evidence: VideoEvidence): string {
  const lines: string[] = [];
  lines.push(`file: ${evidence.filename}`);
  lines.push(`duration: ${evidence.duration.toFixed(2)}s`);
  lines.push(`resolution: ${evidence.width}x${evidence.height} @ ${evidence.fps}fps`);
  lines.push(`audio stream: ${evidence.hasAudio ? 'yes' : 'no'}`);
  if (evidence.sceneCuts.length > 0) {
    lines.push(
      `detected shot changes (seconds): ${evidence.sceneCuts.slice(0, 40).join(', ')}${
        evidence.sceneCuts.length > 40 ? ` … (+${evidence.sceneCuts.length - 40} more)` : ''
      }`,
    );
    if (evidence.averageShotSeconds) {
      lines.push(`measured average shot length: ${evidence.averageShotSeconds}s`);
    }
  } else {
    lines.push('detected shot changes: none above the FFmpeg scene threshold (likely one continuous take)');
  }
  if (evidence.loudness.integratedLufs !== null) {
    lines.push(`integrated loudness: ${evidence.loudness.integratedLufs} LUFS`);
  }
  if (evidence.loudness.silenceRegions.length > 0) {
    const regions = evidence.loudness.silenceRegions
      .slice(0, 12)
      .map((r) => `${r.start}-${r.end}s`)
      .join(', ');
    lines.push(`silent stretches >1.1s: ${regions}`);
  }
  lines.push(`sampled frames at: ${evidence.frames.map((f) => `${f.timestampSeconds}s`).join(', ') || 'none'}`);
  return lines.join('\n');
}
