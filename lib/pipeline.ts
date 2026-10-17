import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type CreatorBrief,
  type MediaInfo,
  type RawAnalysis,
  type StyleProfile,
} from './types';
import { extractVideoEvidence, type VideoEvidence } from './evidence';
import { assertToolchain, probe } from './ffmpeg';
import { AppError, safeLog, toPublicError } from './errors';
import type { AIProvider } from './ai/provider';
import { repairPlan, buildFallbackPlan, timelineFromPlan } from './plan';
import { themeFromStyle, buildAss } from './captions';
import { renderShort } from './render';
import { getJob, setData, setStage } from './jobs';

/**
 * Job orchestration. One job = one creator session:
 *   key in memory → evidence → style profile → footage analysis → plan → render.
 * Every stage writes to the job so the UI can poll `/api/jobs/[id]`.
 */

export interface PipelineInput {
  jobId: string;
  provider: AIProvider;
  brief: CreatorBrief;
  sourcePath: string;
  referencePaths: string[];
  musicPath?: string;
}

const LOW_CONFIDENCE = 'low' as const;

/**
 * Style profile when the model cannot be used (bad output, safety refusal).
 * It is built purely from FFmpeg measurements and says so, rather than
 * pretending to know the creator.
 */
export function measurementOnlyProfile(
  measuredAverageShotSeconds: number | null,
  referenceCount: number,
  framesSampled: number,
  audioAvailable: boolean,
  reason: string,
): StyleProfile {
  const note = `Model style analysis unavailable (${reason}). This profile is built only from FFmpeg measurements.`;
  return {
    summary: `${note} No reliable conclusions about captions, humour, or transitions could be drawn.`,
    hookStructure: { value: 'Unknown — not enough evidence.', confidence: LOW_CONFIDENCE },
    averageShotSeconds: {
      value: measuredAverageShotSeconds ?? 4,
      confidence: measuredAverageShotSeconds ? 'high' : LOW_CONFIDENCE,
    },
    captions: {
      present: false,
      position: 'unknown',
      sizeAndWeight: 'unknown',
      colors: 'unknown',
      emphasis: 'unknown',
      animation: 'unknown',
      confidence: LOW_CONFIDENCE,
    },
    zooms: { value: 'Unknown.', confidence: LOW_CONFIDENCE },
    transitions: { value: 'Unknown.', confidence: LOW_CONFIDENCE },
    humorAndMemes: { value: 'Unknown.', confidence: LOW_CONFIDENCE },
    soundAndMusic: { value: 'Unknown.', confidence: LOW_CONFIDENCE },
    layoutNotes: { value: 'Unknown.', confidence: LOW_CONFIDENCE },
    storytelling: { value: 'Unknown.', confidence: LOW_CONFIDENCE },
    energy: { value: 'Unknown.', confidence: LOW_CONFIDENCE },
    consistentElements: [],
    uncertain: [note],
    evidence: {
      referenceCount,
      framesSampled,
      measuredAverageShotSeconds,
      audioAvailable,
    },
  };
}

export function evidenceToMediaInfo(evidence: VideoEvidence, sizeBytes: number): MediaInfo {
  return {
    duration: Number(evidence.duration.toFixed(2)),
    width: evidence.width,
    height: evidence.height,
    fps: evidence.fps,
    hasAudio: evidence.hasAudio,
    sizeBytes,
    filename: evidence.filename,
  };
}

export async function runPipeline(input: PipelineInput): Promise<void> {
  const job = getJob(input.jobId);
  if (!job) throw new AppError('job_missing', 'This job no longer exists in memory.', { status: 404 });

  const { provider, brief } = input;

  const checkAborted = () => {
    if (job.aborted) throw new AppError('cancelled', 'The edit was cancelled.', { status: 409 });
  };

  try {
    /* ---------------------------- 0. Toolchain ---------------------------- */
    setStage(job, 'probing', 'Checking FFmpeg', 3);
    await assertToolchain();

    const sourceProbe = await probe(input.sourcePath).catch((err) => {
      throw new AppError('unreadable_video', 'The raw footage could not be read.', { hint: (err as Error).message });
    });

    setData(job, {
      source: {
        duration: Number(sourceProbe.duration.toFixed(2)),
        width: sourceProbe.width,
        height: sourceProbe.height,
        fps: Number(sourceProbe.fps.toFixed(2)),
        hasAudio: sourceProbe.hasAudio,
        sizeBytes: 0,
        filename: path.basename(input.sourcePath),
      } satisfies MediaInfo,
    });
    checkAborted();

    /* ------------------------- 1. Verify the key -------------------------- */
    setStage(job, 'probing', 'Verifying your Gemini API key', 6);
    const validation = await provider.validateKey();
    if (!validation.ok) {
      throw new AppError(validation.error.code, validation.error.message, {
        hint: validation.error.hint,
        status: validation.error.code === 'invalid_key' ? 401 : 429,
      });
    }
    checkAborted();

    /* ----------------------- 2. Multimodal evidence ----------------------- */
    setStage(job, 'extracting_evidence', 'Extracting frames and audio from your videos', 10);

    const refEvidence: VideoEvidence[] = [];
    for (let i = 0; i < input.referencePaths.length; i += 1) {
      checkAborted();
      const refPath = input.referencePaths[i];
      setStage(
        job,
        'extracting_evidence',
        `Reading reference video ${i + 1} of ${input.referencePaths.length}`,
        10 + Math.round((i / Math.max(1, input.referencePaths.length)) * 12),
      );
      const evidence = await extractVideoEvidence({
        videoPath: refPath,
        filename: path.basename(refPath),
        workDir: path.join(job.dir, 'evidence'),
        frameCount: 8,
        wantAudio: true,
      });
      refEvidence.push(evidence);
    }

    checkAborted();
    setStage(job, 'extracting_evidence', 'Reading the raw footage', 24);
    const sourceEvidence = await extractVideoEvidence({
      videoPath: input.sourcePath,
      filename: path.basename(input.sourcePath),
      workDir: path.join(job.dir, 'evidence'),
      frameCount: 16,
      wantAudio: true,
    });

    setData(job, {
      references: refEvidence.map((e) => evidenceToMediaInfo(e, 0)),
    });
    checkAborted();

    /* -------------------------- 3. Style profile -------------------------- */
    setStage(job, 'analyzing_style', 'Learning your editing style from the references', 30);

    let styleProfile: StyleProfile;
    let captionColorHex: string | undefined;
    const warnings: string[] = [];

    if (refEvidence.length === 0) {
      styleProfile = measurementOnlyProfile(null, 0, 0, sourceEvidence.hasAudio, 'no reference videos were uploaded');
      warnings.push(
        'No reference videos were uploaded, so no creator style was learned. This cut uses your settings only.',
      );
    } else {
      try {
        const styleOutput = await provider.analyzeStyle({
          references: refEvidence,
          sampledFramesBudget: 20,
        });
        styleProfile = styleOutput.profile;
        captionColorHex = styleOutput.captionColorHex;
        if (refEvidence.length === 1) {
          warnings.push(
            'Style profile built from a single reference. Treat it as a hypothesis, not this creator\'s complete style.',
          );
        }
        if (refEvidence.length === 1 && refEvidence[0].duration < 20) {
          warnings.push('The reference is short, so pacing estimates are weak.');
        }
      } catch (err) {
        safeLog('style analysis failed, continuing with measurements only', (err as Error).message);
        const measured = refEvidence
          .map((r) => r.averageShotSeconds)
          .filter((v): v is number => typeof v === 'number');
        const avg = measured.length ? Number((measured.reduce((a, b) => a + b, 0) / measured.length).toFixed(2)) : null;
        styleProfile = measurementOnlyProfile(
          avg,
          refEvidence.length,
          refEvidence.reduce((n, r) => n + r.frames.length, 0),
          refEvidence.some((r) => r.hasAudio),
          (err as Error).message.slice(0, 120),
        );
        warnings.push(
          'The AI could not describe your reference style, so this cut falls back to FFmpeg measurements plus your explicit settings.',
        );
      }
    }

    setData(job, { styleProfile });
    checkAborted();

    /* ------------------------ 4. Understand footage ----------------------- */
    setStage(job, 'analyzing_footage', 'Understanding the raw footage', 40);
    let analysis: RawAnalysis;
    try {
      analysis = await provider.analyzeRawFootage({
        source: sourceEvidence,
        brief,
        style: styleProfile,
      });
    } catch (err) {
      const pub = toPublicError(err);
      if (pub.code === 'invalid_key' || pub.code === 'quota_exhausted') {
        throw err;
      }
      safeLog('raw analysis failed', (err as Error).message);
      // Without any analysis there is nothing to cut, so this is fatal.
      throw new AppError('analysis_failed', 'The AI could not analyse this footage.', {
        hint: pub.hint ?? pub.message,
        status: 502,
      });
    }

    if (!analysis.audioTranscriptionAvailable) {
      warnings.push(
        'No speech-to-text is configured in this build, so dialogue was not transcribed. Captions the AI writes are summarised from what it can see and hear, not from a transcript.',
      );
    }

    setData(job, { analysis });
    checkAborted();

    /* ---------------------------- 5. Plan the edit ------------------------ */
    setStage(job, 'planning', 'Choosing moments and building the edit', 48);

    const rankedCandidates = [...analysis.candidates]
      .sort(
        (a, b) =>
          b.hookPotential + b.payoff + b.clarity + b.emotionalPeak -
          (a.hookPotential + a.payoff + a.clarity + a.emotionalPeak),
      )
      .slice(0, 14);

    let planResult;
    let rationale: string[] = [];
    let validationIssues: string[] = [];

    try {
      const output = await provider.planEdit({
        brief,
        style: styleProfile,
        analysis,
        sourceDuration: sourceEvidence.duration,
        candidates: rankedCandidates,
      });
      try {
        const repaired = repairPlan(output.plan, {
          sourceDuration: sourceEvidence.duration,
          brief,
        });
        planResult = repaired.plan;
        rationale = output.rationale;
        validationIssues = repaired.issues;
        warnings.push(...repaired.warnings);
      } catch (err) {
        safeLog('plan repair failed, retrying once with the issues included', (err as Error).message);
        // One corrective retry: tell the model exactly what broke.
        const retryOutput = await provider.planEdit({
          brief,
          style: styleProfile,
          analysis: {
            ...analysis,
            uncertainties: [
              ...analysis.uncertainties,
              `Your previous edit plan was rejected: ${(err as Error).message.slice(0, 200)}`,
            ],
          },
          sourceDuration: sourceEvidence.duration,
          candidates: rankedCandidates,
        });
        const repaired = repairPlan(retryOutput.plan, {
          sourceDuration: sourceEvidence.duration,
          brief,
        });
        planResult = repaired.plan;
        rationale = retryOutput.rationale;
        validationIssues = repaired.issues;
        warnings.push(...repaired.warnings, 'The first edit plan was invalid; a second attempt succeeded.');
      }
    } catch (err) {
      const pub = toPublicError(err);
      if (pub.code === 'invalid_key' || pub.code === 'quota_exhausted') throw err;
      safeLog('planning failed, using deterministic fallback', (err as Error).message);
      planResult = buildFallbackPlan(analysis, brief, sourceEvidence.duration);
      rationale = [
        'The AI could not produce a valid edit plan, so ZekoEdit built one by ranking the analysed moments against your objective.',
        'This fallback uses straight cuts and no AI-written captions.',
      ];
      warnings.push('This cut was assembled by the fallback planner, not the AI. Re-run to try again.');
    }

    checkAborted();
    setStage(job, 'validating', 'Checking every timestamp against the footage', 50);

    const { entries, total } = timelineFromPlan(planResult);

    // Final guard: no entry may point outside the file, whatever the model said.
    for (const entry of entries) {
      if (entry.clip.sourceEnd > sourceEvidence.duration + 0.05) {
        validationIssues.push('A clip exceeded the footage length and was clamped.');
        entry.clip.sourceEnd = Number(sourceEvidence.duration.toFixed(3));
        entry.clip.sourceStart = Math.min(entry.clip.sourceStart, entry.clip.sourceEnd - 0.5);
      }
    }
    const finalTimeline = timelineFromPlan(planResult);

    setData(job, {
      plan: planResult,
      rationale,
      issues: validationIssues,
      warnings,
      plannedDuration: finalTimeline.total,
    });

    if (rationale.length === 0) {
      setData(job, {
        rationale: [
          `Kept ${finalTimeline.entries.length} moment${finalTimeline.entries.length === 1 ? '' : 's'} totalling ${finalTimeline.total.toFixed(1)}s.`,
          ...planResult.clips.slice(0, 4).map((c) => `${c.role}: ${c.reason}`),
        ],
      });
    }
    void total;
    checkAborted();

    /* ------------------------------ 6. Render ----------------------------- */
    const theme = themeFromStyle(brief, styleProfile, captionColorHex);

    const renderResult = await renderShort({
      sourcePath: input.sourcePath,
      sourceHasAudio: sourceEvidence.hasAudio,
      entries: finalTimeline.entries,
      plan: planResult,
      workDir: job.dir,
      outPath: path.join(job.dir, 'output.mp4'),
      theme,
      audioMode: brief.audioMode,
      musicPath: input.musicPath,
      onStage: (message, progress) => {
        setStage(job, 'rendering_clips', message, progress);
      },
    });

    const renderedProbe = await probe(renderResult.outPath);

    // A readable sidecar so the creator can see exactly what was decided.
    await writeFile(
      path.join(job.dir, 'edit-plan.json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          provider: provider.id,
          model: provider.model,
          brief,
          styleProfile,
          analysis,
          plan: planResult,
          rationale,
          validationIssues,
          warnings: [...warnings, ...renderResult.warnings],
          rendered: {
            duration: Number(renderedProbe.duration.toFixed(2)),
            width: renderedProbe.width,
            height: renderedProbe.height,
            hasAudio: renderedProbe.hasAudio,
            captionsBurned: renderResult.captionsBurned,
            captionCues: renderResult.captionCues,
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    setData(job, {
      warnings: [...warnings, ...renderResult.warnings],
      renderedDuration: Number(renderedProbe.duration.toFixed(2)),
      videoUrl: `/api/jobs/${input.jobId}/media/video`,
      downloadUrl: `/api/jobs/${input.jobId}/media/video?download=1`,
      planUrl: `/api/jobs/${input.jobId}/media/plan`,
    });

    setStage(job, 'done', 'Your short is ready', 100);

    // Frames are not needed after analysis; drop them to keep disk use low.
    await rm(path.join(job.dir, 'evidence'), { recursive: true, force: true }).catch(() => undefined);
  } catch (err) {
    const pub = toPublicError(err);
    const errorHint =
      err instanceof AppError && err.code === 'cancelled' ? undefined : pub.hint ?? undefined;
    setData(job, { error: { code: pub.code, message: pub.message, hint: errorHint } });
    setStage(job, 'error', pub.message, 100);
    safeLog(`job ${input.jobId} failed:`, pub.code, pub.message, errorHint ?? '');
  } finally {
    // The key dies with the run: nothing keeps it after the edit completes.
    job.apiKey = '';
  }
}

export function jobDirFor(baseDir: string, jobId: string): string {
  return path.join(baseDir, jobId);
}

export async function ensureJobDir(baseDir: string, jobId: string): Promise<string> {
  const dir = jobDirFor(baseDir, jobId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export { buildAss };
