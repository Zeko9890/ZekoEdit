# ZekoEdit

Raw footage in, a vertical short out — cut in the style of the creator whose reference videos you upload.

Local MVP. No accounts, no database, no cloud storage, no payments. The only thing that leaves your machine is the analysis material (sampled frames, short audio segments, your brief) sent to Google's Gemini API with **your** key.

```
one raw file ──┐
1–5 references ┴─▶ FFmpeg evidence ─▶ Gemini: style → moments → edit plan
                                              │
                          Zod schema + timestamp clamp
                                              │
                              FFmpeg: crop · concat · captions
                                              │
                                       1080×1920 mp4
```

---

## Prerequisites

Node 18.18 or newer. That is the whole list — FFmpeg ships as a binary dependency (`ffmpeg-static`, `ffprobe-static`), so you do not install FFmpeg yourself. If your platform build is missing or you prefer a system install, point `FFMPEG_PATH` and `FFPROBE_PATH` at your binaries instead.

```bash
npm install
npm run check:env     # verifies node, ffmpeg, ffprobe, libx264, aac, libass, writable data dir
npm run dev           # http://localhost:3000
```

`check:env` exists because FFmpeg problems are the most likely reason an edit fails. It exits non-zero and names the missing piece.

### Your Gemini key

Get one from [Google AI Studio](https://aistudio.google.com/apikey). Paste it into the **Your Gemini key** field.

- It is sent to the local Next.js server in the request body, held in server memory for the length of that one edit, and cleared when the edit finishes or fails.
- It is never written to disk, localStorage, a cookie, `.env`, or the job directory. It never appears in a response body or a log line; when the server logs a job it prints a truncated SHA-256 fingerprint instead (`job 4b1c… accepted — key 9f2c1a77de (gemini-2.5-flash)`).
- Anything the server prints goes through a redactor that strips `AIza…` shapes before logging.
- Usage is billed to your Google account under Gemini API pricing. ZekoEdit never proxies your request through another account and never falls back to a different provider.

Errors are mapped to plain language rather than provider stack traces: invalid key, quota exhausted / rate limited, model not available to this key, safety block, network failure. The key itself never appears in the message.

---

## Using it

1. **Raw footage** — one file (mp4/mov/m4v/webm/mkv/avi, up to 600 MB, up to 45 minutes).
2. **References** — 1–5 of *your own finished Shorts* (up to 200 MB each, up to 4 minutes each). These teach the style. Uploading zero works, but the app then says plainly that it has no style to follow.
3. **Purpose** — content type, objective, audience, duration (15/30/45/60 or custom 5–180s), platform, caption language, intensity, captions, effects, must-include, avoid, CTA, original-audio handling.
4. **Analyze & create short** — you get a stage-by-stage progress rail, then the style profile, the decision list with a reason per clip, and the rendered video.

### What the render actually does

- Each selected range is cut from the source with `-ss/-t`, reframed to 1080×1920 (crop window positioned by the AI's `focusX`/`focusY`, optional 1.0–1.6× punch-in), scaled with Lanczos, forced to 30fps, encoded H.264 `yuv420p` + AAC 48k stereo.
- Clips are joined with the concat demuxer (`-c copy`) — safe because every clip is normalised to identical stream parameters first.
- Captions are burned with libass from a generated `.ass` file, styled from your caption choice and the profile's measured colours. Emphasis words get a colour override. If your FFmpeg build lacks libass, the cut still renders and the caption step is skipped with a warning.
- Audio: `preserve` keeps the original; `reduce` drops it to 35%; `replace` uses only the uploaded track. A music bed is looped, trimmed and ducked under the voice. Audio is never replaced unless you ask for it.

---

## How the creator style is actually inferred

Gemini is given, for each reference: exact FFmpeg measurements (duration, detected shot-change times, measured average shot length, integrated loudness, silent stretches) and labelled frames at known timestamps. The model returns a structured profile where **every claim carries a confidence level**. FFmpeg's measured shot rhythm overrides the model's guess when they disagree by more than 2.5s, and the disagreement is recorded in the profile.

The profile states what it does not know in a "what this profile does not know" list. With one short reference most rows are marked *uncertain*, and the UI says so. Reference videos are finished edits: the profile reads visible patterns, and never claims to reconstruct the original timeline.

### What the footage analysis does and does not do

- **Does**: scene-cut detection, loudness, silence detection (dead air), labelled frame sampling for visual understanding, candidate moments ranked on hook/payoff/clarity/emotional-peak, clamped to the real duration.
- **Does not**: transcript. No speech-to-text engine is wired in this build, so dialogue is not transcribed and the analysis is told not to present guessed speech as a quote. The job surfaces a warning saying exactly this. This is the single biggest quality gap and the first thing to add (`whisper.cpp` or Gemini audio transcription) if you continue the project.

---

## Edit plans are data, not prose

The model returns JSON validated against Zod schemas (`lib/types.ts`), with a `responseSchema` sent to Gemini so structure is enforced at generation time too. Then `lib/plan.ts` repairs what it can and rejects what it cannot:

- extracts the JSON block from fences or prose, with balanced-brace scanning for truncation;
- coerces numeric strings and `"12.5s"` into numbers;
- flips reversed ranges, clamps every timestamp to the real media duration, extends sub-0.8s fragments, trims clips over 30s, drops clips with no material left;
- clamps `zoom` to 1–1.6, `focusX`/`focusY` to 0–1, transitions to the allowed set;
- drops empty or zero-length caption cues, shifts source-relative caption times onto clip-relative time, strips emphasis words not present in the cue text;
- removes exact duplicate ranges, caps at 10 clips, then fits the total to within +8% of your target duration;
- enforces your switches over the model: zooms off ⇒ `zoom = 1`, transitions off ⇒ `cut`, captions off ⇒ no cues.

If validation fails, one corrective retry includes the validation error. If that fails too, a deterministic planner ranks the analysed moments by your objective and labels the result as a fallback cut — the job never silently pretends the AI did it.

An `edit-plan.json` sidecar is written next to the video with the brief, profile, analysis, plan, rationale, every repair, and the rendered facts, and is downloadable from the result card.

---

## Layout

```
app/
  page.tsx                     editor: key, files, brief, preview, results
  layout.tsx, globals.css      type, palette
  api/jobs/route.ts            POST multipart → job id (202), starts pipeline
  api/jobs/[id]/route.ts       GET job state (polled)
  api/jobs/[id]/media/[kind]/  stream video or plan JSON, with Range support
  api/health/route.ts          FFmpeg/toolchain report, cached 30s
components/                    progress rail, style profile, edit plan, preview
lib/
  types.ts                     Zod schemas + shared types (the contract)
  ai/provider.ts               one provider interface — add OpenAI/Claude here
  ai/gemini.ts                 Gemini implementation (the only SDK import)
  prompts.ts                   the three prompts
  evidence.ts                  frames, downmixed audio, shot changes, loudness
  plan.ts                      JSON extraction, clamping, repair, fallback
  render.ts                    clip normalise → concat → music → captions
  captions.ts                  ASS generation and caption theme
  ffmpeg.ts                    binary resolution + spawn wrapper
  pipeline.ts                  orchestration and progress
  jobs.ts                      in-memory job store, rate limit
  health.ts, env.ts, errors.ts, format.ts, fixtures.ts
scripts/check-env.mjs
```

Swapping providers means implementing `AIProvider` in `lib/ai/` and choosing it in `app/api/jobs/route.ts`; the pipeline and renderer do not know which model ran.

---

## Limits (deliberate, for a local MVP)

| Thing | Value |
| --- | --- |
| Raw footage | 600 MB, 45 min |
| Each reference | 200 MB, 4 min |
| References | 5 |
| Clips per edit | 10 |
| Clip length | 0.8–30 s |
| Output | 1080×1920, 30fps, H.264/AAC |
| Jobs in memory | 12, 6 new per minute |
| Job lifetime | in memory + `data/jobs/<id>/` on disk until you delete it |

Reference/raw *duration* limits are enforced by `LIMITS` (`lib/env.ts`) and reported as warnings, not silently ignored. Jobs are lost on restart; the rendered files remain under `data/jobs/`.

---

## Honest status of this build

Written and checked by reading: every file above compiles by inspection against the type contracts, and the pipelines are wired end to end.

**Not executed in the session that wrote it.** The agent's sandbox failed to start (`VM_DISK_SPACE_INSUFFICIENT`), so `npm install`, `next build`, and an actual FFmpeg render could not be run. Treat the first run as the test run. The intended verification order, cheapest first:

1. `npm run check:env` — proves FFmpeg, libx264, aac, libass, writable dir.
2. `npm run dev`, load `/api/health` — should report `ok: true`.
3. Validate the plan repair logic with `lib/fixtures.ts`: `rawPlanFixture` is deliberately broken (reversed range, timestamp past the end of the media, out-of-range zoom, unbounded caption). Run `runFixture(60)` and check the clipped values and the issue list.
4. End-to-end with a real key: a 30–60s gaming clip as raw footage plus one or two of your Shorts as references. Watch that the progress rail advances and that the plan's timestamps fall inside your file.
5. `ffprobe -v error -show_streams data/jobs/<id>/output.mp4` — expect one H.264 1080×1920 stream and one AAC stereo stream. ffprobe ships with the repo's dependencies.

Known risks to check on first run: the `@google/genai` call signature (`models.generateContent` with `config.responseSchema` / `thinkingConfig`) is pinned to `^1.2.0` and is the most likely place for an SDK drift error; and the first Gemini request after a cold start can be slow as the binary and model warm up.

## Not built (on purpose)

Auth, database, cloud rendering, payments, multi-provider routing, speech-to-text, animated caption karaoke timing, true whip/flash transitions (the schema accepts the names; `cut` and `fade` are rendered, the others fall back to `cut`), per-word caption sync from a transcript, and background job persistence.
