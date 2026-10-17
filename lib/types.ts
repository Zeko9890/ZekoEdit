import { z } from 'zod';

/**
 * The contract between the AI (which proposes an edit) and the renderer
 * (which executes it). Anything that violates this schema is either repaired
 * by lib/plan.ts or the plan is rejected outright.
 */

export const PLATFORMS = ['youtube_shorts', 'instagram_reels', 'tiktok'] as const;
export const CONTENT_TYPES = [
  'gaming_highlight',
  'funny_moment',
  'reaction',
  'educational',
  'tutorial',
  'commentary',
  'storytime',
  'vlog',
  'product_promo',
  'custom',
] as const;
export const OBJECTIVES = [
  'entertain',
  'teach',
  'surprise',
  'retain',
  'tell_story',
  'promote',
  'drive_cta',
] as const;
export const INTENSITIES = ['clean', 'balanced', 'energetic'] as const;
export const CAPTION_STYLES = ['off', 'clean', 'creator_animated'] as const;
export const LANGUAGES = ['original', 'en', 'hi', 'es', 'pt', 'fr', 'de', 'id', 'ja'] as const;
export const AUDIO_MODES = ['preserve', 'reduce', 'replace'] as const;

export const CANVAS = { width: 1080, height: 1920, fps: 30 } as const;
export const MAX_CLIPS = 10;
export const MIN_CLIP_SECONDS = 0.8;
export const MAX_CLIP_SECONDS = 30;

/* -------------------------------------------------------------------------- */
/*                              Creator settings                              */
/* -------------------------------------------------------------------------- */

export const creatorBriefSchema = z.object({
  contentType: z.enum(CONTENT_TYPES).default('custom'),
  customContentType: z.string().max(80).optional(),
  objective: z.enum(OBJECTIVES).default('entertain'),
  audience: z.string().min(2).max(400),
  targetDuration: z.number().min(5).max(180),
  platform: z.enum(PLATFORMS).default('youtube_shorts'),
  language: z.enum(LANGUAGES).default('original'),
  intensity: z.enum(INTENSITIES).default('balanced'),
  captionStyle: z.enum(CAPTION_STYLES).default('clean'),
  effects: z
    .object({
      zooms: z.boolean().default(true),
      transitions: z.boolean().default(false),
      soundEffects: z.boolean().default(false),
      memes: z.boolean().default(false),
      music: z.boolean().default(false),
    })
    .default({}),
  mustInclude: z.string().max(600).optional(),
  avoid: z.string().max(600).optional(),
  callToAction: z.string().max(200).optional(),
  audioMode: z.enum(AUDIO_MODES).default('preserve'),
  styleProfileJson: z.string().max(200_000).optional(),
});

export type CreatorBrief = z.infer<typeof creatorBriefSchema>;

/* -------------------------------------------------------------------------- */
/*                              Style profile                                 */
/* -------------------------------------------------------------------------- */

export const styleConfidence = z.enum(['high', 'medium', 'low']);

const observation = z.object({
  value: z.string().max(600),
  confidence: styleConfidence,
});

export const styleProfileSchema = z.object({
  summary: z.string().max(900),
  hookStructure: observation,
  averageShotSeconds: z.object({
    value: z.number().min(0.2).max(20),
    confidence: styleConfidence,
  }),
  captions: z.object({
    present: z.boolean(),
    position: z.string().max(120),
    sizeAndWeight: z.string().max(160),
    colors: z.string().max(160),
    emphasis: z.string().max(200),
    animation: z.string().max(200),
    confidence: styleConfidence,
  }),
  zooms: observation,
  transitions: observation,
  humorAndMemes: observation,
  soundAndMusic: observation,
  layoutNotes: observation,
  storytelling: observation,
  energy: observation,
  consistentElements: z.array(z.string().max(200)).max(8).default([]),
  uncertain: z.array(z.string().max(200)).max(8).default([]),
  evidence: z
    .object({
      referenceCount: z.number().int().min(0).max(5),
      framesSampled: z.number().int().min(0),
      measuredAverageShotSeconds: z.number().nullable().default(null),
      audioAvailable: z.boolean().default(false),
    })
    .default({ referenceCount: 0, framesSampled: 0, measuredAverageShotSeconds: null, audioAvailable: false }),
});

export type StyleProfile = z.infer<typeof styleProfileSchema>;

/* -------------------------------------------------------------------------- */
/*                          Raw footage understanding                         */
/* -------------------------------------------------------------------------- */

export const candidateSchema = z.object({
  start: z.number(),
  end: z.number(),
  label: z.string().max(120),
  transcript: z.string().max(1200).default(''),
  why: z.string().max(600),
  signals: z.array(z.string().max(60)).max(8).default([]),
  hookPotential: z.number().min(0).max(100).default(50),
  payoff: z.number().min(0).max(100).default(50),
  clarity: z.number().min(0).max(100).default(50),
  emotionalPeak: z.number().min(0).max(100).default(50),
});

export type Candidate = z.infer<typeof candidateSchema>;

export const analysisSchema = z.object({
  audioTranscriptionAvailable: z.boolean().default(false),
  overallDescription: z.string().max(1200),
  candidates: z.array(candidateSchema).max(40),
  bestEndingCandidates: z.array(z.number()).max(5).default([]),
  uncertainties: z.array(z.string().max(240)).max(8).default([]),
});

export type RawAnalysis = z.infer<typeof analysisSchema>;

/* -------------------------------------------------------------------------- */
/*                                Edit plan                                   */
/* -------------------------------------------------------------------------- */

export const captionCueSchema = z.object({
  text: z.string().min(1).max(120),
  start: z.number(),
  end: z.number(),
  emphasis: z.array(z.string().max(30)).max(4).default([]),
});

export const planClipSchema = z.object({
  order: z.number().int().min(1).max(MAX_CLIPS),
  sourceStart: z.number(),
  sourceEnd: z.number(),
  role: z.enum(['hook', 'build', 'payoff', 'cta', 'bridge']).default('build'),
  reason: z.string().min(3).max(500),
  /** 0..1 normalised crop focus within the source frame. */
  focusX: z.number().min(0).max(1).default(0.5),
  focusY: z.number().min(0).max(1).default(0.5),
  zoom: z.number().min(1).max(1.6).default(1),
  transitionIn: z.enum(['cut', 'fade', 'whip', 'flash']).default('cut'),
  captions: z.array(captionCueSchema).max(30).default([]),
  audioNote: z.string().max(200).optional(),
});

export type PlanClip = z.infer<typeof planClipSchema>;

export const editPlanSchema = z.object({
  title: z.string().min(2).max(110),
  hookText: z.string().max(200).default(''),
  targetDuration: z.number().min(5).max(180),
  endingAndCta: z.string().max(400).default(''),
  styleDecisions: z.array(z.string().max(240)).max(8).default([]),
  clips: z.array(planClipSchema).min(1).max(MAX_CLIPS),
});

export type EditPlan = z.infer<typeof editPlanSchema>;

export const planResultSchema = z.object({
  plan: editPlanSchema,
  /** Explanation shown to the creator: why these moments, in plain language. */
  rationale: z.array(z.string().max(300)).max(10).default([]),
});

export type PlanResult = z.infer<typeof planResultSchema>;

/* -------------------------------------------------------------------------- */
/*                                  Jobs                                      */
/* -------------------------------------------------------------------------- */

export type Stage =
  | 'queued'
  | 'probing'
  | 'extracting_evidence'
  | 'analyzing_style'
  | 'analyzing_footage'
  | 'planning'
  | 'validating'
  | 'rendering_clips'
  | 'rendering_captions'
  | 'done'
  | 'error';

export const STAGE_LABELS: Record<Stage, string> = {
  queued: 'Queued',
  probing: 'Reading video metadata',
  extracting_evidence: 'Extracting frames, audio and scene cuts',
  analyzing_style: 'Learning your reference style',
  analyzing_footage: 'Understanding the raw footage',
  planning: 'Deciding what to keep',
  validating: 'Checking every timestamp',
  rendering_clips: 'Rendering vertical clips',
  rendering_captions: 'Burning captions',
  done: 'Done',
  error: 'Stopped',
};

export interface MediaInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  sizeBytes: number;
  filename: string;
}

export interface JobPublicState {
  id: string;
  stage: Stage;
  stageLabel: string;
  progress: number;
  message: string;
  createdAt: number;
  updatedAt: number;
  brief?: CreatorBrief;
  source?: MediaInfo;
  references?: MediaInfo[];
  styleProfile?: StyleProfile;
  analysis?: RawAnalysis;
  plan?: EditPlan;
  rationale?: string[];
  issues?: string[];
  warnings?: string[];
  error?: { code: string; message: string; hint?: string };
  videoUrl?: string;
  downloadUrl?: string;
  plannedDuration?: number;
  renderedDuration?: number;
}

export interface InternalJob {
  id: string;
  createdAt: number;
  updatedAt: number;
  public: JobPublicState;
  /** Server-only: the creator's key. Never serialised into a response. */
  apiKey: string;
  keyProvider: 'gemini';
  dir: string;
  sourcePath: string;
  referencePaths: string[];
  musicPath?: string;
  aborted: boolean;
}
