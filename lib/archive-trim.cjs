#!/usr/bin/env node
'use strict';
/**
 * archive-trim.cjs — archive-rotate append-forever .md files.
 *
 * Log-style markdown files (content queues, running notes, session journals) grow without
 * bound while consumers only ever read the recent tail. Rotation: when a file exceeds
 * TRIGGER, the older head moves to <archive-dir>/<base>-archive.md (appended — nothing is
 * ever deleted) and the file keeps the newest ~KEEP bytes, split at a block boundary
 * ("\n## ", then "\n---", then a blank line) so no entry is cut mid-thought.
 *
 * Usage: node lib/archive-trim.cjs --file notes.md [--file more.md] [--apply]
 *        node lib/archive-trim.cjs --file journal.md --trigger 120 --keep 80 --apply
 * Dry-run by default (read-only). --trigger/--keep are KB. Archive dir: ./archive next to
 * each file (override with --archive-dir <dir>).
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');

function argAll(flag) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === flag && argv[i + 1]) out.push(argv[i + 1]);
  return out;
}
function argOne(flag, dflt) {
  const i = argv.indexOf(flag);
  return i > -1 && argv[i + 1] ? argv[i + 1] : dflt;
}

const FILES = argAll('--file');
const TRIGGER = (parseInt(argOne('--trigger', '120'), 10) || 120) * 1024;
const KEEP = (parseInt(argOne('--keep', '80'), 10) || 80) * 1024;
const ARCHIVE_DIR_ARG = argOne('--archive-dir', null);

function splitPoint(src) {
  // first block boundary at/after (len - KEEP): prefer "\n## ", then "\n---", then "\n\n"
  const from = Math.max(0, Buffer.byteLength(src, 'utf8') - KEEP);
  let idx = src.length - Math.min(src.length, KEEP);
  for (const marker of ['\n## ', '\n---', '\n\n']) {
    const p = src.indexOf(marker, idx);
    if (p > 0 && p < src.length - 1024) return p + 1; // keep starts at the boundary line
  }
  return from > 0 ? idx : -1;
}

function main() {
  if (!FILES.length) {
    console.error('usage: node lib/archive-trim.cjs --file <path.md> [--file ...] [--trigger KB] [--keep KB] [--archive-dir dir] [--apply]');
    process.exit(2);
  }
  let totalArchived = 0, rotated = 0;
  for (const f of FILES) {
    const abs = path.resolve(f);
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch { console.error('skip (unreadable): ' + f); continue; }
    const bytes = Buffer.byteLength(src, 'utf8');
    if (bytes <= TRIGGER) { console.log('under trigger: ' + f + ' (' + Math.round(bytes / 1024) + 'KB <= ' + Math.round(TRIGGER / 1024) + 'KB)'); continue; }
    const cut = splitPoint(src);
    if (cut <= 0) continue;
    const head = src.slice(0, cut), tail = src.slice(cut);
    const base = path.basename(abs).replace(/\.md$/i, '');
    const archiveDir = ARCHIVE_DIR_ARG ? path.resolve(ARCHIVE_DIR_ARG) : path.join(path.dirname(abs), 'archive');
    const archAbs = path.join(archiveDir, base + '-archive.md');
    const headBytes = Buffer.byteLength(head, 'utf8');
    console.log((APPLY ? 'ROTATED' : 'WOULD ROTATE') + ' ' + f + ': ' + Math.round(bytes / 1024) + 'KB -> keep ' +
      Math.round(Buffer.byteLength(tail, 'utf8') / 1024) + 'KB, archive ' + Math.round(headBytes / 1024) + 'KB');
    if (APPLY) {
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.appendFileSync(archAbs, '\n\n<!-- archive-trim rotation ' + new Date().toISOString() + ' from ' + path.basename(abs) + ' -->\n\n' + head, 'utf8');
      const note = '<!-- older entries archived to ' + path.relative(path.dirname(abs), archAbs).replace(/\\/g, '/') + ' (archive-trim) -->\n';
      const tmp = abs + '.tmp-trim';
      fs.writeFileSync(tmp, note + tail, 'utf8');
      fs.renameSync(tmp, abs);
    }
    totalArchived += headBytes; rotated++;
  }
  console.log((APPLY ? 'APPLIED' : 'DRY-RUN') + ': ' + rotated + ' file(s) rotated, ' + Math.round(totalArchived / 1024) + 'KB (~' + Math.round(totalArchived / 4096) + 'K tokens) moved to archive');
}

if (require.main === module) main();
module.exports = { splitPoint };
