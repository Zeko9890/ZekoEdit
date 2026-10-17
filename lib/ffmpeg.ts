import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

/**
 * FFmpeg resolution order:
 *   1. FFMPEG_PATH / FFPROBE_PATH env (absolute path you control)
 *   2. ffmpeg-static / ffprobe-static bundled binaries from node_modules
 *   3. `ffmpeg` / `ffprobe` on PATH
 * The bundled binaries cover Windows/macOS/Linux with no system install, which
 * is what makes the local MVP portable. Run `npm run check:env` to verify.
 */

export class FfmpegUnavailableError extends Error {
  code = 'ffmpeg_missing';
}

function resolveBinary(options: {
  envVar: string;
  bundled: string | null;
  fallback: string;
}): string {
  const fromEnv = process.env[options.envVar];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  if (options.bundled && existsSync(options.bundled)) {
    // ffmpeg-static ships a binary inside asar on some packagings; normal installs are fine.
    return options.bundled;
  }
  return options.fallback;
}

export const FFMPEG = resolveBinary({
  envVar: 'FFMPEG_PATH',
  bundled: (ffmpegStatic as unknown as string) || null,
  fallback: process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
});

export const FFPROBE = resolveBinary({
  envVar: 'FFPROBE_PATH',
  bundled: (ffprobeStatic as unknown as { path: string }).path || null,
  fallback: process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
});

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const activeChildren = new Set<import('node:child_process').ChildProcess>();

export function killAll(): void {
  for (const child of activeChildren) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  activeChildren.clear();
}

export function run(bin: string, args: string[], timeoutMs = 10 * 60_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child: import('node:child_process').ChildProcess;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (err) {
      reject(new FfmpegUnavailableError(`Could not start ${bin}: ${(err as Error).message}`));
      return;
    }
    activeChildren.add(child);

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGKILL');
      }
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 8_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      // Keep the tail: FFmpeg errors are at the end.
      if (stderr.length > 400_000) stderr = stderr.slice(-200_000);
    });
    child.on('error', (err) => {
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(
          new FfmpegUnavailableError(
            `FFmpeg was not found (tried "${bin}"). Run "npm install" to fetch the bundled binary, or set FFMPEG_PATH.`,
          ),
        );
        return;
      }
      reject(err);
    });
    child.on('close', (code) => {
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export async function assertToolchain(): Promise<void> {
  const ff = await run(FFMPEG, ['-hide_banner', '-version'], 30_000).catch((err) => {
    if (err instanceof FfmpegUnavailableError) throw err;
    throw new FfmpegUnavailableError(`FFmpeg failed to start: ${(err as Error).message}`);
  });
  if (ff.code !== 0) {
    throw new FfmpegUnavailableError(
      `FFmpeg at "${FFMPEG}" is not runnable. First line of output: ${ff.stderr.split('\n')[0] || '(none)'}`,
    );
  }
  const probe = await run(FFPROBE, ['-hide_banner', '-version'], 30_000).catch(() => null);
  if (!probe || probe.code !== 0) {
    throw new FfmpegUnavailableError(
      `ffprobe at "${FFPROBE}" is not runnable. Install FFmpeg so ffprobe is available or set FFPROBE_PATH.`,
    );
  }
}

export async function supportsFilter(name: string): Promise<boolean> {
  const res = await run(FFMPEG, ['-hide_banner', '-filters'], 30_000);
  return res.stdout.includes(` ${name} `) || res.stdout.includes(`.${name} `);
}

export interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  rotation: number;
}

export async function probe(path: string): Promise<ProbeResult> {
  const res = await run(
    FFPROBE,
    [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      path,
    ],
    60_000,
  );
  if (res.code !== 0) {
    throw new Error(`ffprobe could not read ${path.split(/[\\/]/).pop()}: ${lastLines(res.stderr, 3)}`);
  }
  let parsed: {
    format?: { duration?: string };
    streams?: Array<Record<string, unknown>>;
  };
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error('ffprobe returned unreadable output');
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new Error('This file has no video stream. Upload an MP4/MOV/WebM video.');

  const duration = Number(parsed.format?.duration ?? video.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0.1) {
    throw new Error('Could not determine the video duration; the file may be corrupt or still uploading.');
  }

  const fpsRaw = String(video.avg_frame_rate ?? video.r_frame_rate ?? '30/1');
  const [num, den] = fpsRaw.split('/').map(Number);
  const fps = den && Number.isFinite(num / den) && num / den > 0 ? num / den : 30;

  const rotation = Number(
    (video.tags as Record<string, string> | undefined)?.rotate ??
      ((video.side_data_list as Array<{ rotation?: number }> | undefined)?.find((s) => s.rotation !== undefined)
        ?.rotation ??
        0),
  );

  return {
    duration,
    width: Number(video.width ?? 0),
    height: Number(video.height ?? 0),
    fps,
    hasAudio: Boolean(audio),
    rotation: Number.isFinite(rotation) ? rotation : 0,
  };
}

export function lastLines(text: string, count: number): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-count)
    .join(' | ')
    .slice(0, 600);
}
