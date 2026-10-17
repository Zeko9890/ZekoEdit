#!/usr/bin/env node
/**
 * ZekoEdit environment check.
 *
 *   npm run check:env
 *
 * Verifies the three things the MVP cannot run without: Node, FFmpeg/ffprobe,
 * and a writable working directory. Run this before blaming the editor.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const problems = [];
const notes = [];

function check(label, fn) {
  try {
    const detail = fn();
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    console.log(`  FAIL  ${label} — ${err.message}`);
    problems.push(`${label}: ${err.message}`);
  }
}

function resolveFromPackage(name, envVar) {
  const fromEnv = process.env[envVar];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const mod = require(name);
    const p = typeof mod === 'string' ? mod : mod?.path;
    if (p && existsSync(p)) return p;
    notes.push(`${name} is installed but its binary was not found at "${p}" — falling back to PATH.`);
  } catch {
    notes.push(`${name} is not installed. Run "npm install", or set ${envVar}.`);
  }
  return process.platform === 'win32' ? envVar === 'FFMPEG_PATH' ? 'ffmpeg.exe' : 'ffprobe.exe' : envVar === 'FFMPEG_PATH' ? 'ffmpeg' : 'ffprobe';
}

function run(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.error) throw new Error(result.error.code === 'ENOENT' ? `not found (${bin})` : result.error.message);
  if (result.status !== 0) throw new Error((result.stderr || 'exited with an error').split('\n')[0]);
  return `${result.stdout || ''}${result.stderr || ''}`;
}

console.log('\nZekoEdit environment check\n');

check('Node.js >= 18.18', () => {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) throw new Error(`found ${process.versions.node}; install Node 18.18 or newer`);
  return process.versions.node;
});

const ffmpeg = resolveFromPackage('ffmpeg-static', 'FFMPEG_PATH');
const ffprobe = resolveFromPackage('ffprobe-static', 'FFPROBE_PATH');

console.log(`\n  ffmpeg  → ${ffmpeg}`);
console.log(`  ffprobe → ${ffprobe}\n`);

let ffmpegOk = false;
check('ffmpeg runs', () => {
  const out = run(ffmpeg, ['-hide_banner', '-version']);
  ffmpegOk = true;
  return out.split('\n')[0].trim().slice(0, 80);
});

check('ffprobe runs', () => {
  run(ffprobe, ['-hide_banner', '-version']);
  return 'ok';
});

if (ffmpegOk) {
  check('encoder libx264', () => {
    const out = run(ffmpeg, ['-hide_banner', '-encoders']);
    if (!/libx264/.test(out)) throw new Error('missing; H.264 output is required');
    return 'present';
  });

  check('encoder aac', () => {
    const out = run(ffmpeg, ['-hide_banner', '-encoders']);
    if (!/\saac\s/.test(out)) throw new Error('missing; audio would be dropped');
    return 'present';
  });

  check('libass (burned captions)', () => {
    const out = run(ffmpeg, ['-hide_banner', '-filters']);
    if (!/\sass\s/.test(out)) {
      notes.push('This FFmpeg build has no libass. Edits still render, but captions will be skipped.');
      return 'MISSING — captions will be skipped';
    }
    return 'present';
  });
}

check('data directory writable', () => {
  const dir = process.env.ZEKO_DATA_DIR?.trim() || path.join(process.cwd(), 'data', 'jobs');
  mkdirSync(dir, { recursive: true });
  accessSync(dir, constants.W_OK);
  return dir;
});

check('Gemini model', () => process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash (default)');

console.log('');

if (notes.length) {
  console.log('Notes:');
  for (const note of notes) console.log(`  · ${note}`);
  console.log('');
}

if (problems.length) {
  console.log('Problems:');
  for (const problem of problems) console.log(`  ✗ ${problem}`);
  console.log('\nFix the items above, then run this check again.');
  console.log('If the bundled binaries are missing, either run "npm install" again');
  console.log('or install FFmpeg system-wide and set FFMPEG_PATH / FFPROBE_PATH.');
  // Node too old is the only hard stop: the app cannot boot at all.
  const nodeTooOld = problems.some((p) => p.startsWith('Node.js'));
  console.log('\nThe app will boot, but rendering will fail until FFmpeg is available.\n');
  process.exit(nodeTooOld ? 1 : 0);
}

console.log('Everything needed for a local edit is present. Start it with: npm run dev\n');
