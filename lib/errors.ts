import { createHash } from 'node:crypto';
import { FfmpegUnavailableError, FFMPEG, run, lastLines } from './ffmpeg';

/**
 * Sanitised errors for the UI. Raw FFmpeg stderr and provider payloads are
 * logged server-side only, never shipped to the browser, and never contain the
 * creator's key because we never put it in a spawn argument or a log line.
 */
export class AppError extends Error {
  code: string;
  hint?: string;
  status: number;

  constructor(code: string, message: string, options?: { hint?: string; status?: number }) {
    super(message);
    this.code = code;
    this.hint = options?.hint;
    this.status = options?.status ?? 400;
  }
}

export function toPublicError(err: unknown): { code: string; message: string; hint?: string } {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, hint: err.hint };
  }
  if (err instanceof FfmpegUnavailableError) {
    return {
      code: 'ffmpeg_missing',
      message: 'FFmpeg is not available on this machine.',
      hint: 'Run "npm install" (the bundled ffmpeg-static binary is used by default), or set FFMPEG_PATH/FFPROBE_PATH to your install. Run "npm run check:env" to test.',
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: 'internal_error',
    message: 'The edit failed unexpectedly.',
    hint: `Server log says: ${message.slice(0, 220)}`,
  };
}

/** Redact anything that looks like an API key before it can reach a log or a response. */
export function redact(text: string): string {
  return text
    .replace(/AIza[0-9A-Za-z\-_]{30,}/g, 'AIza…REDACTED')
    .replace(/x-goog-api-key["':\s]+[0-9A-Za-z\-_]{10,}/gi, 'x-goog-api-key: REDACTED')
    .replace(/key=[0-9A-Za-z\-_]{20,}/gi, 'key=REDACTED');
}

export function fingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 10);
}

export function safeLog(...parts: unknown[]): void {
  const line = parts
    .map((p) => (typeof p === 'string' ? p : p instanceof Error ? p.message : JSON.stringify(p)))
    .join(' ');
  // eslint-disable-next-line no-console
  console.log(`[zekoedit ${new Date().toISOString().slice(11, 19)}] ${redact(line).slice(0, 2000)}`);
}

export async function runOrThrow(
  bin: string,
  args: string[],
  context: string,
  timeoutMs?: number,
): Promise<void> {
  const res = await run(bin, args, timeoutMs);
  if (res.code !== 0) {
    safeLog(`ffmpeg failed (${context})`, lastLines(res.stderr, 3));
    throw new AppError('ffmpeg_failed', `Video processing failed at: ${context}.`, {
      status: 500,
      hint: lastLines(res.stderr, 2) || `Check that ${bin} is working with "npm run check:env".`,
    });
  }
}

export { FFMPEG };
