#!/usr/bin/env node
'use strict';
/**
 * md-optimizer.cjs — mechanical, semantics-preserving token compression for .md files.
 * Deterministic, $0, idempotent (second run = 0 savings).
 *
 * Transforms (outside code fences only):
 *   1. strip trailing whitespace (preserves markdown 2-space hard breaks)
 *   2. collapse 2+ consecutive blank lines -> 1
 *   3. drop consecutive duplicate lines (>20 chars — accidental doubles only)
 *   4. safe verbose-phrase compression ("in order to" -> "to", ...)
 * Preserves: BOM, CRLF-vs-LF style, everything inside ``` / ~~~ fences.
 *
 * Usage: node lib/md-optimizer.cjs [--dir <dir>]        (report/dry-run — genuinely read-only)
 *        node lib/md-optimizer.cjs --apply              (write, atomic tmp+rename)
 *        node lib/md-optimizer.cjs --dir docs --apply
 * Default scope: current directory, recursive. Skips node_modules/.git/archive/backups/dist.
 */
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const dirArgIdx = process.argv.indexOf('--dir');
const ROOT = path.resolve(dirArgIdx > -1 ? process.argv[dirArgIdx + 1] : process.cwd());
const EXCLUDE_DIR_RE = /node_modules|^\.git$|\bbackups?\b|\barchive\b|\bdist\b|\bbuild\b|\.next/i;

const PHRASES = [
  [/\bin order to\b/gi, 'to'],
  [/\bdue to the fact that\b/gi, 'since'],
  [/\b(is|are|was|were) able to\b/gi, (m, v) => ({ is: 'can', are: 'can', was: 'could', were: 'could' })[v.toLowerCase()]],
  [/\bat this point in time\b/gi, 'now'],
  [/\bin the event that\b/gi, 'if'],
  [/\bfor the purpose of\b/gi, 'to'],
  [/\bit is important to note that\b/gi, 'note:'],
  [/\bplease note that\b/gi, 'note:'],
  [/\bthe majority of\b/gi, 'most of'],
  [/\ba large number of\b/gi, 'many'],
  [/\bin the near future\b/gi, 'soon'],
];

function listMd(absDir, acc) {
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) {
      if (!EXCLUDE_DIR_RE.test(e.name)) listMd(abs, acc);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) acc.push(abs);
  }
  return acc;
}

function optimizeMd(src) {
  const bom = src.charCodeAt(0) === 0xFEFF ? '﻿' : '';
  if (bom) src = src.slice(1);
  const crlfCount = (src.match(/\r\n/g) || []).length;
  const lfTotal = src.split('\n').length - 1;
  const eol = crlfCount > lfTotal / 2 ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const out = [];
  let inFence = false, blankRun = 0, prev = null;
  for (const raw of lines) {
    let line = raw;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line.replace(/[ \t]+$/, ''));
      blankRun = 0; prev = null;
      continue;
    }
    if (inFence) { out.push(line); prev = null; blankRun = 0; continue; }
    const hardBreak = /\S {2,}$/.test(line);
    line = line.replace(/[ \t]+$/, '');
    if (hardBreak) line += '  ';
    if (line.trim() === '') {
      blankRun++;
      if (blankRun > 1) continue;
      out.push('');
      prev = '';
      continue;
    }
    blankRun = 0;
    for (const [re, rep] of PHRASES) line = line.replace(re, rep);
    if (prev !== null && line === prev && line.length > 20) continue;
    out.push(line);
    prev = line;
  }
  // exactly one trailing newline
  while (out.length && out[out.length - 1] === '') out.pop();
  return bom + out.join(eol) + eol;
}

function main() {
  const files = listMd(ROOT, []);
  let before = 0, after = 0, changed = 0;
  const perFile = [];
  for (const abs of files) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    if (EXCLUDE_DIR_RE.test(rel)) continue;
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch (e) { console.error('READ FAIL ' + rel + ': ' + e.message); continue; }
    const opt = optimizeMd(src);
    const b = Buffer.byteLength(src, 'utf8'), a = Buffer.byteLength(opt, 'utf8');
    before += b; after += a;
    if (opt !== src && a < b) {
      changed++;
      perFile.push({ rel, saved: b - a });
      if (APPLY) {
        const tmp = abs + '.tmp-mdopt';
        fs.writeFileSync(tmp, opt, 'utf8');
        fs.renameSync(tmp, abs);
      }
    }
  }
  perFile.sort((x, y) => y.saved - x.saved);
  const saved = before - after;
  console.log((APPLY ? 'APPLIED' : 'DRY-RUN') + ': ' + files.length + ' files scanned, ' + changed + ' compressible, ' +
    saved + ' bytes (~' + Math.round(saved / 4) + ' tokens) ' + (APPLY ? 'saved' : 'savable'));
  for (const f of perFile.slice(0, 25)) console.log('  ' + String(f.saved).padStart(8) + '  ' + f.rel);
}

if (require.main === module) main();
module.exports = { optimizeMd };
