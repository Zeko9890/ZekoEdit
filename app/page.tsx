'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JobProgress from '@/components/JobProgress';
import StyleProfileCard from '@/components/StyleProfileCard';
import EditPlanView from '@/components/EditPlanView';
import { formatBytes, formatTime } from '@/lib/format';
import type { CreatorBrief, JobPublicState } from '@/lib/types';

/* -------------------------------------------------------------------------- */
/*                                Small pieces                                */
/* -------------------------------------------------------------------------- */

function Label({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <span className="font-mono text-[11px] uppercase tracking-wider text-slate">{children}</span>
      {hint && <span className="font-mono text-[10px] text-slate/70">{hint}</span>}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`border px-2.5 py-1.5 text-[13px] transition-colors disabled:opacity-50 ${
              selected
                ? 'border-ink bg-ink text-paper'
                : 'border-rule bg-transparent text-ink hover:border-ink'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props;
  return (
    <input
      {...rest}
      className={`w-full border border-rule bg-white/40 px-3 py-2 text-sm text-ink placeholder:text-slate/60 focus:border-ink focus:bg-white ${className}`}
    />
  );
}

function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props;
  return (
    <textarea
      {...rest}
      className={`w-full resize-y border border-rule bg-white/40 px-3 py-2 text-sm leading-relaxed text-ink placeholder:text-slate/60 focus:border-ink focus:bg-white ${className}`}
    />
  );
}

function DropZone({
  label,
  hint,
  files,
  onFiles,
  multiple,
  accept,
  disabled,
  compact,
}: {
  label: string;
  hint: string;
  files: File[];
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  accept: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hover, setHover] = useState(false);

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setHover(false);
    if (disabled) return;
    const dropped = Array.from(event.dataTransfer.files);
    if (dropped.length) onFiles(multiple ? dropped : dropped.slice(0, 1));
  };

  return (
    <div>
      <Label hint={hint}>{label}</Label>
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setHover(true);
        }}
        onDragLeave={() => setHover(false)}
        onDrop={handleDrop}
        className={`w-full border border-dashed px-3 text-left transition-colors disabled:opacity-50 ${
          hover ? 'border-cut bg-cut/5' : 'border-rule hover:border-slate'
        } ${compact ? 'py-2.5' : 'py-5'}`}
      >
        {files.length === 0 ? (
          <span className="block text-sm text-slate">
            Drop {multiple ? 'files' : 'a file'} here or <span className="text-cut underline">choose</span>
          </span>
        ) : (
          <span className="block space-y-1">
            {files.map((file) => (
              <span key={`${file.name}-${file.size}`} className="flex items-baseline justify-between gap-3">
                <span className="truncate text-sm text-ink">{file.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-slate">{formatBytes(file.size)}</span>
              </span>
            ))}
            <span className="block pt-1 font-mono text-[11px] text-cut">
              {files.length > 1 ? `${files.length} files selected — ` : ''}click to replace
            </span>
          </span>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="sr-only"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          if (picked.length) onFiles(multiple ? picked : picked.slice(0, 1));
          e.target.value = '';
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                    Page                                    */
/* -------------------------------------------------------------------------- */

const CONTENT_TYPES = [
  { value: 'gaming_highlight', label: 'Gaming highlight' },
  { value: 'funny_moment', label: 'Funny moment' },
  { value: 'reaction', label: 'Reaction' },
  { value: 'educational', label: 'Educational' },
  { value: 'tutorial', label: 'Tutorial' },
  { value: 'commentary', label: 'Commentary' },
  { value: 'storytime', label: 'Storytime' },
  { value: 'vlog', label: 'Vlog' },
  { value: 'product_promo', label: 'Product promotion' },
  { value: 'custom', label: 'Custom' },
] as const;

const OBJECTIVES = [
  { value: 'entertain', label: 'Entertain' },
  { value: 'teach', label: 'Teach' },
  { value: 'surprise', label: 'Surprise' },
  { value: 'retain', label: 'Keep watching' },
  { value: 'tell_story', label: 'Tell a story' },
  { value: 'promote', label: 'Promote' },
  { value: 'drive_cta', label: 'Drive an action' },
] as const;

const PLATFORMS = [
  { value: 'youtube_shorts', label: 'YouTube Shorts' },
  { value: 'instagram_reels', label: 'Reels' },
  { value: 'tiktok', label: 'TikTok' },
] as const;

const DURATIONS = [15, 30, 45, 60];

interface HealthState {
  ok: boolean;
  ffmpeg: { path: string; version: string | null; ok: boolean; error?: string };
  ffprobe: { ok: boolean; error?: string };
  libass: boolean;
  dataWritable: boolean;
  model: string;
}

export default function Page() {
  /* Key & files */
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [sourceFiles, setSourceFiles] = useState<File[]>([]);
  const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
  const [musicFiles, setMusicFiles] = useState<File[]>([]);

  /* Brief */
  const [contentType, setContentType] = useState<CreatorBrief['contentType']>('gaming_highlight');
  const [customContentType, setCustomContentType] = useState('');
  const [objective, setObjective] = useState<CreatorBrief['objective']>('entertain');
  const [audience, setAudience] = useState('');
  const [duration, setDuration] = useState(30);
  const [customDuration, setCustomDuration] = useState('');
  const [platform, setPlatform] = useState<CreatorBrief['platform']>('youtube_shorts');
  const [language, setLanguage] = useState<CreatorBrief['language']>('original');
  const [intensity, setIntensity] = useState<CreatorBrief['intensity']>('balanced');
  const [captionStyle, setCaptionStyle] = useState<CreatorBrief['captionStyle']>('clean');
  const [effects, setEffects] = useState({
    zooms: true,
    transitions: false,
    soundEffects: false,
    memes: false,
    music: false,
  });
  const [mustInclude, setMustInclude] = useState('');
  const [avoid, setAvoid] = useState('');
  const [callToAction, setCallToAction] = useState('');
  const [audioMode, setAudioMode] = useState<CreatorBrief['audioMode']>('preserve');

  /* Job */
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobPublicState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<{ message: string; hint?: string } | null>(null);
  const [health, setHealth] = useState<HealthState | null>(null);

  const resultRef = useRef<HTMLDivElement>(null);

  const refreshHealth = useCallback(async (force = false) => {
    try {
      const res = await fetch(`/api/health${force ? '?refresh=1' : ''}`, { cache: 'no-store' });
      const data = (await res.json()) as HealthState;
      setHealth(data);
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    refreshHealth();
  }, [refreshHealth]);

  useEffect(() => {
    if (job && (job.stage === 'done' || job.stage === 'error')) {
      resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [job?.stage]);

  const effectiveDuration = useMemo(() => {
    const custom = Number(customDuration);
    return Number.isFinite(custom) && custom >= 5 && custom <= 180 ? custom : duration;
  }, [customDuration, duration]);

  const brief: CreatorBrief = useMemo(
    () => ({
      contentType,
      customContentType: contentType === 'custom' ? customContentType.trim() : undefined,
      objective,
      audience: audience.trim(),
      targetDuration: effectiveDuration,
      platform,
      language,
      intensity,
      captionStyle,
      effects,
      mustInclude: mustInclude.trim() || undefined,
      avoid: avoid.trim() || undefined,
      callToAction: callToAction.trim() || undefined,
      audioMode,
    }),
    [
      contentType,
      customContentType,
      objective,
      audience,
      effectiveDuration,
      platform,
      language,
      intensity,
      captionStyle,
      effects,
      mustInclude,
      avoid,
      callToAction,
      audioMode,
    ],
  );

  const canSubmit =
    !submitting &&
    apiKey.trim().length > 10 &&
    sourceFiles.length === 1 &&
    audience.trim().length >= 2 &&
    // health === null means still checking; do not block a fast submit on it.
    (health === null || health.ok);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);

    if (sourceFiles.length !== 1) {
      setFormError({ message: 'Choose exactly one raw video to edit.' });
      return;
    }
    if (audience.trim().length < 2) {
      setFormError({ message: 'Describe who this short is for — even a few words help the edit.' });
      return;
    }
    if (apiKey.trim().length < 10) {
      setFormError({ message: 'Enter your Gemini API key.' });
      return;
    }

    setSubmitting(true);
    setJob(null);
    try {
      const body = new FormData();
      body.set('apiKey', apiKey.trim());
      body.set('brief', JSON.stringify(brief));
      body.set('source', sourceFiles[0]);
      for (const ref of referenceFiles) body.append('references', ref);
      if (musicFiles[0]) body.set('music', musicFiles[0]);

      const res = await fetch('/api/jobs', { method: 'POST', body });
      const data = await res.json();

      if (!res.ok) {
        setFormError({
          message: data?.error?.message ?? 'The edit could not start.',
          hint: data?.error?.hint,
        });
        return;
      }
      setJobId(data.jobId as string);
    } catch {
      setFormError({
        message: 'Could not reach the local server.',
        hint: 'Check the terminal running "npm run dev" and try again.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setJobId(null);
    setJob(null);
    setFormError(null);
    // The key stays in page state only; clearing the job does not store it anywhere.
  };

  const running = Boolean(jobId) && job?.stage !== 'done' && job?.stage !== 'error';
  const locked = running;

  return (
    <main className="mx-auto w-full max-w-[1240px] px-5 pb-24 pt-6 sm:px-8">
      {/* Top rail */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink pb-3">
        <div className="flex items-baseline gap-3">
          <span className="font-display text-[26px] leading-none tracking-tight">ZekoEdit</span>
          <span className="font-mono text-[11px] text-slate">vertical cut, your style</span>
        </div>
        <div className="flex items-center gap-3 font-mono text-[11px]">
          <span
            className={`inline-flex items-center gap-1.5 ${health?.ok ? 'text-cut' : 'text-hot'}`}
            title={health?.ffmpeg.error ?? undefined}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${health?.ok ? 'bg-cut' : 'bg-hot'}`} />
            {health === null ? 'checking ffmpeg' : health.ok ? `ffmpeg ready${health.libass ? ' · captions' : ''}` : 'ffmpeg missing'}
          </span>
          {health?.model && <span className="text-slate">{health.model}</span>}
        </div>
      </header>

      {/* Intro */}
      <section className="mt-8 grid gap-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-end">
        <div className="animate-rise">
          <h1 className="max-w-[20ch] font-display text-[42px] leading-[0.98] tracking-[-0.01em] sm:text-[58px]">
            Cut your raw footage the way <em className="italic">you</em> cut.
          </h1>
          <p className="mt-4 max-w-[54ch] text-[15px] leading-relaxed text-ink/80">
            Give ZekoEdit a few of your finished Shorts and the raw file. It reads the rhythm, captions and pacing
            from your references, chooses moments from the new footage, and renders a vertical MP4 here on your
            machine.
          </p>
        </div>
        <dl className="animate-sweep border-t-2 border-ink pt-2 sm:border-t-0">
          <div className="grid grid-cols-3 gap-3">
            {[
              { k: 'canvas', v: '1080 × 1920' },
              { k: 'engine', v: 'FFmpeg (local)' },
              { k: 'billed to', v: 'your API key' },
            ].map((item) => (
              <div key={item.k}>
                <dt className="font-mono text-[10px] uppercase tracking-wider text-slate">{item.k}</dt>
                <dd className="mt-0.5 font-mono text-[12px] text-ink">{item.v}</dd>
              </div>
            ))}
          </div>
        </dl>
      </section>

      <form onSubmit={submit} className="mt-10 grid gap-x-10 gap-y-8 lg:grid-cols-[1fr_380px]">
        {/* ------------------------------ Left column ------------------------------ */}
        <div className="space-y-9">
          {/* API key */}
          <fieldset disabled={locked} className="disabled:opacity-60">
            <legend className="mb-3 font-display text-2xl">Your Gemini key</legend>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <TextInput
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="AIza…"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Google Gemini API key"
                  className="pr-16 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[11px] text-slate underline decoration-rule underline-offset-2 hover:text-ink"
                >
                  {showKey ? 'hide' : 'show'}
                </button>
              </div>
            </div>
            <p className="mt-2 max-w-[62ch] text-xs leading-relaxed text-slate">
              Google Gemini. Get one at{' '}
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noreferrer"
                className="text-cut underline decoration-cut/40 underline-offset-2"
              >
                aistudio.google.com/apikey
              </a>
              . The key is sent to the local server, used in memory for this edit, then dropped — it is never
              written to disk, localStorage, or a log. Usage is billed to your Google account.
            </p>
          </fieldset>

          {/* Footage */}
          <fieldset disabled={locked} className="disabled:opacity-60">
            <legend className="mb-3 font-display text-2xl">Footage</legend>
            <div className="grid gap-5 sm:grid-cols-2">
              <DropZone
                label="Raw footage"
                hint="one file · mp4, mov, mkv, webm · up to 600 MB"
                files={sourceFiles}
                onFiles={setSourceFiles}
                accept="video/*"
                disabled={locked}
              />
              <DropZone
                label="Your edited shorts (references)"
                hint="1–5 files · each up to 200 MB"
                files={referenceFiles}
                onFiles={(files) => setReferenceFiles(files.slice(0, 5))}
                accept="video/*"
                multiple
                disabled={locked}
              />
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate">
              References should be videos <em>you</em> edited — the finished cuts you posted. They teach the style;
              the raw file is what gets cut. With no references, ZekoEdit still edits, but it has no style to
              follow and says so.
            </p>
          </fieldset>

          {/* Purpose */}
          <fieldset disabled={locked} className="disabled:opacity-60">
            <legend className="mb-3 font-display text-2xl">What this short is for</legend>
            <div className="space-y-4">
              <div>
                <Label>Content type</Label>
                <Segmented value={contentType} options={CONTENT_TYPES} onChange={setContentType} />
                {contentType === 'custom' && (
                  <TextInput
                    className="mt-2"
                    value={customContentType}
                    onChange={(e) => setCustomContentType(e.target.value)}
                    placeholder="Describe the format, e.g. speedrun commentary"
                    maxLength={80}
                  />
                )}
              </div>

              <div>
                <Label>Objective</Label>
                <Segmented value={objective} options={OBJECTIVES} onChange={setObjective} />
              </div>

              <div>
                <Label hint="required">Who is watching</Label>
                <TextInput
                  value={audience}
                  onChange={(e) => setAudience(e.target.value)}
                  placeholder="e.g. 16–24 year olds who follow competitive Valorant, watching on a phone"
                  maxLength={400}
                  required
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label hint="seconds">Target duration</Label>
                  <Segmented
                    value={String(duration)}
                    options={DURATIONS.map((d) => ({ value: String(d), label: `${d}s` }))}
                    onChange={(v) => {
                      setDuration(Number(v));
                      setCustomDuration('');
                    }}
                  />
                  <TextInput
                    className="mt-2"
                    value={customDuration}
                    onChange={(e) => setCustomDuration(e.target.value.replace(/[^0-9]/g, ''))}
                    placeholder="Custom (5–180s)"
                    inputMode="numeric"
                  />
                </div>
                <div>
                  <Label>Platform</Label>
                  <Segmented value={platform} options={PLATFORMS} onChange={setPlatform} />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label>Language of captions</Label>
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value as CreatorBrief['language'])}
                    className="w-full border border-rule bg-white/40 px-3 py-2 text-sm focus:border-ink focus:bg-white"
                  >
                    <option value="original">Same as the footage</option>
                    <option value="en">English</option>
                    <option value="hi">Hindi</option>
                    <option value="es">Spanish</option>
                    <option value="pt">Portuguese</option>
                    <option value="fr">French</option>
                    <option value="de">German</option>
                    <option value="id">Indonesian</option>
                    <option value="ja">Japanese</option>
                  </select>
                </div>
                <div>
                  <Label>Editing intensity</Label>
                  <Segmented
                    value={intensity}
                    options={[
                      { value: 'clean', label: 'Clean' },
                      { value: 'balanced', label: 'Balanced' },
                      { value: 'energetic', label: 'Energetic' },
                    ]}
                    onChange={setIntensity}
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label>Captions</Label>
                  <Segmented
                    value={captionStyle}
                    options={[
                      { value: 'off', label: 'Off' },
                      { value: 'clean', label: 'Clean' },
                      { value: 'creator_animated', label: 'Animated' },
                    ]}
                    onChange={setCaptionStyle}
                  />
                </div>
                <div>
                  <Label hint="defaults to preserving sound">Original audio</Label>
                  <Segmented
                    value={audioMode}
                    options={[
                      { value: 'preserve', label: 'Preserve' },
                      { value: 'reduce', label: 'Reduce' },
                      { value: 'replace', label: 'Replace' },
                    ]}
                    onChange={setAudioMode}
                  />
                </div>
              </div>

              {(audioMode === 'replace' || effects.music) && (
                <div>
                  <DropZone
                    label={audioMode === 'replace' ? 'Replacement audio' : 'Music bed'}
                    hint={
                      audioMode === 'replace'
                        ? 'required for "replace" · mp3, m4a, wav, aac, ogg'
                        : 'mp3, m4a, wav · looped and ducked under your voice'
                    }
                    files={musicFiles}
                    onFiles={setMusicFiles}
                    accept="audio/*"
                    compact
                    disabled={locked}
                  />
                </div>
              )}

              <div>
                <Label hint="optional">Effects</Label>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {(
                    [
                      ['zooms', 'Punch-in zooms'],
                      ['transitions', 'Transitions'],
                      ['soundEffects', 'Sound effects'],
                      ['memes', 'Meme cues'],
                      ['music', 'Music bed'],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={effects[key]}
                        onChange={(e) => setEffects((prev) => ({ ...prev, [key]: e.target.checked }))}
                        className="h-3.5 w-3.5 accent-ink"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label hint="optional">Must include</Label>
                  <TextArea
                    rows={2}
                    value={mustInclude}
                    onChange={(e) => setMustInclude(e.target.value)}
                    placeholder="The clutch 1v3, or the line where I explain the settings"
                    maxLength={600}
                  />
                </div>
                <div>
                  <Label hint="optional">Avoid</Label>
                  <TextArea
                    rows={2}
                    value={avoid}
                    onChange={(e) => setAvoid(e.target.value)}
                    placeholder="No deaths, no spoilers for the ending, no loud reactions"
                    maxLength={600}
                  />
                </div>
              </div>

              <div>
                <Label hint="optional">Call to action</Label>
                <TextInput
                  value={callToAction}
                  onChange={(e) => setCallToAction(e.target.value)}
                  placeholder="Follow for the full run tomorrow"
                  maxLength={200}
                />
              </div>
            </div>
          </fieldset>
        </div>

        {/* ------------------------------ Right column ----------------------------- */}
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div className="border border-ink bg-white/50 p-4">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[10px] uppercase tracking-wider text-slate">Your cut</span>
              <span className="font-mono text-[11px]">9:16 · {effectiveDuration}s</span>
            </div>

            {/* Phone-shaped frame; the render lands here. */}
            <div className="mt-3 aspect-[9/16] w-full overflow-hidden border border-rule bg-ink/95">
              {job?.stage === 'done' && job.videoUrl ? (
                <video
                  key={job.videoUrl}
                  src={job.videoUrl}
                  controls
                  playsInline
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="flex h-full flex-col justify-between p-3">
                  <span className="font-mono text-[10px] text-paper/50">
                    {sourceFiles[0] ? sourceFiles[0].name : 'no footage yet'}
                  </span>
                  <div className="space-y-1.5" aria-hidden="true">
                    {[92, 74, 58, 81, 40].map((w, i) => (
                      <div
                        key={i}
                        className={`h-1 ${running && i % 2 === 0 ? 'pulse-bar' : ''} ${
                          job && job.progress > i * 18 ? 'bg-paper' : 'bg-paper/20'
                        }`}
                        style={{ width: `${w}%` }}
                      />
                    ))}
                  </div>
                  <span className="font-mono text-[10px] text-paper/50">
                    {job ? job.stageLabel : 'preview appears here'}
                  </span>
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={!canSubmit}
              className="mt-4 w-full bg-ink px-4 py-3 text-sm font-medium text-paper transition-colors hover:bg-cut disabled:cursor-not-allowed disabled:bg-slate/40"
            >
              {submitting ? 'Starting…' : running ? 'Editing…' : 'Analyze & create short'}
            </button>

            {!health?.ok && health !== null && (
              <p className="mt-3 border-l-2 border-hot pl-2 text-xs leading-relaxed text-ink/80">
                FFmpeg is not available, so rendering is disabled. Run{' '}
                <code className="font-mono text-[11px]">npm install</code> to fetch the bundled binary, then{' '}
                <button
                  type="button"
                  onClick={() => refreshHealth(true)}
                  className="underline decoration-hot/40 underline-offset-2"
                >
                  re-check
                </button>
                .
              </p>
            )}

            {formError && (
              <div className="mt-3 border-l-2 border-hot pl-2" role="alert">
                <p className="text-sm text-ink">{formError.message}</p>
                {formError.hint && <p className="mt-1 text-xs leading-relaxed text-slate">{formError.hint}</p>}
              </div>
            )}

            <dl className="mt-4 space-y-1 border-t border-rule pt-3 font-mono text-[11px] text-slate">
              <div className="flex justify-between">
                <dt>references</dt>
                <dd>{referenceFiles.length} file{referenceFiles.length === 1 ? '' : 's'}</dd>
              </div>
              <div className="flex justify-between">
                <dt>raw footage</dt>
                <dd>{sourceFiles[0] ? formatBytes(sourceFiles[0].size) : '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt>captions</dt>
                <dd>{captionStyle === 'off' ? 'off' : captionStyle.replace('_', ' ')}</dd>
              </div>
              <div className="flex justify-between">
                <dt>audio</dt>
                <dd>{audioMode}</dd>
              </div>
            </dl>
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-slate">
            Analysis and rendering run on this machine. Only frames, short audio segments and your brief go to
            Google&rsquo;s API.
          </p>
        </aside>
      </form>

      {/* ------------------------------- Results ------------------------------- */}
      <div ref={resultRef} className="mt-14 space-y-10">
        {jobId && (
          <section className="border-t-2 border-ink pt-4">
            <JobProgress jobId={jobId} onUpdate={setJob} />
          </section>
        )}

        {job?.styleProfile && job.stage !== 'queued' && (
          <StyleProfileCard profile={job.styleProfile} />
        )}

        {job?.plan && (
          <EditPlanView
            plan={job.plan}
            rationale={job.rationale}
            issues={job.issues}
            warnings={job.warnings}
            renderedDuration={job.renderedDuration}
            plannedDuration={job.plannedDuration}
          />
        )}

        {job?.stage === 'done' && (
          <section className="animate-rise border border-ink bg-white/50 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-display text-2xl">{job.plan?.title ?? 'Your short'}</h3>
                <p className="mt-1 font-mono text-[11px] text-slate">
                  {formatTime(job.renderedDuration)} · 1080×1920 · mp4
                  {job.source?.hasAudio ? ' · with audio' : ' · silent source'}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <a
                  href={job.downloadUrl}
                  className="border border-ink px-3.5 py-2 text-sm transition-colors hover:bg-ink hover:text-paper"
                >
                  Download MP4
                </a>
                <a
                  href={job.planUrl}
                  className="border border-rule px-3.5 py-2 text-sm text-ink transition-colors hover:border-ink"
                >
                  Edit plan (JSON)
                </a>
                <button
                  type="button"
                  onClick={reset}
                  className="px-1 py-2 text-sm text-cut underline decoration-cut/30 underline-offset-4"
                >
                  Edit something else
                </button>
              </div>
            </div>
          </section>
        )}

        {job?.stage === 'error' && (
          <section className="border border-hot/60 p-4">
            <h3 className="font-display text-xl text-ink">This one stopped</h3>
            <p className="mt-1 text-sm text-ink/90">{job.error?.message}</p>
            {job.error?.hint && <p className="mt-1 text-xs leading-relaxed text-slate">{job.error.hint}</p>}
            <button
              type="button"
              onClick={reset}
              className="mt-3 border border-ink px-3 py-1.5 text-sm hover:bg-ink hover:text-paper"
            >
              Change the settings
            </button>
          </section>
        )}
      </div>

      <footer className="mt-16 flex flex-wrap items-baseline justify-between gap-2 border-t border-rule pt-3 font-mono text-[11px] text-slate">
        <span>ZekoEdit · local MVP · no accounts, no database, no cloud storage</span>
        <span>jobs live in memory and disappear when the server restarts</span>
      </footer>
    </main>
  );
}
