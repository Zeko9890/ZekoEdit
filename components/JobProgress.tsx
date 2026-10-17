import { useEffect, useRef, useState } from 'react';
import type { JobPublicState } from '@/lib/types';

const STAGE_ORDER: JobPublicState['stage'][] = [
  'queued',
  'probing',
  'extracting_evidence',
  'analyzing_style',
  'analyzing_footage',
  'planning',
  'validating',
  'rendering_clips',
  'rendering_captions',
  'done',
];

function stageIndex(stage: JobPublicState['stage']): number {
  const i = STAGE_ORDER.indexOf(stage);
  return i === -1 ? 0 : i;
}

interface Props {
  jobId: string;
  onUpdate: (state: JobPublicState) => void;
}

/**
 * Polls the job endpoint. Polling (rather than SSE) because Next's node runtime
 * handles it with zero extra plumbing and the stages are seconds, not milliseconds.
 */
export default function JobProgress({ jobId, onUpdate }: Props) {
  const [state, setState] = useState<JobPublicState | null>(null);
  const [transportError, setTransportError] = useState<string | null>(null);
  const stopped = useRef(false);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    stopped.current = false;
    startedAt.current = Date.now();
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (stopped.current) return;
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok) {
          setTransportError(data?.error?.message ?? 'Lost contact with the server.');
          if (data?.error?.code === 'job_missing') {
            stopped.current = true;
            return;
          }
        } else {
          setTransportError(null);
          setState(data as JobPublicState);
          onUpdate(data as JobPublicState);
          if (data.stage === 'done' || data.stage === 'error') {
            stopped.current = true;
            return;
          }
        }
      } catch {
        setTransportError('Network hiccup — retrying…');
      }
      timer = setTimeout(poll, state?.stage === 'rendering_clips' ? 1200 : 900);
    };

    poll();
    return () => {
      stopped.current = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  if (!state && !transportError) {
    return (
      <div className="border-t border-rule py-6 text-sm text-slate">
        <span className="pulse-bar inline-block">Contacting the editor…</span>
      </div>
    );
  }

  const current = state?.stage ?? 'queued';
  const currentIndex = stageIndex(current);
  const isError = current === 'error';
  const elapsed = Math.round((Date.now() - startedAt.current) / 1000);

  const steps = [
    { key: 'extracting_evidence', label: 'Frames and audio' },
    { key: 'analyzing_style', label: 'Your style' },
    { key: 'analyzing_footage', label: 'The footage' },
    { key: 'planning', label: 'Edit decision' },
    { key: 'validating', label: 'Checks' },
    { key: 'rendering_clips', label: 'Render' },
  ];

  return (
    <div className="border-t border-rule pt-6">
      <div className="flex items-baseline justify-between gap-4">
        <p className={`font-mono text-xs uppercase tracking-widest ${isError ? 'text-hot' : 'text-cut'}`}>
          {isError ? 'Stopped' : state?.stageLabel ?? 'Working'}
        </p>
        <p className="font-mono text-xs text-slate">{state?.progress ?? 0}% · {elapsed}s</p>
      </div>

      <p className="mt-2 min-h-[1.5rem] text-sm text-ink" aria-live="polite">
        {isError ? state?.error?.message ?? 'Something went wrong.' : state?.message || 'Working…'}
      </p>

      {isError && state?.error?.hint && (
        <p className="mt-2 border-l-2 border-hot pl-3 text-sm text-slate">{state.error.hint}</p>
      )}

      {/* Progress rail */}
      <div className="mt-4 h-1 w-full overflow-hidden bg-rule" role="progressbar" aria-valuenow={state?.progress ?? 0} aria-valuemin={0} aria-valuemax={100}>
        <div
          className={`h-full transition-[width] duration-700 ease-out ${isError ? 'bg-hot' : 'bg-ink'}`}
          style={{ width: `${Math.max(2, state?.progress ?? 0)}%` }}
        />
      </div>

      <ol className="mt-5 grid grid-cols-3 gap-x-4 gap-y-3 sm:grid-cols-6">
        {steps.map((step) => {
          const stepIdx = STAGE_ORDER.indexOf(step.key as JobPublicState['stage']);
          const done = currentIndex > stepIdx || current === 'done';
          const active = currentIndex === stepIdx;
          return (
            <li key={step.key} className="flex flex-col gap-1">
              <span
                className={`h-[2px] w-full ${done ? 'bg-ink' : active ? 'bg-cut' : 'bg-rule'}`}
                aria-hidden="true"
              />
              <span
                className={`font-mono text-[11px] leading-tight ${
                  done ? 'text-ink' : active ? 'text-cut' : 'text-slate/70'
                }`}
              >
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>

      {transportError && <p className="mt-3 font-mono text-xs text-hot">{transportError}</p>}

      {!isError && current !== 'done' && (
        <p className="mt-5 text-xs leading-relaxed text-slate">
          Rendering happens locally with FFmpeg. Longer footage takes longer — a two-minute raw clip usually takes
          under a minute once the analysis is done.
        </p>
      )}
    </div>
  );
}
