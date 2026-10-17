import type { Candidate, CreatorBrief, StyleProfile } from './types';
import type { VideoEvidence } from './evidence';

export const SYSTEM_RULES = `You are the editing brain of ZekoEdit, a tool that cuts raw footage into short vertical videos in the style of a specific creator.

Non-negotiable rules:
- Never invent dialogue, events, or timestamps. Frames are labelled with their real timestamps; if something is not visible in a frame or measurable in the provided FFmpeg data, say you are unsure or leave it out.
- Frames are sampled, not continuous. An event between two frames may be invisible. Mark that as uncertainty rather than filling the gap.
- No speech-to-text transcript is provided unless stated. Do not present guessed dialogue as a quote.
- Every claim about the creator's style must be tied to the reference material you were given. If there is only one short reference, say confidence is low.
- Follow the creator's explicit switches (zooms, transitions, effects, captions, audio) over what you think would look cool. If a switch is off, do not use that technique at all.
- Prefer clarity over cleverness: a viewer should understand what is happening without having seen the raw footage.
- Return only the JSON requested. No commentary, no markdown fences.`;

function briefBlock(brief: CreatorBrief): string {
  const contentType = brief.contentType === 'custom' ? brief.customContentType || 'custom' : brief.contentType;
  const lines = [
    `Content type: ${contentType.replace(/_/g, ' ')}`,
    `Primary objective: ${brief.objective.replace(/_/g, ' ')}`,
    `Target audience: ${brief.audience}`,
    `Target duration: ${brief.targetDuration} seconds (hard ceiling, overshoot by no more than 8%)`,
    `Platform: ${brief.platform.replace(/_/g, ' ')} — vertical 1080x1920`,
    `Language of on-screen captions: ${brief.language === 'original' ? 'same language as the footage' : brief.language}`,
    `Editing intensity: ${brief.intensity}`,
    `Caption style: ${brief.captionStyle}`,
    `Original audio: ${brief.audioMode}`,
    `Effects allowed — zooms/punch-ins: ${brief.effects.zooms ? 'yes' : 'NO'}, transitions: ${
      brief.effects.transitions ? 'yes' : 'NO'
    }, sound effects: ${brief.effects.soundEffects ? 'yes' : 'NO'}, memes: ${brief.effects.memes ? 'yes' : 'NO'}, background music: ${
      brief.effects.music ? 'yes' : 'NO'
    }`,
  ];
  if (brief.mustInclude?.trim()) lines.push(`Must include: ${brief.mustInclude.trim()}`);
  if (brief.avoid?.trim()) lines.push(`Must avoid: ${brief.avoid.trim()}`);
  if (brief.callToAction?.trim()) lines.push(`Call to action: ${brief.callToAction.trim()}`);
  return lines.join('\n');
}

function styleBlock(style: StyleProfile): string {
  return [
    `Style summary: ${style.summary}`,
    `Hook structure: ${style.hookStructure.value} (${style.hookStructure.confidence})`,
    `Average shot length: ${style.averageShotSeconds.value}s (${style.averageShotSeconds.confidence})`,
    `Captions: present=${style.captions.present}; position=${style.captions.position}; size=${style.captions.sizeAndWeight}; colors=${style.captions.colors}; emphasis=${style.captions.emphasis}; animation=${style.captions.animation} (${style.captions.confidence})`,
    `Zooms: ${style.zooms.value}`,
    `Transitions: ${style.transitions.value}`,
    `Humor/memes: ${style.humorAndMemes.value}`,
    `Sound/music: ${style.soundAndMusic.value}`,
    `Layout: ${style.layoutNotes.value}`,
    `Storytelling: ${style.storytelling.value}`,
    `Energy: ${style.energy.value}`,
    style.consistentElements.length ? `Consistent elements: ${style.consistentElements.join('; ')}` : '',
    style.uncertain.length ? `Uncertain observations (do not treat as fact): ${style.uncertain.join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/* --------------------------------- Style ---------------------------------- */

export function buildStylePrompt(referenceCount: number): string {
  return `You are analysing ${referenceCount} reference video${referenceCount === 1 ? '' : 's'} that the creator edited themselves. Build a reusable style profile for this creator.

What you receive: FFmpeg measurements (exact duration, shot-change times, measured average shot length, loudness, silent stretches) plus labelled frames at known timestamps. You do NOT receive the original edit timeline or project files — these are finished edits, so describe visible style patterns, never claim to reproduce their timeline.

Answer with this JSON object and nothing else:
{
  "summary": "2-4 sentences in plain language describing how this creator edits",
  "hookStructure": { "value": "...", "confidence": "high|medium|low" },
  "averageShotSeconds": { "value": number, "confidence": "high|medium|low" },
  "captions": { "present": bool, "position": "...", "sizeAndWeight": "...", "colors": "...", "emphasis": "...", "animation": "...", "confidence": "high|medium|low" },
  "captionPrimaryColorHex": "#RRGGBB only if you can see a clear dominant caption colour, otherwise omit",
  "zooms": { "value": "...", "confidence": "high|medium|low" },
  "transitions": { "value": "...", "confidence": "high|medium|low" },
  "humorAndMemes": { "value": "...", "confidence": "high|medium|low" },
  "soundAndMusic": { "value": "...", "confidence": "high|medium|low" },
  "layoutNotes": { "value": "facecam/gameplay arrangement, safe areas used or ignored", "confidence": "high|medium|low" },
  "storytelling": { "value": "how tension is built and paid off", "confidence": "high|medium|low" },
  "energy": { "value": "...", "confidence": "high|medium|low" },
  "consistentElements": ["things that appear in every reference"],
  "uncertain": ["things you could not determine from frames + measurements"]
}

Confidence rules: use "low" whenever you are inferring rather than seeing. With one short reference, most observations are low confidence. If captions are absent from the frames, set present=false and confidence=high only if you checked several frames. Do not guess colour hex values you cannot see.`;
}

/* ------------------------------ Raw footage ------------------------------- */

export function buildRawAnalysisPrompt(input: {
  brief: CreatorBrief;
  style: StyleProfile;
  source: VideoEvidence;
}): string {
  const { brief, style, source } = input;
  const gamingHint =
    brief.contentType === 'gaming_highlight'
      ? `This is gaming footage. Prioritise clutch plays, funny failures, wins, unexpected outcomes, live reactions and outcomes that a viewer can follow without context. Respect that a fight or attempt needs its setup AND its result to be watchable.`
      : `Prioritise moments that serve the stated objective.`;

  return `Find the best moments in this raw footage for a ${brief.targetDuration}-second vertical cut.

CREATOR BRIEF
${briefBlock(brief)}

CREATOR STYLE PROFILE
${styleBlock(style)}

FOOTAGE
${gamingHint}
Duration: ${source.duration.toFixed(2)}s. Shot changes detected by FFmpeg at: ${
    source.sceneCuts.length ? source.sceneCuts.slice(0, 40).join(', ') + 's' : 'none detected'
  }.
Silent stretches (dead air): ${
    source.loudness.silenceRegions.length
      ? source.loudness.silenceRegions.slice(0, 12).map((r) => `${r.start}-${r.end}s`).join(', ')
      : 'none detected above 1.1s'
  }.
Audio stream: ${source.hasAudio ? 'present, downmixed to mono for you' : 'absent — this is a silent video'}.

Return JSON:
{
  "overallDescription": "what happens in this footage overall",
  "candidates": [
    {
      "start": number, "end": number,
      "label": "short name for the moment",
      "transcript": "only words you actually heard/read; empty string if none",
      "why": "why this could work for the objective, in plain language",
      "signals": ["e.g. score change, on-screen reaction, sudden movement"],
      "hookPotential": 0-100, "payoff": 0-100, "clarity": 0-100, "emotionalPeak": 0-100
    }
  ],
  "bestEndingCandidates": [index into candidates],
  "uncertainties": ["what you could not verify from sampled frames"]
}

Rules for candidates:
- 6 to 14 candidates, each between 2 and 30 seconds.
- Start each candidate before the action so the viewer has context; do not start mid-action unless that is clearly this creator's style.
- End after the payoff or reaction, not before it.
- Never claim an event at a timestamp that is not supported by a labelled frame or by FFmpeg measurements. If you are inferring, say so in "signals" or "uncertainties".
- If dialogue matters but there is no transcript, mark clarity lower rather than inventing words.`;
}

/* --------------------------------- Plan ----------------------------------- */

export function buildPlanPrompt(input: {
  brief: CreatorBrief;
  style: StyleProfile;
  candidates: Candidate[];
  sourceDuration: number;
}): string {
  const { brief, style, candidates, sourceDuration } = input;

  const candidateLines = candidates
    .map(
      (c, i) =>
        `${i + 1}. ${c.start.toFixed(2)}s → ${c.end.toFixed(2)}s (${(c.end - c.start).toFixed(1)}s) · ${c.label}\n   why: ${c.why}\n   transcript: "${
          c.transcript || '(none available)'
        }"\n   hook ${c.hookPotential} / payoff ${c.payoff} / clarity ${c.clarity} / peak ${c.emotionalPeak}`,
    )
    .join('\n');

  const captionRules =
    brief.captionStyle === 'off'
      ? 'Captions are OFF. Return an empty captions array for every clip.'
      : `Caption style: ${brief.captionStyle}. Write short caption cues in ${brief.language === 'original' ? 'the footage language' : brief.language}, max 7 words per cue, timed relative to the START of each clip (0 = clip start), never longer than the clip.`;

  return `Turn these candidate moments into a final edit decision list.

CREATOR BRIEF
${briefBlock(brief)}

CREATOR STYLE
${styleBlock(style)}

FOOTAGE LENGTH
${sourceDuration.toFixed(2)}s total. No timestamp may exceed this.

CANDIDATE MOMENTS (already analysed; you may trim their edges but must stay inside the footage)
${candidateLines}

Return JSON in exactly this shape:
{
  "rationale": ["3-6 plain-language sentences explaining the choices for the creator"],
  "plan": {
    "title": "internal title for this cut",
    "hookText": "the first line/frame idea, or empty string",
    "targetDuration": ${brief.targetDuration},
    "endingAndCta": "how it ends; include the CTA if one was given, otherwise empty string",
    "styleDecisions": ["style choices taken from the profile, each tied to a reason"],
    "clips": [
      {
        "order": 1,
        "sourceStart": number,
        "sourceEnd": number,
        "role": "hook|build|payoff|cta|bridge",
        "reason": "why this clip earns its place",
        "focusX": 0.0-1.0,
        "focusY": 0.0-1.0,
        "zoom": 1.0-1.6,
        "transitionIn": "cut|fade|whip|flash",
        "captions": [{ "text": "short cue", "start": 0.0, "end": 1.8, "emphasis": ["one strong word"] }]
      }
    ]
  }
}

Hard constraints:
- Total clip duration must land within 8% of ${brief.targetDuration}s. Fewer, stronger clips beat padding.
- Maximum 10 clips, minimum 1. Each clip 0.8-30s.
- The first clip is the hook and must be understandable in its first second.
- focusX/focusY is where to centre the vertical crop (0.5,0.5 = centre). Put the subject in frame; do not crop off a face or a scoreboard that matters.
- ${brief.effects.zooms ? 'Punch-in zooms are allowed sparingly (1.0-1.6); use 1.0 where they add nothing.' : 'Zooms are disabled: set "zoom": 1 for every clip.'}
- ${
    brief.effects.transitions
      ? 'Transitions may be used where they fit the style; default to "cut".'
      : 'Transitions are disabled: set "transitionIn": "cut" for every clip.'
  }
- ${captionRules}
- ${brief.effects.memes ? 'Meme/sound-effect cues are allowed and may be noted in the clip reason.' : 'Do not add meme or sound-effect cues — those switches are off.'}
- If a candidate contradicts the creator's "must avoid" list, do not use it.
- Do not invent clips that are not supported by the candidates.`;
}
