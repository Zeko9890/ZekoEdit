/**
 * A fixture edit plan used to exercise validation and rendering without spending
 * API credits. Import it in a debug route, or copy it into the prompt output.
 */
import { repairPlan, timelineFromPlan } from '@/lib/plan';
import { creatorBriefSchema } from '@/lib/types';

const brief = creatorBriefSchema.parse({
  contentType: 'gaming_highlight',
  objective: 'entertain',
  audience: 'competitive shooter fans on a phone',
  targetDuration: 30,
  platform: 'youtube_shorts',
  captionStyle: 'clean',
  effects: { zooms: true, transitions: false, soundEffects: false, memes: false, music: false },
  audioMode: 'preserve',
});

/** Deliberately broken on purpose: reversed times, an impossible timestamp, a bad caption. */
export const rawPlanFixture = {
  rationale: ['Fixture plan for testing the validator.'],
  plan: {
    title: 'Fixture cut',
    hookText: 'opening frame',
    targetDuration: 30,
    endingAndCta: 'thanks for watching',
    styleDecisions: ['straight cuts'],
    clips: [
      {
        order: 1,
        sourceStart: '12.0',
        sourceEnd: '5.0', // reversed — the validator must flip it
        role: 'hook',
        reason: 'Fixture hook.',
        zoom: 9, // out of range — must clamp to 1.6
        transitionIn: 'cut',
        captions: [{ text: 'this should be clamped', start: 0, end: 900 }],
      },
      {
        order: 2,
        sourceStart: 9999, // beyond the media — must be clamped or dropped
        sourceEnd: 10005,
        role: 'payoff',
        reason: 'Impossible timestamp.',
        captions: [],
      },
      {
        order: 3,
        sourceStart: 20,
        sourceEnd: 30,
        role: 'cta',
        reason: 'Fixture ending.',
        captions: [{ text: '', start: 0, end: 1 }], // empty text — must be dropped
      },
    ],
  },
};

export function runFixture(sourceDuration = 60): void {
  const result = repairPlan(rawPlanFixture, { sourceDuration, brief });
  const timeline = timelineFromPlan(result.plan);
  console.log('issues:', result.issues);
  console.log('warnings:', result.warnings);
  console.log('clips:', result.plan.clips.map((c) => [c.sourceStart, c.sourceEnd, c.zoom]));
  console.log('total:', timeline.total);
}

export { brief as fixtureBrief };
