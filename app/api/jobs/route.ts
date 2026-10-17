import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { creatorBriefSchema } from '@/lib/types';
import { ACCEPTED_AUDIO_EXT, ACCEPTED_VIDEO_EXT, LIMITS, dataDir } from '@/lib/env';
import { AppError, fingerprint, safeLog, toPublicError } from '@/lib/errors';
import { allowNewJob, createJob, getJob, setStage } from '@/lib/jobs';
import { GeminiProvider } from '@/lib/ai/gemini';
import { runPipeline } from '@/lib/pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 900;

/** Gemini keys start with AIza and are long; we only check shape, Google checks validity. */
function looksLikeGeminiKey(key: string): boolean {
  return /^[A-Za-z0-9_\-]{20,200}$/.test(key) && !/\s/.test(key);
}

/**
 * Duck-typed file check. `instanceof File` is unreliable across Node/undici
 * versions in the Next dev server, so we test for the interface we actually use.
 */
function isUploadedFile(value: unknown): value is File {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as File).arrayBuffer === 'function' &&
    typeof (value as File).size === 'number' &&
    typeof (value as File).name === 'string'
  );
}

function safeExt(filename: string, allowed: string[]): string {
  const ext = path.extname(filename).toLowerCase();
  return allowed.includes(ext) ? ext : allowed[0];
}

async function persist(file: File, targetPath: string): Promise<number> {
  const bytes = Buffer.from(await file.arrayBuffer());
  await writeFile(targetPath, bytes);
  return bytes.byteLength;
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();

    /* ----------------------------- API key ------------------------------ */
    const rawKey = form.get('apiKey');
    if (typeof rawKey !== 'string' || rawKey.trim().length === 0) {
      throw new AppError('missing_key', 'Enter your Google Gemini API key.', {
        hint: 'Get a key from https://aistudio.google.com/apikey. It is used for this edit only.',
      });
    }
    const apiKey = rawKey.trim();
    if (!looksLikeGeminiKey(apiKey)) {
      throw new AppError('bad_key_format', 'That does not look like a Gemini API key.', {
        hint: 'Gemini keys are usually 39 characters and start with AIza. Check for extra spaces or quotes.',
      });
    }

    /* ------------------------------ Brief ------------------------------- */
    const briefRaw = form.get('brief');
    if (typeof briefRaw !== 'string') {
      throw new AppError('missing_brief', 'The editing brief was not sent.');
    }
    let parsedBrief: unknown;
    try {
      parsedBrief = JSON.parse(briefRaw);
    } catch {
      throw new AppError('bad_brief', 'The editing brief was unreadable.');
    }

    const brief = creatorBriefSchema.safeParse(parsedBrief);
    if (!brief.success) {
      const issue = brief.error.issues[0];
      throw new AppError('bad_brief', `Invalid setting: ${issue?.path.join('.')} — ${issue?.message}`);
    }

    /* ----------------------------- Files -------------------------------- */
    const source = form.get('source');
    if (!isUploadedFile(source) || source.size === 0) {
      throw new AppError('missing_source', 'Upload the raw footage you want edited.');
    }
    if (source.size > LIMITS.maxSourceBytes) {
      throw new AppError(
        'source_too_large',
        `That raw video is ${(source.size / 1024 / 1024).toFixed(0)} MB; the limit is ${
          LIMITS.maxSourceBytes / 1024 / 1024
        } MB.`,
        { hint: 'Trim the file or re-encode it to 1080p H.264 before uploading.' },
      );
    }

    const references = form
      .getAll('references')
      .filter((entry): entry is File => isUploadedFile(entry) && entry.size > 0);

    if (references.length > LIMITS.maxReferences) {
      throw new AppError('too_many_references', `Upload at most ${LIMITS.maxReferences} reference videos.`);
    }
    for (const ref of references) {
      if (ref.size > LIMITS.maxReferenceBytes) {
        throw new AppError(
          'reference_too_large',
          `"${ref.name}" is ${(ref.size / 1024 / 1024).toFixed(0)} MB; references are limited to ${
            LIMITS.maxReferenceBytes / 1024 / 1024
          } MB each.`,
        );
      }
    }

    const totalBytes = source.size + references.reduce((sum, r) => sum + r.size, 0);
    if (totalBytes > LIMITS.maxTotalUploadBytes) {
      throw new AppError('upload_too_large', 'That upload is too large in total for a local session.');
    }

    /* --------------------------- Admission ------------------------------ */
    const clientKey = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
    const admission = allowNewJob(clientKey);
    if (!admission.ok) {
      throw new AppError('rate_limited', admission.reason, { status: 429 });
    }

    /* ---------------------------- Persist ------------------------------- */
    const jobId = randomUUID();
    const dir = path.join(dataDir(), jobId);
    await mkdir(dir, { recursive: true });

    const sourceExt = safeExt(source.name, ACCEPTED_VIDEO_EXT);
    const sourcePath = path.join(dir, `source${sourceExt}`);
    await persist(source, sourcePath);

    const referencePaths: string[] = [];
    for (let i = 0; i < references.length; i += 1) {
      const ref = references[i];
      const ext = safeExt(ref.name, ACCEPTED_VIDEO_EXT);
      const target = path.join(dir, `reference_${i + 1}${ext}`);
      await persist(ref, target);
      referencePaths.push(target);
    }

    let musicPath: string | undefined;
    const music = form.get('music');
    if (isUploadedFile(music) && music.size > 0) {
      if (music.size > LIMITS.maxMusicBytes) {
        throw new AppError('music_too_large', 'The music file is too large.');
      }
      const ext = safeExt(music.name, ACCEPTED_AUDIO_EXT);
      musicPath = path.join(dir, `music${ext}`);
      await persist(music, musicPath);
    }

    // "Replace" is only meaningful with a file to replace the original with.
    if (brief.data.audioMode === 'replace' && !musicPath) {
      throw new AppError('missing_replacement_audio', 'Audio is set to "replace" but no audio file was uploaded.', {
        hint: 'Upload the track to use, or switch original audio back to preserve or reduce.',
      });
    }

    /* ----------------------------- Job ---------------------------------- */
    const job = createJob(jobId, apiKey, dir);
    setStage(job, 'queued', 'Starting', 1);

    const provider = new GeminiProvider(apiKey);
    safeLog(`job ${jobId} accepted — key ${fingerprint(apiKey)} (${provider.model})`);

    // Detached: the response returns immediately and the UI polls for progress.
    void runPipeline({
      jobId,
      provider,
      brief: brief.data,
      sourcePath,
      referencePaths,
      musicPath,
    }).catch((err) => {
      const pub = toPublicError(err);
      safeLog(`job ${jobId} crashed:`, pub.code, pub.message);
      const live = getJob(jobId);
      if (live && live.stage !== 'error') {
        setStage(live, 'error', pub.message, 100);
      }
    });

    return NextResponse.json(
      {
        jobId,
        // Echo only non-secret configuration so the UI can show what will be billed.
        provider: { id: provider.id, name: provider.displayName, model: provider.model },
        keyFingerprint: fingerprint(apiKey),
        accepted: {
          sourceBytes: source.size,
          referenceCount: referencePaths.length,
          hasMusic: Boolean(musicPath),
        },
      },
      { status: 202 },
    );
  } catch (err) {
    const pub = toPublicError(err);
    const status = err instanceof AppError ? err.status : 500;
    if (status >= 500) safeLog('job creation failed', pub.code, pub.message, pub.hint ?? '');
    return NextResponse.json({ error: pub }, { status });
  }
}
