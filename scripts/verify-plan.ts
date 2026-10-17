/**
 * Executable checks for the safety-critical half of the app: turning an
 * untrusted AI edit plan into something the renderer can trust.
 *
 *   npm run verify:plan
 *
 * No API key and no network needed — this only exercises lib/plan.ts,
 * lib/captions.ts and the Zod schemas.
 */
import assert from 'node:assert/strict';
import { clamp, extractJsonBlock, repairPlan, timelineFromPlan } from '@/lib/plan';
import { buildAss, themeFromStyle } from '@/lib/captions';
import { creatorBriefSchema, MAX_CLIP_SECONDS, MIN_CLIP_SECONDS } from '@/lib/types';

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message.split('\n').slice(0, 3).join('\n        ')}`);
  }
}

const brief = creatorBriefSchema.parse({
  contentType: 'gaming_highlight',
  objective: 'entertain',
  audience: 'competitive shooter fans on a phone',
  targetDuration: 30,
  platform: 'youtube_shorts',
  captionStyle: 'clean',
  intensity: 'balanced',
  effects: { zooms: true, transitions: false, soundEffects: false, memes: false, music: false },
  audioMode: 'preserve',
});

console.log('\nPlan repair\n');

test('extracts JSON from a fenced block', () => {
  const parsed = extractJsonBlock('```json\n{"a":1}\n```') as { a: number };
  assert.equal(parsed.a, 1);
});

test('extracts JSON surrounded by prose with braces in strings', () => {
  const parsed = extractJsonBlock('Here you go: {"text":"a } brace","n":2} hope that helps') as {
    text: string;
    n: number;
  };
  assert.equal(parsed.n, 2);
  assert.equal(parsed.text, 'a } brace');
});

test('rejects truncated JSON instead of guessing', () => {
  assert.throws(() => extractJsonBlock('{"clips":[{"start":1,'), /truncated/i);
});

test('flips a reversed clip instead of dropping it', () => {
  const { plan, issues } = repairPlan(
    { clips: [{ order: 1, sourceStart: 20, sourceEnd: 12, role: 'hook', reason: 'test', captions: [] }] },
    { sourceDuration: 60, brief },
  );
  assert.equal(plan.clips.length, 1);
  assert.ok(plan.clips[0].sourceStart < plan.clips[0].sourceEnd);
  assert.ok(issues.some((i) => /reverse/i.test(i)));
});

test('clamps a timestamp beyond the media duration', () => {
  const { plan } = repairPlan(
    { clips: [{ order: 1, sourceStart: 500, sourceEnd: 520, role: 'hook', reason: 'past the end', captions: [] }] },
    { sourceDuration: 40, brief },
  );
  for (const clip of plan.clips) {
    assert.ok(clip.sourceEnd <= 40.001, `clip ended at ${clip.sourceEnd}`);
    assert.ok(clip.sourceStart >= 0);
  }
});

test('never returns a clip shorter than the minimum', () => {
  const { plan } = repairPlan(
    { clips: [{ order: 1, sourceStart: 10, sourceEnd: 10.1, role: 'hook', reason: 'tiny', captions: [] }] },
    { sourceDuration: 60, brief },
  );
  assert.ok(plan.clips[0].sourceEnd - plan.clips[0].sourceStart >= MIN_CLIP_SECONDS - 0.001);
});

test('trims a clip longer than the maximum', () => {
  const { plan } = repairPlan(
    { clips: [{ order: 1, sourceStart: 0, sourceEnd: 50, role: 'hook', reason: 'long', captions: [] }] },
    { sourceDuration: 60, brief },
  );
  assert.ok(plan.clips[0].sourceEnd - plan.clips[0].sourceStart <= MAX_CLIP_SECONDS + 0.001);
});

test('clamps zoom and focus into range, and strips transitions when disabled', () => {
  const { plan } = repairPlan(
    {
      clips: [
        {
          order: 1,
          sourceStart: 5,
          sourceEnd: 15,
          role: 'hook',
          reason: 'wild values',
          zoom: 9,
          focusX: -4,
          focusY: 12,
          transitionIn: 'flash',
          captions: [],
        },
      ],
    },
    { sourceDuration: 60, brief },
  );
  const clip = plan.clips[0];
  assert.equal(clip.zoom, 1.6);
  assert.equal(clip.focusX, 0);
  assert.equal(clip.focusY, 1);
  assert.equal(clip.transitionIn, 'cut', 'transitions were switched off in the brief');
});

test('drops empty caption cues and clamps cue times to the clip', () => {
  const { plan } = repairPlan(
    {
      clips: [
        {
          order: 1,
          sourceStart: 5,
          sourceEnd: 15,
          role: 'hook',
          reason: 'cues',
          captions: [
            { text: '', start: 0, end: 1 },
            { text: 'keep me', start: 0, end: 900 },
          ],
        },
      ],
    },
    { sourceDuration: 60, brief },
  );
  const cues = plan.clips[0].captions;
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'keep me');
  assert.ok(cues[0].end <= 10.001, `cue ended at ${cues[0].end}`);
});

test('removes emphasis words that are not in the cue text', () => {
  const { plan } = repairPlan(
    {
      clips: [
        {
          order: 1,
          sourceStart: 0,
          sourceEnd: 10,
          role: 'hook',
          reason: 'emphasis',
          captions: [{ text: 'clutch play', start: 0, end: 2, emphasis: ['CLUTCH', 'nonsense'] }],
        },
      ],
    },
    { sourceDuration: 60, brief },
  );
  assert.deepEqual(plan.clips[0].captions[0].emphasis, ['CLUTCH']);
});

test('captions off in the brief removes every cue', () => {
  const noCaptions = { ...brief, captionStyle: 'off' as const };
  const { plan } = repairPlan(
    {
      clips: [
        {
          order: 1,
          sourceStart: 0,
          sourceEnd: 10,
          role: 'hook',
          reason: 'c',
          captions: [{ text: 'should vanish', start: 0, end: 2 }],
        },
      ],
    },
    { sourceDuration: 60, brief: noCaptions },
  );
  assert.equal(plan.clips[0].captions.length, 0);
});

test('coerces numeric strings and "12.5s" style values', () => {
  const { plan } = repairPlan(
    { clips: [{ order: '1', sourceStart: '3.5', sourceEnd: '12.5s', role: 'hook', reason: 'strings', captions: [] }] },
    { sourceDuration: 60, brief },
  );
  assert.equal(plan.clips[0].sourceStart, 3.5);
  assert.equal(plan.clips[0].sourceEnd, 12.5);
});

test('total duration lands within 8% of the target, or warns', () => {
  const clips = Array.from({ length: 8 }, (_, i) => ({
    order: i + 1,
    sourceStart: i * 10,
    sourceEnd: i * 10 + 9,
    role: i === 0 ? 'hook' : 'build',
    reason: 'filler',
    captions: [],
  }));
  const { plan } = repairPlan({ clips }, { sourceDuration: 300, brief });
  const total = timelineFromPlan(plan).total;
  assert.ok(total <= brief.targetDuration * 1.08 + 0.001, `total ${total} exceeded the ceiling`);
});

test('applies an 8% ceiling even when the model overruns badly', () => {
  const clips = [
    { order: 1, sourceStart: 0, sourceEnd: 30, role: 'hook', reason: 'a', captions: [] },
    { order: 2, sourceStart: 30, sourceEnd: 60, role: 'build', reason: 'b', captions: [] },
    { order: 3, sourceStart: 60, sourceEnd: 90, role: 'payoff', reason: 'c', captions: [] },
  ];
  const { plan } = repairPlan({ clips }, { sourceDuration: 120, brief });
  const total = timelineFromPlan(plan).total;
  assert.ok(total <= brief.targetDuration * 1.08 + 0.001, `total ${total} exceeded ${brief.targetDuration * 1.08}`);
});

test('throws when the plan has no usable clips', () => {
  assert.throws(() => repairPlan({ clips: [] }, { sourceDuration: 60, brief }), /no clips/i);
});

test('drops exact duplicate ranges', () => {
  const { plan } = repairPlan(
    {
      clips: [
        { order: 1, sourceStart: 2, sourceEnd: 8, role: 'hook', reason: 'a', captions: [] },
        { order: 2, sourceStart: 2, sourceEnd: 8, role: 'build', reason: 'b', captions: [] },
      ],
    },
    { sourceDuration: 60, brief },
  );
  assert.equal(plan.clips.length, 1);
});

test('clamp handles NaN and infinities', () => {
  assert.equal(clamp(Number.NaN, 0, 1), 0);
  assert.equal(clamp(Infinity, 0, 1), 1);
  assert.equal(clamp(-Infinity, 0, 1), 0);
});

console.log('\nCaptions\n');

test('builds ASS with real clip-relative timing on the output timeline', () => {
  const { plan } = repairPlan(
    {
      clips: [
        {
          order: 1,
          sourceStart: 10,
          sourceEnd: 20,
          role: 'hook',
          reason: 'a',
          captions: [{ text: 'first', start: 0, end: 2 }],
        },
        {
          order: 2,
          sourceStart: 40,
          sourceEnd: 50,
          role: 'build',
          reason: 'b',
          captions: [{ text: 'second', start: 0, end: 2 }],
        },
      ],
    },
    { sourceDuration: 60, brief },
  );
  const { entries } = timelineFromPlan(plan);
  const theme = themeFromStyle(brief, undefined, undefined);
  const { ass, cueCount } = buildAss(plan, entries, theme);

  assert.equal(cueCount, 2);
  assert.match(ass, /\[V4\+ Styles\]/);
  // The second clip starts at 10s in the output, so its cue starts at 0:00:10.
  assert.match(ass, /Dialogue: 0,0:00:10\.00,0:00:12\.00,Caption/);
  assert.match(ass, /0:00:00\.00,0:00:02\.00,Caption/);
});

test('escapes braces so a caption cannot inject ASS override tags', () => {
  const { plan } = repairPlan(
    {
      clips: [
        {
          order: 1,
          sourceStart: 0,
          sourceEnd: 10,
          role: 'hook',
          reason: 'injection',
          captions: [{ text: '{\\an8}spoofed', start: 0, end: 2 }],
        },
      ],
    },
    { sourceDuration: 60, brief },
  );
  const { entries } = timelineFromPlan(plan);
  const { ass } = buildAss(plan, entries, themeFromStyle(brief, undefined, undefined));
  assert.ok(!ass.includes('{\\an8}spoofed'), 'unescaped override tag reached the ASS file');
});

test('a hex caption colour from the profile is used, an invalid one is ignored', () => {
  const good = themeFromStyle(brief, undefined, '#FF3355');
  const bad = themeFromStyle(brief, undefined, 'bright yellow-ish');
  // ASS is AABBGGRR: #FF3355 → &H005533FF
  assert.equal(good.primary, '&H005533FF');
  assert.equal(bad.primary, '&H00FFFFFF');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\nFailed:');
  for (const name of failures) console.log(`  · ${name}`);
  process.exit(1);
}
console.log('');
