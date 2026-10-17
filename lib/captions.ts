import type { EditPlan, StyleProfile, CreatorBrief } from './types';
import type { TimelineEntry } from './plan';

/**
 * Captions are burned with libass via an ASS subtitle file. We keep the styling
 * here, in one place, so the render step stays dumb.
 */

export interface CaptionTheme {
  fontName: string;
  fontSize: number;
  primary: string; // &HAABBGGRR
  outline: string;
  back: string;
  bold: boolean;
  uppercase: boolean;
  marginVMid: number; // vertical placement on the 1080x1920 canvas
  alignment: number; // 2 = bottom-centre
  outlined: boolean;
  boxed: boolean;
  emphasisPrimary: string;
}

function hexToAss(hex: string): string {
  const clean = hex.replace('#', '');
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

function isHex(value: unknown): value is string {
  return typeof value === 'string' && /^#?[0-9a-fA-F]{6}$/.test(value);
}

/**
 * Derive a theme from the creator's own choice plus whatever the style profile
 * reported. Colours in the profile are free text (models describe them as
 * "white with thick black outline"), so we only honour them when the model
 * actually returned a hex value; otherwise the preset for the chosen caption
 * style applies. This avoids inventing colour data.
 */
export function themeFromStyle(
  brief: CreatorBrief,
  profile: StyleProfile | undefined,
  styleColorsHex: string | undefined,
): CaptionTheme {
  const energetic = brief.intensity === 'energetic';

  const base: CaptionTheme = {
    fontName: 'Arial',
    fontSize: 92,
    primary: hexToAss('#FFFFFF'),
    outline: hexToAss('#000000'),
    back: hexToAss('#000000'),
    bold: true,
    uppercase: false,
    marginVMid: 470,
    alignment: 2,
    outlined: true,
    boxed: false,
    emphasisPrimary: hexToAss('#FFD400'),
  };

  if (brief.captionStyle === 'clean') {
    base.fontSize = 76;
    base.outlined = true;
    base.uppercase = false;
    base.marginVMid = 440;
  }

  if (brief.captionStyle === 'creator_animated') {
    base.fontSize = energetic ? 104 : 88;
    base.uppercase = energetic;
    base.marginVMid = 500;
    base.emphasisPrimary = hexToAss('#FFD400');
  }

  if (isHex(styleColorsHex)) {
    base.primary = hexToAss(styleColorsHex.startsWith('#') ? styleColorsHex : `#${styleColorsHex}`);
  } else if (profile?.captions.present && brief.captionStyle !== 'clean') {
    // The model saw captions in every reference. Keep the punchy preset, but the
    // UI says the exact colours were inferred, not measured.
    base.fontSize = Math.min(112, base.fontSize + 4);
  }

  return base;
}

function toAssTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const cs = Math.round((clamped - Math.floor(clamped)) * 100);
  const csClamped = cs === 100 ? 99 : cs;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(csClamped).padStart(2, '0')}`;
}

function escapeAss(text: string): string {
  // Braces would be read as override tags; backslashes as escapes.
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\r?\n/g, ' ');
}

/** Wrap emphasis words in a colour override so they pop without changing the layout. */
function applyEmphasis(text: string, words: string[], theme: CaptionTheme): string {
  let out = escapeAss(text);
  const safeWords = words
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && w.length < 30)
    .sort((a, b) => b.length - a.length);
  for (const word of safeWords) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(${escaped})`, 'gi');
    out = out.replace(re, `{\\c${theme.emphasisPrimary}\\b1}$1{\\c${theme.primary}\\b${theme.bold ? 1 : 0}}`);
  }
  return out;
}

function splitIntoReadableChunks(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (`${current} ${word}`.length <= maxChars) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  // Two lines max per cue keeps it readable on a phone.
  if (lines.length <= 2) return lines;
  return [lines.slice(0, 2).join(' '), lines.slice(2, 4).join(' ')].filter(Boolean);
}

export interface AssBuildResult {
  ass: string;
  cueCount: number;
}

export function buildAss(
  plan: EditPlan,
  entries: TimelineEntry[],
  theme: CaptionTheme,
): AssBuildResult {
  const styles = [
    `[Script Info]`,
    `ScriptType: v4.00+`,
    `PlayResX: 1080`,
    `PlayResY: 1920`,
    `WrapStyle: 2`,
    `ScaledBorderAndShadow: yes`,
    ``,
    `[V4+ Styles]`,
    `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding`,
    // BorderStyle 1 = outline+shadow. Heavy outline keeps text legible over gameplay.
    `Style: Caption,${theme.fontName},${theme.fontSize},${theme.primary},${theme.emphasisPrimary},${theme.outline},${theme.back},${theme.bold ? -1 : 0},0,0,0,100,100,0,0,1,7,2,${theme.alignment},80,80,${theme.marginVMid},1`,
    ``,
    `[Events]`,
    `Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`,
  ];

  const events: string[] = [];
  let cueCount = 0;

  for (const entry of entries) {
    for (const cue of entry.clip.captions) {
      const start = entry.outputStart + cue.start;
      const end = entry.outputStart + Math.min(cue.end, entry.length);
      if (end - start < 0.15) continue;

      const text = theme.uppercase ? cue.text.toUpperCase() : cue.text;
      const chunks = splitIntoReadableChunks(text, 26);
      const perChunk = (end - start) / Math.max(1, chunks.length);

      chunks.forEach((chunk, i) => {
        const chunkStart = start + i * perChunk;
        const chunkEnd = chunkStart + perChunk;
        // A small pop-in scale when the creator uses animated captions.
        const effect =
          cue.emphasis.length > 0
            ? `{\\fad(60,60)\\fscx112\\fscy112\\t(0,90,\\fscx100\\fscy100)}`
            : `{\\fad(60,60)}`;
        events.push(
          `Dialogue: 0,${toAssTime(chunkStart)},${toAssTime(chunkEnd)},Caption,,0,0,0,,${effect}${applyEmphasis(
            chunk,
            cue.emphasis,
            theme,
          )}`,
        );
        cueCount += 1;
      });
    }
  }

  return { ass: [...styles, ...events].join('\n'), cueCount };
}

/** Escape a path for use as an FFmpeg filter argument (Windows paths need this). */
export function escapeFilterPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,');
}
