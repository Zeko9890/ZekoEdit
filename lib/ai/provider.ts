import type {
  Candidate,
  CreatorBrief,
  EditPlan,
  RawAnalysis,
  StyleProfile,
} from './types';
import type { VideoEvidence } from './evidence';

/**
 * One provider interface, one implementation. Adding OpenAI/Claude later means
 * writing another class with this shape and selecting it by an env flag; nothing
 * in the pipeline or the renderer changes.
 */

export interface ProviderError {
  code:
    | 'invalid_key'
    | 'quota_exhausted'
    | 'model_unavailable'
    | 'rate_limited'
    | 'blocked'
    | 'invalid_output'
    | 'network'
    | 'unknown';
  message: string;
  hint?: string;
  retryable: boolean;
}

export interface ProviderCapabilities {
  /** Whether raw video files can be sent instead of sampled frames. */
  nativeVideo: boolean;
  /** Whether audio can be sent separately and reasoned about. */
  audio: boolean;
  /** Max bytes acceptable in one upload request. */
  maxUploadBytes: number;
}

export interface StyleAnalysisInput {
  references: VideoEvidence[];
  sampledFramesBudget: number;
}

export interface StyleAnalysisOutput {
  profile: StyleProfile;
  /** Hex colour the model claims to have seen, only if it named one. */
  captionColorHex?: string;
  rawText: string;
}

export interface RawAnalysisInput {
  source: VideoEvidence;
  brief: CreatorBrief;
  style: StyleProfile;
}

export interface PlanInput {
  brief: CreatorBrief;
  style: StyleProfile;
  analysis: RawAnalysis;
  sourceDuration: number;
  candidates: Candidate[];
}

export interface PlanOutput {
  plan: EditPlan;
  rationale: string[];
  issues: string[];
}

export interface AIProvider {
  readonly id: string;
  readonly displayName: string;
  readonly model: string;
  readonly pricingNote: string;
  readonly capabilities: ProviderCapabilities;

  /** Cheap round-trip to reject a bad key before uploads or extraction begin. */
  validateKey(): Promise<{ ok: true } | { ok: false; error: ProviderError }>;

  analyzeStyle(input: StyleAnalysisInput): Promise<StyleAnalysisOutput>;
  analyzeRawFootage(input: RawAnalysisInput): Promise<RawAnalysis>;
  planEdit(input: PlanInput): Promise<PlanOutput>;
}
