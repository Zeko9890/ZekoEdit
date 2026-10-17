import path from 'node:path';

/** Central limits. Change these here, not at call sites. */
export const LIMITS = {
  // `request.formData()` buffers the whole multipart body in memory, so these
  // caps are about RSS, not arbitrary policy. Raise them only with streaming
  // uploads in place (the current route does not stream).
  maxSourceBytes: 300 * 1024 * 1024,
  maxReferenceBytes: 60 * 1024 * 1024,
  maxMusicBytes: 30 * 1024 * 1024,
  maxReferences: 5,
  maxSourceSeconds: 10 * 60,
  maxReferenceSeconds: 4 * 60,
  /** Total payload guard before we touch the filesystem. */
  maxTotalUploadBytes: 400 * 1024 * 1024,
} as const;

export const ACCEPTED_VIDEO_MIME = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-msvideo',
  'application/octet-stream',
];

export const ACCEPTED_VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'];

export const ACCEPTED_AUDIO_EXT = ['.mp3', '.m4a', '.wav', '.aac', '.ogg'];

export function dataDir(): string {
  return process.env.ZEKO_DATA_DIR?.trim() || path.join(process.cwd(), 'data', 'jobs');
}

export function maxRefsMessage(): string {
  return `Upload between 0 and ${LIMITS.maxReferences} reference videos.`;
}
