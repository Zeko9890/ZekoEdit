import type { StyleProfile } from '@/lib/types';

const confidenceCopy: Record<string, { label: string; className: string }> = {
  high: { label: 'measured', className: 'text-cut' },
  medium: { label: 'inferred', className: 'text-ink/70' },
  low: { label: 'uncertain', className: 'text-hot' },
};

function Chip({ confidence }: { confidence: string }) {
  const meta = confidenceCopy[confidence] ?? confidenceCopy.low;
  return <span className={`font-mono text-[10px] uppercase tracking-wider ${meta.className}`}>{meta.label}</span>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[130px_1fr] gap-3 border-b border-rule/60 py-2.5 last:border-b-0">
      <dt className="font-mono text-[11px] uppercase tracking-wider text-slate">{label}</dt>
      <dd className="text-sm leading-relaxed text-ink">{children}</dd>
    </div>
  );
}

export default function StyleProfileCard({ profile }: { profile: StyleProfile }) {
  const measured = profile.evidence.measuredAverageShotSeconds;
  const modelSays = profile.averageShotSeconds.value;

  return (
    <section aria-labelledby="style-heading" className="animate-rise">
      <div className="flex items-baseline justify-between gap-4">
        <h3 id="style-heading" className="font-display text-2xl">
          Your style, as read from the references
        </h3>
        <span className="font-mono text-[11px] text-slate">
          {profile.evidence.referenceCount} ref · {profile.evidence.framesSampled} frames
        </span>
      </div>

      <p className="mt-2 max-w-[62ch] text-[15px] leading-relaxed text-ink/90">{profile.summary}</p>

      {profile.uncertain.length > 0 && (
        <div className="mt-4 border-l-2 border-hot/60 pl-3">
          <p className="font-mono text-[10px] uppercase tracking-wider text-hot">What this profile does not know</p>
          <ul className="mt-1 space-y-1 text-sm leading-relaxed text-slate">
            {profile.uncertain.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      <dl className="mt-4">
        <Row label="Shot rhythm">
          <span className="font-mono">{modelSays}s</span> average shot <Chip confidence={profile.averageShotSeconds.confidence} />
          {measured !== null && (
            <>
              {' '}
              <span className="text-slate">(FFmpeg measured {measured}s across the references)</span>
            </>
          )}
        </Row>
        <Row label="Hook">
          {profile.hookStructure.value} <Chip confidence={profile.hookStructure.confidence} />
        </Row>
        <Row label="Captions">
          {profile.captions.present ? (
            <>
              {profile.captions.position}; {profile.captions.sizeAndWeight}; {profile.captions.colors}.{' '}
              Emphasis: {profile.captions.emphasis}.{' '}
              <span className="text-slate">{profile.captions.animation}</span> <Chip confidence={profile.captions.confidence} />
            </>
          ) : (
            <>
              None seen in the sampled frames. <Chip confidence={profile.captions.confidence} />
            </>
          )}
        </Row>
        <Row label="Zooms">
          {profile.zooms.value} <Chip confidence={profile.zooms.confidence} />
        </Row>
        <Row label="Transitions">
          {profile.transitions.value} <Chip confidence={profile.transitions.confidence} />
        </Row>
        <Row label="Humor">
          {profile.humorAndMemes.value} <Chip confidence={profile.humorAndMemes.confidence} />
        </Row>
        <Row label="Sound">
          {profile.soundAndMusic.value} <Chip confidence={profile.soundAndMusic.confidence} />
        </Row>
        <Row label="Layout">{profile.layoutNotes.value}</Row>
        <Row label="Story">{profile.storytelling.value}</Row>
        <Row label="Energy">{profile.energy.value}</Row>
        {profile.consistentElements.length > 0 && (
          <Row label="Always there">
            <ul className="space-y-0.5">
              {profile.consistentElements.map((el) => (
                <li key={el}>{el}</li>
              ))}
            </ul>
          </Row>
        )}
      </dl>

      <p className="mt-3 text-xs leading-relaxed text-slate">
        Reference videos are finished edits — this reads visible patterns, not the original timeline. Treat
        &ldquo;uncertain&rdquo; rows as hypotheses.
      </p>
    </section>
  );
}
