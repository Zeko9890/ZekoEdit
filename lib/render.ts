import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { CANVAS, type EditPlan } from './types';
import { FFMPEG, run } from './ffmpeg';
import { AppError, runOrThrow, safeLog } from './errors';
import { escapeFilterPath, type CaptionTheme } from './captions';
import type { TimelineEntry } from './plan';

/**
 * Rendering pipeline, deliberately boring and sequential:
 *
 *   1. normalise every clip   → 1080x1920, 30fps, H.264, AAC stereo 48k
 *   2. concat demuxer         → -c copy (exact cuts already applied per clip)
 *   3. optional music mix     → one re-encode
 *   4. burn captions (ASS)    → final re-encode, only if there are cues
 *
 * Normalising first keeps the concat step valid: mixed codecs/resolutions are
 * the single biggest cause of broken FFmpeg concatenations.
 */

const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p'];
const AAC = ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

/**
 * Build the video filter for one clip.
 *
 * The source is scaled up so the vertical window can be panned by focusX/focusY,
 * then a `zoom` punch-in crops tighter around the same focal point. We only use
 * filters available in every mainstream FFmpeg build (scale/crop/setsar/fps) and
 * no zoompan, because zoompan's frame handling is fragile with -t.
 */
export function buildClipFilter(focusX: number, focusY: number, zoom: number): string {
  const z = Math.min(1.6, Math.max(1, Number.isFinite(zoom) ? zoom : 1));
  const fx = clamp01(focusX);
  const fy = clamp01(focusY);

  // Window size of the vertical crop, expressed relative to source height.
  const windowW = `(iw/${z})`;
  const windowH = `(ih/${z})`;

  // Position of the window, clamped so it never leaves the frame.
  const x = `max(0,min(iw-ow,${fx}*iw-ow/2))`;
  const y = `max(0,min(ih-oh,${fy}*ih-oh/2))`;

  return [
    `crop=w=${windowW}:h=${windowH}:x=${x}:y=${y}`,
    `scale=${CANVAS.width}:${CANVAS.height}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${CANVAS.width}:${CANVAS.height}`,
    `setsar=1`,
    `fps=${CANVAS.fps}`,
  ].join(',');
}

async function renderClip(options: {
  sourcePath: string;
  outPath: string;
  entry: TimelineEntry;
  hasAudio: boolean;
  audioMode: 'preserve' | 'reduce' | 'replace';
  onProgress?: (fraction: number) => void;
}): Promise<void> {
  const { sourcePath, outPath, entry, hasAudio, audioMode } = options;
  const { clip } = entry;

  // Guard: never ask FFmpeg for a range outside the file.
  const start = Math.max(0, clip.sourceStart);
  const duration = Math.max(0.1, clip.sourceEnd - clip.sourceStart);

  const args: string[] = [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', start.toFixed(3),
    '-t', duration.toFixed(3),
    '-i', sourcePath,
  ];

  const baseFilter = buildClipFilter(clip.focusX, clip.focusY, clip.zoom);
  const videoFilter =
    clip.transitionIn === 'fade'
      ? `${baseFilter},fade=t=in:st=0:d=${Math.min(0.35, duration / 3).toFixed(2)}`
      : baseFilter;

  if (!hasAudio || audioMode === 'replace') {
    // No audio (or the creator asked to replace it): pair the normalised video
    // with silent audio so every clip has an identical stream layout before concat.
    args.push(
      '-f', 'lavfi',
      '-t', duration.toFixed(3),
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-vf', videoFilter,
      ...X264,
      ...AAC,
      '-shortest',
    );
  } else if (audioMode === 'reduce') {
    args.push('-vf', videoFilter, '-map', '0:v:0', '-map', '0:a:0', '-af', 'volume=0.35', ...X264, ...AAC);
  } else {
    args.push('-vf', videoFilter, '-map', '0:v:0', '-map', '0:a:0', ...X264, ...AAC);
  }

  args.push('-t', duration.toFixed(3), '-y', outPath);
  await runOrThrow(FFMPEG, args, `cutting clip ${clip.order} (${start.toFixed(2)}s–${(start + duration).toFixed(2)}s)`);
  options.onProgress?.(1);
}

async function concatClips(clipPaths: string[], listPath: string, outPath: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  const list = clipPaths
    .map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n');
  await writeFile(listPath, `${list}\n`, 'utf8');

  await runOrThrow(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y', outPath,
    ],
    'joining clips together',
  );
}

async function mixMusic(options: {
  videoPath: string;
  musicPath: string;
  outPath: string;
  voiceLevel: number;
  replace: boolean;
}): Promise<void> {
  const { videoPath, musicPath, outPath, voiceLevel, replace } = options;

  // `replace` drops the original audio entirely; otherwise music is looped,
  // trimmed to the video and ducked beneath the voice.
  const filter = replace
    ? `[1:a]volume=0.9,afade=t=in:st=0:d=0.8[a]`
    : `[0:a]volume=${voiceLevel}[voice];[1:a]volume=0.18,afade=t=in:st=0:d=0.8[bed];[voice][bed]amix=inputs=2:duration=first:dropout_transition=2[a]`;

  await runOrThrow(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error',
      '-i', videoPath,
      '-stream_loop', '-1',
      '-i', musicPath,
      '-filter_complex', filter,
      '-map', '0:v:0',
      '-map', '[a]',
      '-c:v', 'copy',
      ...AAC,
      '-shortest',
      '-y', outPath,
    ],
    'mixing replacement audio',
  );
}

async function burnCaptions(options: {
  videoPath: string;
  assPath: string;
  outPath: string;
}): Promise<void> {
  const { videoPath, assPath, outPath } = options;
  const escaped = escapeFilterPath(assPath);

  // libass may be absent from minimal builds; check before burning so we can
  // fall back to a clean render instead of failing the whole job.
  const filters = await run(FFMPEG, ['-hide_banner', '-filters'], 30_000);
  const hasAss = filters.stdout.includes(' ass ');

  if (!hasAss) {
    const { copyFile } = await import('node:fs/promises');
    await copyFile(videoPath, outPath);
    safeLog('libass not present in this FFmpeg build — captions skipped, video otherwise complete');
    return;
  }

  await runOrThrow(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error',
      '-i', videoPath,
      '-vf', `subtitles='${escaped}'`,
      ...X264,
      ...AAC,
      '-movflags', '+faststart',
      '-y', outPath,
    ],
    'burning captions',
  );
}

export interface RenderOptions {
  sourcePath: string;
  sourceHasAudio: boolean;
  entries: TimelineEntry[];
  plan: EditPlan;
  workDir: string;
  outPath: string;
  theme: CaptionTheme;
  audioMode: 'preserve' | 'reduce' | 'replace';
  musicPath?: string;
  onStage: (message: string, progress: number) => void;
}

export interface RenderResult {
  outPath: string;
  captionsBurned: boolean;
  captionCues: number;
  warnings: string[];
}

export async function renderShort(options: RenderOptions): Promise<RenderResult> {
  const { entries, workDir, outPath, theme, audioMode, musicPath, onStage } = options;
  const warnings: string[] = [];
  const clipsDir = path.join(workDir, 'clips');
  await mkdir(clipsDir, { recursive: true });

  const { buildAss } = await import('./captions');

  /* 1. Normalise each clip */
  const clipPaths: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const clipPath = path.join(clipsDir, `clip_${String(i + 1).padStart(2, '0')}.mp4`);
    onStage(
      `Rendering clip ${i + 1} of ${entries.length} (${entry.length.toFixed(1)}s)`,
      52 + Math.round((i / entries.length) * 22),
    );
    try {
      await renderClip({
        sourcePath: options.sourcePath,
        outPath: clipPath,
        entry,
        hasAudio: options.sourceHasAudio,
        audioMode: audioMode === 'replace' ? 'replace' : audioMode,
      });
    } catch (err) {
      // One impossible clip should not lose the whole edit.
      safeLog('clip render failed', entry.clip.order, (err as Error).message);
      warnings.push(`Clip ${i + 1} could not be rendered and was skipped.`);
      continue;
    }
    clipPaths.push(clipPath);
  }

  if (clipPaths.length === 0) {
    throw new AppError('render_failed', 'None of the selected clips could be rendered.', {
      status: 500,
      hint: 'This usually means the source codec is unsupported. Try re-encoding the raw file to H.264 MP4 first.',
    });
  }

  /* 2. Concatenate */
  onStage('Joining clips', 76);
  const concatPath = path.join(workDir, 'concat.mp4');
  await concatClips(clipPaths, path.join(workDir, 'concat.txt'), concatPath);

  /* 3. Optional music / replacement audio */
  let workingPath = concatPath;
  if (musicPath) {
    onStage(
      audioMode === 'replace' ? 'Replacing the audio track' : 'Ducking background music under your audio',
      79,
    );
    const mixedPath = path.join(workDir, 'mixed.mp4');
    try {
      await mixMusic({
        videoPath: workingPath,
        musicPath,
        outPath: mixedPath,
        voiceLevel: audioMode === 'reduce' ? 0.35 : 1.0,
        replace: audioMode === 'replace',
      });
      workingPath = mixedPath;
    } catch (err) {
      warnings.push(
        audioMode === 'replace'
          ? 'The replacement audio could not be applied; the cut kept its silent track.'
          : 'Background music could not be mixed; the cut was kept without it.',
      );
      safeLog('audio mix failed', (err as Error).message);
    }
  } else if (audioMode === 'replace') {
    warnings.push('Audio was set to "replace" but no replacement file was uploaded, so the cut is silent.');
  }

  /* 4. Captions */
  const { ass, cueCount } = buildAss(options.plan, entries, theme);
  let captionsBurned = false;

  if (cueCount > 0) {
    onStage(`Burning ${cueCount} caption cues`, 84);
    const assPath = path.join(workDir, 'captions.ass');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(assPath, ass, 'utf8');
    await burnCaptions({ videoPath: workingPath, assPath, outPath });
    captionsBurned = true;
  } else {
    const { copyFile } = await import('node:fs/promises');
    await copyFile(workingPath, outPath);
  }

  /* 5. Sanity check the output really exists and has a video stream */
  const { stat } = await import('node:fs/promises');
  const stats = await stat(outPath).catch(() => null);
  if (!stats || stats.size < 4096) {
    throw new AppError('render_failed', 'The render produced an empty file.', { status: 500 });
  }

  onStage('Finished', 96);
  return { outPath, captionsBurned, captionCues: cueCount, warnings };
}
