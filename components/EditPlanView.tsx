import type { EditPlan } from '@/lib/types';
import { formatTime } from '@/lib/format';

function sourceRange(clip: EditPlan['clips'][number]): string {
  return `${formatTime(clip.sourceStart)}–${formatTime(clip.sourceEnd)}`;
}

export default function EditPlanView({
  plan,
  rationale,
  issues,
  warnings,
  renderedDuration,
  plannedDuration,
}: {
  plan: EditPlan;
  rationale?: string[];
  issues?: string[];
  warnings?: string[];
  renderedDuration?: number;
  plannedDuration?: number;
}) {
  const lengths = plan.clips.map((c) => Math.max(0.1, c.sourceEnd - c.sourceStart));
  const total = lengths.reduce((a, b) => a + b, 0);

  return (
    <section aria-labelledby="plan-heading" className="animate-rise">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id="plan-heading" className="font-display text-2xl">
          The edit
        </h3>
        <p className="font-mono text-[11px] text-slate">
          {plan.clips.length} clips · planned {formatTime(plannedDuration ?? total)}
          {renderedDuration ? ` · rendered ${formatTime(renderedDuration)}` : ''}
        </p>
      </div>

      {/* Timeline strip: width proportional to real clip length. */}
      <div className="mt-4 flex h-14 w-full gap-[3px]" aria-hidden="true">
        {plan.clips.map((clip, i) => {
          const pct = (lengths[i] / total) * 100;
          const tone =
            clip.role === 'hook'
              ? 'bg-ink text-paper'
              : clip.role === 'payoff' || clip.role === 'cta'
                ? 'bg-cut text-paper'
                : 'bg-rule text-ink';
          return (
            <div
              key={`${clip.order}-${i}`}
              className={`flex min-w-[26px] flex-col justify-between overflow-hidden px-1.5 py-1 ${tone}`}
              style={{ width: `${pct}%` }}
              title={`${clip.role} · ${sourceRange(clip)}`}
            >
              <span className="font-mono text-[10px] leading-none opacity-80">{clip.order}</span>
              <span className="truncate font-mono text-[10px] leading-none opacity-80">
                {(clip.sourceEnd - clip.sourceStart).toFixed(1)}s
              </span>
            </div>
          );
        })}
      </div>

      {rationale && rationale.length > 0 && (
        <div className="mt-5">
          <p className="font-mono text-[10px] uppercase tracking-wider text-cut">Why these moments</p>
          <ul className="mt-1.5 space-y-1.5 text-[15px] leading-relaxed text-ink/90">
            {rationale.map((line, i) => (
              <li key={i} className="border-l border-rule pl-3">
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ol className="mt-6 divide-y divide-rule border-y border-rule">
        {plan.clips.map((clip, i) => (
          <li key={`${clip.order}-detail-${i}`} className="grid grid-cols-[auto_1fr] gap-3 py-3 sm:gap-5">
            <div className="flex w-14 flex-col items-start gap-1">
              <span className="font-mono text-[11px] text-slate">{String(clip.order).padStart(2, '0')}</span>
              <span
                className={`font-mono text-[10px] uppercase tracking-wider ${
                  clip.role === 'hook' ? 'text-ink' : 'text-cut'
                }`}
              >
                {clip.role}
              </span>
            </div>
            <div className="min-w-0">
              <p className="font-mono text-[11px] text-slate">
                {sourceRange(clip)} of the raw file · {(clip.sourceEnd - clip.sourceStart).toFixed(1)}s
                {clip.zoom > 1 ? ` · ${Math.round((clip.zoom - 1) * 100)}% punch-in` : ''}
                {clip.transitionIn !== 'cut' ? ` · ${clip.transitionIn} in` : ''}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-ink">{clip.reason}</p>
              {clip.captions.length > 0 && (
                <details className="mt-1.5">
                  <summary className="cursor-pointer font-mono text-[11px] text-cut">
                    {clip.captions.length} caption{clip.captions.length === 1 ? '' : 's'}
                  </summary>
                  <ul className="mt-1.5 space-y-0.5 pl-3">
                    {clip.captions.map((cue, j) => (
                      <li key={j} className="font-mono text-[11px] text-slate">
                        {cue.start.toFixed(1)}–{cue.end.toFixed(1)}s &ldquo;{cue.text}&rdquo;
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {plan.styleDecisions.length > 0 && (
          <div>
            <p className="font-mono text-[10px] uppercase tracking-wider text-slate">Style decisions</p>
            <ul className="mt-1 space-y-1 text-sm leading-relaxed text-ink/90">
              {plan.styleDecisions.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </div>
        )}
        {plan.endingAndCta && (
          <div>
            <p className="font-mono text-[10px] uppercase tracking-wider text-slate">Ending</p>
            <p className="mt-1 text-sm leading-relaxed text-ink/90">{plan.endingAndCta}</p>
          </div>
        )}
      </div>

      {issues && issues.length > 0 && (
        <details className="mt-5 border-t border-rule pt-3">
          <summary className="cursor-pointer font-mono text-[11px] text-slate">
            {issues.length} adjustment{issues.length === 1 ? '' : 's'} made while validating the plan
          </summary>
          <ul className="mt-2 space-y-1 pl-3 text-xs leading-relaxed text-slate">
            {issues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        </details>
      )}

      {warnings && warnings.length > 0 && (
        <div className="mt-4 border-l-2 border-hot/70 pl-3">
          <p className="font-mono text-[10px] uppercase tracking-wider text-hot">Worth knowing</p>
          <ul className="mt-1 space-y-1 text-sm leading-relaxed text-ink/80">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
