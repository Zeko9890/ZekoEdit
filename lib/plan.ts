import {
  editPlanSchema,
  planClipSchema,
  MAX_CLIP_SECONDS,
  MIN_CLIP_SECONDS,
  MAX_CLIPS,
  type CreatorBrief,
  type EditPlan,
  type PlanClip,
  type RawAnalysis,
  type Candidate,
} from './types';

/**
 * The AI proposes; this module disposes. Every number from the model is
 * untrusted: we clamp to the real media duration, drop impossible clips, and
 * recompute ordering ourselves. Rendering must never see a timestamp that
 * cannot exist.
 */

export interface RepairContext {
  sourceDuration: number;
  brief: CreatorBrief;
}

export interface RepairResult {
  plan: EditPlan;
  issues: string[];
  warnings: string[];
}

/* ------------------------------- JSON parsing ----------------------------- */

/** Pull the first balanced JSON object out of a model response that may include prose or fences. */
export function extractJsonBlock(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;

  const start = candidate.indexOf('{');
  if (start === -1) throw new Error('Model response contained no JSON object');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const slice = candidate.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch (err) {
          throw new Error(`JSON was malformed: ${(err as Error).message.slice(0, 160)}`);
        }
      }
    }
  }
  throw new Error('Model response JSON was truncated before the closing brace');
}

/** Models occasionally emit numbers as strings ("12.5") or with units ("12.5s"). */
function toNumber(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const match = value.match(/-?\d+(?:\.\d+)?/);
    if (!match) return undefined;
    const n = Number(match[0]);
    return Number.isFinite(n) ? n : undefined;
  }
  return value;
}

const NUMBER_FIELDS = new Set([
  'order',
  'sourceStart',
  'sourceEnd',
  'focusX',
  'focusY',
  'zoom',
  'start',
  'end',
  'targetDuration',
  'hookPotential',
  'payoff',
  'clarity',
  'emotionalPeak',
  'averageShotSeconds',
]);

function coerceNumbers(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(coerceNumbers);
  if (!input || typeof input !== 'object') return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] = NUMBER_FIELDS.has(key) ? toNumber(value) : coerceNumbers(value);
  }
  return out;
}

/* --------------------------------- Clamping -------------------------------- */

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/** Snap a cue set that came back in source-relative time onto the clip's own timeline. */
function normaliseCaptionTimes(
  cues: PlanClip['captions'],
  sourceStart: number,
  clipLength: number,
  issues: string[],
): PlanClip['captions'] {
  // Cues are specified as clip-relative (0 = clip start). A caption that begins
  // at or after the clip's source offset is almost certainly source-relative,
  // which models sometimes do despite instructions; shift it back.
  let shifted = 0;
  const rebased = cues
    .map((cue) => {
      const looksSourceRelative = sourceStart >= 0.75 && cue.start >= sourceStart - 0.25;
      if (!looksSourceRelative) return cue;
      shifted += 1;
      return { ...cue, start: cue.start - sourceStart, end: cue.end - sourceStart };
    })
    .filter((cue) => {
      const inside = cue.end > 0 && cue.start < clipLength;
      if (!inside) issues.push('Dropped a caption cue that fell outside its clip.');
      return inside;
    });

  if (shifted > 0) {
    issues.push(`${shifted} caption cue(s) arrived in source-video time and were shifted onto the clip.`);
  }

  return rebased
    .map((cue) => {
      const start = clamp(cue.start, 0, clipLength);
      const end = clamp(cue.end, 0, clipLength);
      const text = cue.text.trim().replace(/\s+/g, ' ');
      const emphasis = cue.emphasis
        .map((w) => w.trim())
        .filter((w) => w.length > 0 && text.toLowerCase().includes(w.toLowerCase()))
        .slice(0, 4);
      return { ...cue, text, start, end, emphasis };
    })
    .filter((cue) => {
      const usable = cue.text.length > 0 && cue.end - cue.start >= 0.2;
      if (!usable) issues.push('Dropped a caption cue with no readable text or no duration.');
      return usable;
    })
    .sort((a, b) => a.start - b.start)
    .slice(0, 30);
}

function repairClip(
  raw: unknown,
  index: number,
  ctx: RepairContext,
  issues: string[],
): PlanClip | null {
  const coerced = coerceNumbers(raw) as Record<string, unknown>;
  if (!coerced || typeof coerced !== 'object') {
    issues.push(`Clip ${index + 1} was not an object and was dropped.`);
    return null;
  }

  let start = Number(coerced.sourceStart);
  let end = Number(coerced.sourceEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    issues.push(`Clip ${index + 1} had no usable start/end timestamps and was dropped.`);
    return null;
  }
  if (end < start) {
    [start, end] = [end, start];
    issues.push(`Clip ${index + 1} had its timestamps in reverse order and was flipped.`);
  }

  const sourceEndBound = ctx.sourceDuration;
  start = clamp(start, 0, Math.max(0, sourceEndBound - MIN_CLIP_SECONDS));
  end = clamp(end, 0, sourceEndBound);

  if (end - start < MIN_CLIP_SECONDS) {
    const extended = Math.min(sourceEndBound, start + MIN_CLIP_SECONDS);
    if (extended - start >= MIN_CLIP_SECONDS) {
      end = extended;
      issues.push(`Clip ${index + 1} was shorter than ${MIN_CLIP_SECONDS}s and was extended to stay watchable.`);
    } else {
      issues.push(`Clip ${index + 1} fell at the very end of the footage with too little material left; dropped.`);
      return null;
    }
  }
  if (end - start > MAX_CLIP_SECONDS) {
    end = start + MAX_CLIP_SECONDS;
    issues.push(`Clip ${index + 1} was longer than ${MAX_CLIP_SECONDS}s and was trimmed.`);
  }

  const clipLength = end - start;
  const candidate = {
    ...coerced,
    order: index + 1,
    sourceStart: round(start),
    sourceEnd: round(end),
    focusX: clamp(Number(coerced.focusX ?? 0.5), 0, 1),
    focusY: clamp(Number(coerced.focusY ?? 0.5), 0, 1),
    zoom: clamp(Number(coerced.zoom ?? 1), 1, 1.6),
    captions: Array.isArray(coerced.captions) ? coerced.captions : [],
    role: ['hook', 'build', 'payoff', 'cta', 'bridge'].includes(String(coerced.role))
      ? coerced.role
      : 'build',
    transitionIn: ['cut', 'fade', 'whip', 'flash'].includes(String(coerced.transitionIn))
      ? coerced.transitionIn
      : 'cut',
    reason:
      typeof coerced.reason === 'string' && coerced.reason.trim().length > 2
        ? coerced.reason
        : 'Selected because it moves the story forward.',
  };

  const parsed = planClipSchema.safeParse(candidate);
  if (!parsed.success) {
    const detail = parsed.error.issues[0];
    issues.push(`Clip ${index + 1} failed schema validation (${detail?.path.join('.')}: ${detail?.message}); dropped.`);
    return null;
  }

  let clip = parsed.data;

  // Creator switches are authoritative over whatever the model proposed.
  if (!ctx.brief.effects.zooms) clip.zoom = 1;
  if (!ctx.brief.effects.transitions) clip.transitionIn = 'cut';
  if (ctx.brief.captionStyle === 'off') clip.captions = [];

  clip.captions = normaliseCaptionTimes(clip.captions, clip.sourceStart, clipLength, issues);
  return clip;
}

/**
 * Enforce the creator's duration target.
 *
 * Greedy-with-lookahead: a clip that does not fit is skipped (a later, shorter
 * moment may still fit) rather than ending the edit. If the accepted set lands
 * under the target, the leftover room is spread across clips that can still
 * grow, so a 30s target does not silently become 22s.
 */
function fitToDuration(clips: PlanClip[], targetSeconds: number, issues: string[], warnings: string[]): PlanClip[] {
  const hardMax = targetSeconds * 1.08;
  const out: PlanClip[] = [];
  let total = 0;
  let skipped = 0;

  for (const clip of clips) {
    const length = clip.sourceEnd - clip.sourceStart;
    if (total + length <= hardMax) {
      out.push(clip);
      total += length;
      continue;
    }
    skipped += 1;
  }

  if (skipped > 0 && out.length > 0) {
    issues.push(`Skipped ${skipped} clip${skipped === 1 ? '' : 's'} that would have pushed past the ${targetSeconds}s target.`);
  }
  if (out.length === 0) {
    // Nothing fits as-is: trim the first clip down to the target instead.
    const first = clips[0];
    const end = round(first.sourceStart + Math.min(hardMax, first.sourceEnd - first.sourceStart));
    out.push({
      ...first,
      sourceEnd: end,
      captions: first.captions
        .filter((c) => c.start < hardMax - 0.2)
        .map((c) => ({ ...c, end: Math.min(c.end, round(hardMax)) })),
    });
    total = end - first.sourceStart;
    issues.push('Trimmed the opening clip to the target duration.');
  }

  // Use the room we left on the table: grow clips that can still grow without
  // changing what the creator said the edit was about.
  const shortfall = targetSeconds * 0.98 - total;
  if (shortfall > 1) {
    let remaining = shortfall;
    for (let i = 0; i < out.length && remaining > 0.2; i += 1) {
      const clip = out[i];
      const current = clip.sourceEnd - clip.sourceStart;
      const room = Math.min(MAX_CLIP_SECONDS - current, remaining, hardMax - total);
      if (room < 0.2) continue;
      out[i] = { ...clip, sourceEnd: round(clip.sourceEnd + room) };
      total += room;
      remaining -= room;
    }
    if (remaining > 0.2) {
      warnings.push(
        `The selected moments add up to ${total.toFixed(1)}s against a ${targetSeconds}s target — there was not enough usable footage to fill the rest without padding.`,
      );
    }
  }

  if (total < targetSeconds * 0.6) {
    warnings.push(
      `This cut is ${total.toFixed(1)}s, well under the ${targetSeconds}s target. Selecting more footage would fill it.`,
    );
  }

  return out;
}

export function repairPlan(raw: unknown, ctx: RepairContext): RepairResult {
  const issues: string[] = [];
  const warnings: string[] = [];

  const unwrapped =
    raw && typeof raw === 'object' && 'plan' in (raw as Record<string, unknown>)
      ? (raw as Record<string, unknown>).plan
      : raw;

  const envelope = (coerceNumbers(unwrapped) ?? {}) as Record<string, unknown>;
  const rawClips = Array.isArray(envelope.clips) ? envelope.clips : [];
  if (rawClips.length === 0) {
    throw new Error('The AI returned an edit plan with no clips');
  }

  let clips = rawClips
    .map((clip, i) => repairClip(clip, i, ctx, issues))
    .filter((clip): clip is PlanClip => clip !== null);

  if (clips.length === 0) {
    throw new Error('Every clip in the AI plan was invalid after validation');
  }

  // Duplicate source ranges add nothing; keep the first.
  const seen = new Set<string>();
  clips = clips.filter((clip) => {
    const key = `${clip.sourceStart.toFixed(2)}-${clip.sourceEnd.toFixed(2)}`;
    if (seen.has(key)) {
      issues.push('Removed an exact duplicate of an earlier clip.');
      return false;
    }
    seen.add(key);
    return true;
  });

  // Preserve the model's intended order when it is coherent, otherwise keep array order.
  const orders = clips.map((c) => c.order);
  const ordered = orders.every((o, i) => i === 0 || o >= orders[i - 1])
    ? [...clips].sort((a, b) => a.order - b.order)
    : clips;

  if (ordered.length > MAX_CLIPS) {
    issues.push(`Kept the first ${MAX_CLIPS} clips; the rest were cut.`);
  }

  clips = fitToDuration(ordered.slice(0, MAX_CLIPS), ctx.brief.targetDuration, issues, warnings)
    .map((clip, i) => ({ ...clip, order: i + 1 }));

  const title =
    typeof envelope.title === 'string' && envelope.title.trim().length >= 2
      ? envelope.title.trim().slice(0, 110)
      : 'Untitled cut';

  const draft = {
    title,
    hookText: typeof envelope.hookText === 'string' ? envelope.hookText.slice(0, 200) : '',
    targetDuration: ctx.brief.targetDuration,
    endingAndCta: typeof envelope.endingAndCta === 'string' ? envelope.endingAndCta.slice(0, 400) : '',
    styleDecisions: Array.isArray(envelope.styleDecisions)
      ? envelope.styleDecisions.filter((s): s is string => typeof s === 'string').slice(0, 8)
      : [],
    clips,
  };

  const parsed = editPlanSchema.safeParse(draft);
  if (!parsed.success) {
    const detail = parsed.error.issues[0];
    throw new Error(`Plan failed final validation: ${detail?.path.join('.')} ${detail?.message}`);
  }

  if (clips[0]?.role !== 'hook') {
    warnings.push('The opening clip was not explicitly marked as the hook — the first seconds may be slow.');
  }

  return { plan: parsed.data, issues, warnings };
}

/* -------------------------------- Timeline -------------------------------- */

export interface TimelineEntry {
  clip: PlanClip;
  /** Position in the rendered output. */
  outputStart: number;
  outputEnd: number;
  length: number;
}

export function timelineFromPlan(plan: EditPlan): { entries: TimelineEntry[]; total: number } {
  let cursor = 0;
  const entries = plan.clips.map((clip) => {
    const length = clip.sourceEnd - clip.sourceStart;
    const entry: TimelineEntry = {
      clip,
      outputStart: round(cursor),
      outputEnd: round(cursor + length),
      length,
    };
    cursor += length;
    return entry;
  });
  return { entries, total: round(cursor) };
}

/* -------------------------------- Fallback -------------------------------- */

function scoreCandidate(c: Candidate, brief: CreatorBrief): number {
  const weight = (() => {
    switch (brief.objective) {
      case 'entertain':
      case 'retain':
        return { hook: 0.3, payoff: 0.25, clarity: 0.2, peak: 0.25 };
      case 'teach':
      case 'tell_story':
        return { hook: 0.2, payoff: 0.2, clarity: 0.4, peak: 0.2 };
      case 'surprise':
        return { hook: 0.25, payoff: 0.2, clarity: 0.15, peak: 0.4 };
      case 'promote':
      case 'drive_cta':
        return { hook: 0.25, payoff: 0.3, clarity: 0.3, peak: 0.15 };
      default:
        return { hook: 0.25, payoff: 0.25, clarity: 0.25, peak: 0.25 };
    }
  })();
  return (
    c.hookPotential * weight.hook +
    c.payoff * weight.payoff +
    c.clarity * weight.clarity +
    c.emotionalPeak * weight.peak
  );
}

/**
 * Deterministic plan when the model cannot produce valid JSON. It is honest
 * about being a fallback: it cuts the highest-ranked analysed moments with no
 * fancy reframing, and the UI labels it as such.
 */
export function buildFallbackPlan(analysis: RawAnalysis, brief: CreatorBrief, sourceDuration: number): EditPlan {
  const ranked = [...analysis.candidates]
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    .sort((a, b) => scoreCandidate(b, brief) - scoreCandidate(a, brief));

  const clips: PlanClip[] = [];
  let total = 0;
  for (const candidate of ranked) {
    if (clips.length >= MAX_CLIPS || total >= brief.targetDuration * 1.05) break;
    const start = clamp(candidate.start, 0, Math.max(0, sourceDuration - MIN_CLIP_SECONDS));
    const remaining = brief.targetDuration - total;
    const end = clamp(
      Math.min(candidate.end, start + Math.max(MIN_CLIP_SECONDS, remaining)),
      start + MIN_CLIP_SECONDS,
      Math.min(sourceDuration, start + MAX_CLIP_SECONDS),
    );
    if (end - start < MIN_CLIP_SECONDS) continue;
    clips.push({
      order: clips.length + 1,
      sourceStart: round(start),
      sourceEnd: round(end),
      role: clips.length === 0 ? 'hook' : 'build',
      reason: candidate.why || candidate.label,
      focusX: 0.5,
      focusY: 0.5,
      zoom: brief.effects.zooms ? 1.05 : 1,
      transitionIn: 'cut',
      captions: [],
    });
    total += end - start;
  }

  if (clips.length === 0) {
    // Absolute last resort: the opening N seconds of the footage.
    const end = Math.min(sourceDuration, brief.targetDuration, MAX_CLIP_SECONDS);
    clips.push({
      order: 1,
      sourceStart: 0,
      sourceEnd: round(end),
      role: 'hook',
      reason: 'No analysable moments were found, so the opening of the footage was used.',
      focusX: 0.5,
      focusY: 0.5,
      zoom: 1,
      transitionIn: 'cut',
      captions: [],
    });
  }

  return {
    title: 'Unedited-moments cut',
    hookText: '',
    targetDuration: brief.targetDuration,
    endingAndCta: brief.callToAction ?? '',
    styleDecisions: ['Fallback cut: AI planning failed, so moments were chosen by ranking only.'],
    clips,
  };
}
