import type { CreatorBrief, RawAnalysis, StyleProfile } from '../types';
import { analysisSchema, styleProfileSchema } from '../types';
import type { VideoEvidence } from '../evidence';
import { describeMeasurements } from '../evidence';
import {
  SYSTEM_RULES,
  buildPlanPrompt,
  buildRawAnalysisPrompt,
  buildStylePrompt,
} from '../prompts';
import { extractJsonBlock, buildFallbackPlan } from '../plan';
import { safeLog } from '../errors';
import type {
  AIProvider,
  PlanInput,
  PlanOutput,
  ProviderError,
  RawAnalysisInput,
  StyleAnalysisInput,
  StyleAnalysisOutput,
} from './provider';

/**
 * Google Gemini. Kept deliberately thin: everything provider-specific lives in
 * this file so the pipeline never sees an SDK type.
 *
 * The key is passed per-instance, per-job. It is never read from env, never
 * written to disk, and never included in an error we return.
 */

type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

interface GenAiClient {
  models: {
    generateContent(args: Record<string, unknown>): Promise<{ text?: string }>;
  };
}

const DEFAULT_MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';

const RETRY_DELAYS_MS = [900, 2200];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function classifyGeminiError(err: unknown): ProviderError {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  const status = Number((err as { status?: number })?.status ?? (err as { code?: number })?.code ?? 0);

  if (
    lower.includes('api key not valid') ||
    lower.includes('api_key_invalid') ||
    lower.includes('invalid api key') ||
    lower.includes('unauthenticated') ||
    status === 401 ||
    status === 403
  ) {
    return {
      code: 'invalid_key',
      message: 'That Gemini API key was rejected by Google.',
      hint: 'Check the key in Google AI Studio, confirm it has no trailing spaces, and that the Generative Language API is enabled for it.',
      retryable: false,
    };
  }
  if (lower.includes('resource_exhausted') || lower.includes('quota') || status === 429) {
    return {
      code: 'quota_exhausted',
      message: 'The Gemini quota for this key is exhausted or rate-limited.',
      hint: 'Wait for the quota window to reset, or check billing on the Google account that owns this key. ZekoEdit will not switch to another provider or account.',
      retryable: true,
    };
  }
  if (lower.includes('not found') || lower.includes('not supported') || status === 404) {
    return {
      code: 'model_unavailable',
      message: `Model "${DEFAULT_MODEL}" is not available to this key.`,
      hint: 'Set GEMINI_MODEL in .env.local to a model your key can access (for example gemini-2.5-flash or gemini-2.0-flash).',
      retryable: false,
    };
  }
  if (lower.includes('blocked') || lower.includes('safety') || lower.includes('finish_reason_safety')) {
    return {
      code: 'blocked',
      message: 'The model refused to analyse this material for safety reasons.',
      hint: 'Try different footage or rephrase the purpose and audience. Nothing was rendered.',
      retryable: false,
    };
  }
  if (lower.includes('fetch') || lower.includes('network') || lower.includes('econn')) {
    return {
      code: 'network',
      message: 'Could not reach the Gemini API.',
      hint: 'Check your internet connection or VPN and try again.',
      retryable: true,
    };
  }
  return {
    code: 'unknown',
    message: 'The Gemini request failed.',
    hint: raw.slice(0, 200),
    retryable: true,
  };
}

export class GeminiProvider implements AIProvider {
  readonly id = 'gemini';
  readonly displayName = 'Google Gemini';
  readonly model: string;
  readonly pricingNote =
    'Requests are billed to your own Google account under the Gemini API pricing for this key. ZekoEdit never proxies or pays for your usage.';
  readonly capabilities = {
    nativeVideo: false,
    audio: true,
    maxUploadBytes: 18 * 1024 * 1024,
  };

  private client: GenAiClient | null = null;

  constructor(private readonly apiKey: string, model?: string) {
    this.model = model || DEFAULT_MODEL;
  }

  private async sdk(): Promise<GenAiClient> {
    if (this.client) return this.client;
    const mod = (await import('@google/genai')) as unknown as {
      GoogleGenAI: new (opts: { apiKey: string }) => GenAiClient;
    };
    this.client = new mod.GoogleGenAI({ apiKey: this.apiKey });
    return this.client;
  }

  private async generate(args: {
    prompt: string;
    parts: Part[];
    jsonSchema?: Record<string, unknown>;
    temperature: number;
    maxOutputTokens: number;
    /** 0 disables thinking (fast structured extraction); higher = more deliberation. */
    thinkingBudget: number;
  }): Promise<string> {
    const client = await this.sdk();
    let lastError: ProviderError | null = null;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const response = await client.models.generateContent({
          model: this.model,
          contents: [{ role: 'user', parts: [...args.parts, { text: args.prompt }] }],
          config: {
            systemInstruction: SYSTEM_RULES,
            temperature: args.temperature,
            maxOutputTokens: args.maxOutputTokens,
            responseMimeType: 'application/json',
            ...(args.jsonSchema ? { responseSchema: args.jsonSchema } : {}),
            thinkingConfig: { thinkingBudget: args.thinkingBudget },
          },
        });
        const text = (response.text ?? '').trim();
        if (!text) throw new Error('empty response from model');
        return text;
      } catch (err) {
        const classified = classifyGeminiError(err);
        lastError = classified;

        // A truncated JSON body is worth one immediate retry at higher budget
        // rather than a retry of the identical request.
        if (/truncat|unexpected end|unterminated/i.test(classified.hint ?? classified.message)) {
          args.maxOutputTokens = Math.min(args.maxOutputTokens * 2, 32768);
          safeLog(`gemini output truncated; retrying with ${args.maxOutputTokens} max tokens`);
        }

        safeLog(`gemini ${classified.code} on ${this.model} attempt ${attempt + 1}: ${classified.hint ?? classified.message}`);
        if (!classified.retryable || attempt === RETRY_DELAYS_MS.length) break;
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
    throw lastError ?? classifyGeminiError(new Error('unknown failure'));
  }

  async validateKey(): Promise<{ ok: true } | { ok: false; error: ProviderError }> {
    try {
      const client = await this.sdk();
      await client.models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
        config: { maxOutputTokens: 8, temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: classifyGeminiError(err) };
    }
  }

  /* ------------------------------ Style pass ------------------------------ */

  async analyzeStyle(input: StyleAnalysisInput): Promise<StyleAnalysisOutput> {
    const parts: Part[] = [];
    const { references } = input;

    // Frame budget is spread across references so 5 files do not blow the request size.
    const perFile = Math.max(3, Math.floor(input.sampledFramesBudget / Math.max(1, references.length)));

    for (const reference of references) {
      parts.push({
        text: `REFERENCE VIDEO ${references.indexOf(reference) + 1} — "${reference.filename}"\nFFmpeg measurements:\n${describeMeasurements(
          reference,
        )}`,
      });
      for (const frame of reference.frames.slice(0, perFile)) {
        parts.push({
          text: `Frame from "${reference.filename}" at ${frame.timestampSeconds}s (${reference.width}x${reference.height}):`,
        });
        parts.push({ inlineData: { mimeType: frame.mimeType, data: frame.base64 } });
      }
      if (reference.audioPath && input.references.length <= 2) {
        // Audio only for 1-2 references; more than that crowds the request.
        parts.push({ text: `Audio track of "${reference.filename}" (downmixed mono 16kHz) — use it for speech, pace and audio style only; timings are approximate.` });
      }
    }

    if (references.some((r) => r.audioPath)) {
      parts.push({
        text: 'Note: audio was extracted but is described by you from the audio parts where provided; if no audio part is attached, do not claim to have heard anything.',
      });
    }

    const text = await this.generate({
      prompt: buildStylePrompt(references.length),
      parts,
      jsonSchema: styleJsonSchema,
      temperature: 0.35,
      maxOutputTokens: 8192,
      thinkingBudget: 2048,
    });

    return this.parseStyle(text, references);
  }

  private parseStyle(text: string, references: VideoEvidence[]): StyleAnalysisOutput {
    const json = extractJsonBlock(text) as Record<string, unknown>;
    const measured = references
      .map((r) => r.averageShotSeconds)
      .filter((v): v is number => typeof v === 'number');

    const mergedMeasured =
      measured.length > 0 ? Number((measured.reduce((a, b) => a + b, 0) / measured.length).toFixed(2)) : null;

    const candidate = {
      ...json,
      evidence: {
        referenceCount: references.length,
        framesSampled: references.reduce((sum, r) => sum + r.frames.length, 0),
        measuredAverageShotSeconds: mergedMeasured,
        audioAvailable: references.some((r) => Boolean(r.audioPath)),
      },
    };

    const parsed = styleProfileSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw {
        code: 'invalid_output',
        message: 'The style analysis did not match the expected format.',
        hint: `${issue?.path.join('.')}: ${issue?.message}`,
        retryable: true,
      } satisfies ProviderError;
    }

    // When FFmpeg measured the shot rhythm and the model disagrees badly, the
    // measurement wins and we say so in the profile.
    const profile = parsed.data;
    if (mergedMeasured && Math.abs(profile.averageShotSeconds.value - mergedMeasured) > 2.5) {
      profile.uncertain.push(
        `Model estimated ${profile.averageShotSeconds.value}s shots but FFmpeg measured ${mergedMeasured}s; the measurement is shown in the metrics.`,
      );
      profile.averageShotSeconds = { value: mergedMeasured, confidence: 'high' };
    }

    const colorGuess = typeof json.captionPrimaryColorHex === 'string' ? json.captionPrimaryColorHex : undefined;
    return {
      profile,
      captionColorHex: colorGuess && /^#[0-9a-fA-F]{6}$/.test(colorGuess) ? colorGuess : undefined,
      rawText: text,
    };
  }

  /* --------------------------- Raw footage pass --------------------------- */

  async analyzeRawFootage(input: RawAnalysisInput): Promise<RawAnalysis> {
    const parts: Part[] = [];
    const { source, brief, style } = input;

    parts.push({
      text: `RAW FOOTAGE — "${source.filename}"\nFFmpeg measurements:\n${describeMeasurements(source)}`,
    });

    parts.push({
      text:
        'Frames follow, in timestamp order. Only these timestamps are evidenced; use them to anchor claims about visuals. ' +
        'Frames were sampled every few seconds, so an event between two frames may be invisible to you — mark that as uncertain.',
    });

    for (const frame of source.frames) {
      parts.push({ text: `t=${frame.timestampSeconds}s` });
      parts.push({ inlineData: { mimeType: frame.mimeType, data: frame.base64 } });
    }

    const text = await this.generate({
      prompt: buildRawAnalysisPrompt({ brief, style, source }),
      parts,
      jsonSchema: rawAnalysisJsonSchema,
      temperature: 0.4,
      maxOutputTokens: 8192,
      thinkingBudget: 4096,
    });

    const json = extractJsonBlock(text) as Record<string, unknown>;
    const parsed = analysisSchema.safeParse({
      ...json,
      audioTranscriptionAvailable: false,
      candidates: Array.isArray(json.candidates) ? json.candidates : [],
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw {
        code: 'invalid_output',
        message: 'The footage analysis did not match the expected format.',
        hint: `${issue?.path.join('.')}: ${issue?.message}`,
        retryable: true,
      } satisfies ProviderError;
    }

    // Clamp to real media bounds; drop anything outside the file.
    const analysis: RawAnalysis = {
      ...parsed.data,
      candidates: parsed.data.candidates
        .map((c) => {
          const start = Math.max(0, Math.min(c.start, source.duration - 0.5));
          const end = Math.max(0, Math.min(c.end, source.duration));
          return { ...c, start: Number(start.toFixed(2)), end: Number(end.toFixed(2)) };
        })
        .filter((c) => c.end - c.start >= 0.8),
      uncertainties: [
        ...parsed.data.uncertainties,
        'Speech was not transcribed: no speech-to-text engine is wired into this build, so dialogue in the analysis is inferred from frames and audio only.',
      ],
    };

    if (analysis.candidates.length === 0) {
      throw {
        code: 'invalid_output',
        message: 'The model found no usable moments in this footage.',
        hint: 'Try longer footage with clear changes in activity.',
        retryable: false,
      } satisfies ProviderError;
    }

    return analysis;
  }

  /* ------------------------------ Plan pass ------------------------------- */

  async planEdit(input: PlanInput): Promise<PlanOutput> {
    const text = await this.generate({
      prompt: buildPlanPrompt(input),
      parts: [],
      jsonSchema: planJsonSchema,
      temperature: 0.6,
      maxOutputTokens: 8192,
      thinkingBudget: 4096,
    });

    const json = extractJsonBlock(text) as Record<string, unknown>;

    let rationale: string[] = [];
    if (Array.isArray(json.rationale)) {
      rationale = json.rationale.filter((r): r is string => typeof r === 'string').slice(0, 10);
    }

    // The model may return either the plan wrapped in { plan, rationale } or bare.
    const unwrapped = json.plan && typeof json.plan === 'object' ? json.plan : json;

    return { plan: unwrapped as unknown as PlanOutput['plan'], rationale, issues: [] };
  }
}

/* ------------------------------- JSON schemas ------------------------------ */

const observation = {
  type: 'object',
  properties: {
    value: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['value', 'confidence'],
} as const;

const styleJsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    hookStructure: observation,
    averageShotSeconds: {
      type: 'object',
      properties: {
        value: { type: 'number' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
      required: ['value', 'confidence'],
    },
    captions: {
      type: 'object',
      properties: {
        present: { type: 'boolean' },
        position: { type: 'string' },
        sizeAndWeight: { type: 'string' },
        colors: { type: 'string' },
        emphasis: { type: 'string' },
        animation: { type: 'string' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
      required: ['present', 'position', 'sizeAndWeight', 'colors', 'emphasis', 'animation', 'confidence'],
    },
    captionPrimaryColorHex: { type: 'string' },
    zooms: observation,
    transitions: observation,
    humorAndMemes: observation,
    soundAndMusic: observation,
    layoutNotes: observation,
    storytelling: observation,
    energy: observation,
    consistentElements: { type: 'array', items: { type: 'string' } },
    uncertain: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'summary',
    'hookStructure',
    'averageShotSeconds',
    'captions',
    'zooms',
    'transitions',
    'humorAndMemes',
    'soundAndMusic',
    'layoutNotes',
    'storytelling',
    'energy',
    'consistentElements',
    'uncertain',
  ],
} as const;

const rawAnalysisJsonSchema = {
  type: 'object',
  properties: {
    overallDescription: { type: 'string' },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number' },
          end: { type: 'number' },
          label: { type: 'string' },
          transcript: { type: 'string' },
          why: { type: 'string' },
          signals: { type: 'array', items: { type: 'string' } },
          hookPotential: { type: 'number' },
          payoff: { type: 'number' },
          clarity: { type: 'number' },
          emotionalPeak: { type: 'number' },
        },
        required: ['start', 'end', 'label', 'why', 'hookPotential', 'payoff', 'clarity', 'emotionalPeak'],
      },
    },
    bestEndingCandidates: { type: 'array', items: { type: 'number' } },
    uncertainties: { type: 'array', items: { type: 'string' } },
  },
  required: ['overallDescription', 'candidates'],
} as const;

const captionCueSchema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    start: { type: 'number' },
    end: { type: 'number' },
    emphasis: { type: 'array', items: { type: 'string' } },
  },
  required: ['text', 'start', 'end'],
} as const;

const planJsonSchema = {
  type: 'object',
  properties: {
    rationale: { type: 'array', items: { type: 'string' } },
    plan: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        hookText: { type: 'string' },
        targetDuration: { type: 'number' },
        endingAndCta: { type: 'string' },
        styleDecisions: { type: 'array', items: { type: 'string' } },
        clips: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              order: { type: 'number' },
              sourceStart: { type: 'number' },
              sourceEnd: { type: 'number' },
              role: { type: 'string', enum: ['hook', 'build', 'payoff', 'cta', 'bridge'] },
              reason: { type: 'string' },
              focusX: { type: 'number' },
              focusY: { type: 'number' },
              zoom: { type: 'number' },
              transitionIn: { type: 'string', enum: ['cut', 'fade', 'whip', 'flash'] },
              captions: { type: 'array', items: captionCueSchema },
            },
            required: ['order', 'sourceStart', 'sourceEnd', 'role', 'reason'],
          },
        },
      },
      required: ['title', 'targetDuration', 'clips'],
    },
  },
  required: ['plan'],
} as const;

export { buildFallbackPlan };
