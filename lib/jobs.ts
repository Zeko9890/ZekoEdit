import type { MediaInfo, Stage } from './types';

interface JobRecord {
  id: string;
  stage: Stage;
  progress: number;
  message: string;
  createdAt: number;
  updatedAt: number;
  data: Record<string, unknown>;
  apiKey: string;
  dir: string;
  aborted: boolean;
  listeners: Set<(event: string, payload: unknown) => void>;
}

const JOBS_KEY = Symbol.for('zekoedit.jobs');

type GlobalWithJobs = typeof globalThis & {
  [JOBS_KEY]?: Map<string, JobRecord>;
};

function registry(): Map<string, JobRecord> {
  const g = globalThis as GlobalWithJobs;
  if (!g[JOBS_KEY]) g[JOBS_KEY] = new Map();
  return g[JOBS_KEY]!;
}

/** Best-effort in-memory only. Keys live here and die with the process. */
export function createJob(id: string, apiKey: string, dir: string): JobRecord {
  const now = Date.now();
  const job: JobRecord = {
    id,
    stage: 'queued',
    progress: 0,
    message: '',
    createdAt: now,
    updatedAt: now,
    data: {},
    apiKey,
    dir,
    aborted: false,
    listeners: new Set(),
  };
  registry().set(id, job);
  return job;
}

export function getJob(id: string): JobRecord | undefined {
  return registry().get(id);
}

export function setStage(job: JobRecord, stage: Stage, message: string, progress: number): void {
  job.stage = stage;
  job.message = message;
  job.progress = Math.max(0, Math.min(100, Math.round(progress)));
  job.updatedAt = Date.now();
  emit(job, 'state', snapshot(job));
}

export function setData(job: JobRecord, patch: Record<string, unknown>): void {
  Object.assign(job.data, patch);
  job.updatedAt = Date.now();
  emit(job, 'state', snapshot(job));
}

export function emit(job: JobRecord, event: string, payload: unknown): void {
  for (const fn of job.listeners) {
    try {
      fn(event, payload);
    } catch {
      /* listener torn down mid-render */
    }
  }
}

export function subscribe(job: JobRecord, fn: (event: string, payload: unknown) => void): () => void {
  job.listeners.add(fn);
  return () => job.listeners.delete(fn);
}

export function snapshot(job: JobRecord): Record<string, unknown> {
  const { apiKey: _omit, listeners: _l, ...rest } = job;
  void _omit;
  void _l;
  return {
    id: rest.id,
    stage: rest.stage,
    progress: rest.progress,
    message: rest.message,
    createdAt: rest.createdAt,
    updatedAt: rest.updatedAt,
    ...rest.data,
  };
}

/**
 * Fixed-window rate limit and job cap so a local demo cannot fork-bomb FFmpeg.
 * Not security — convenience. Real auth is out of scope for the MVP.
 */
const MAX_JOBS = 12;
const MAX_JOBS_PER_WINDOW = 6;
const WINDOW_MS = 60_000;
const windows = new Map<string, number[]>();

export function allowNewJob(clientKey: string): { ok: true } | { ok: false; reason: string } {
  const now = Date.now();
  for (const [id, job] of registry()) {
    if (now - job.createdAt > 1000 * 60 * 60 * 3) registry().delete(id);
  }
  if (registry().size >= MAX_JOBS) {
    return { ok: false, reason: `Too many jobs in memory (${MAX_JOBS}). Restart the dev server to clear them.` };
  }
  const hits = (windows.get(clientKey) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= MAX_JOBS_PER_WINDOW) {
    return { ok: false, reason: 'Too many edits started in a minute. Wait a moment and try again.' };
  }
  hits.push(now);
  windows.set(clientKey, hits);
  return { ok: true };
}

export function countActive(): number {
  return registry().size;
}

export function mediaInfoFrom(data: Record<string, unknown>): MediaInfo | undefined {
  return data.source as MediaInfo | undefined;
}
