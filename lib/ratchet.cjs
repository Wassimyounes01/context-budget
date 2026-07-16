#!/usr/bin/env node
'use strict';
/**
 * ratchet.cjs — 100%-prevention context-bloat ratchet.
 *
 * Every context-HOT file (anything loaded into your agent's window at session start —
 * system prompts, instruction files, skill/command descriptions, memory digests) gets a
 * LOCKED byte ceiling. Any growth past the ceiling is a loud violation (exit 2) the day
 * it happens — wire this into a daily job and bloat has no unmonitored path in. Ceilings
 * only move when a deliberate --rebase re-locks them at current size + slack. A new hot
 * surface with no ceiling is itself a violation until locked.
 *
 * Config (ratchet.config.json in the root, or RATCHET_CONFIG=path):
 *   { "files": ["AGENTS.md", "prompts/system.md"],
 *     "aggregates": [{ "key": "agg:skills", "dir": "skills", "recursive": true }],
 *     "slack": 1.10 }
 *
 * Usage: node lib/ratchet.cjs [--root <dir>]            check (exit 0 clean / 2 violations)
 *        node lib/ratchet.cjs --rebase                  re-lock all ceilings at current+slack
 * First run with no budgets file auto-baselines (self-bootstrapping for cron).
 * Writes EVERY run: data/ratchet-status.json + data/ratchet-history.jsonl.
 */
const fs = require('fs');
const path = require('path');

const REBASE = process.argv.includes('--rebase');
const rootIdx = process.argv.indexOf('--root');
const ROOT = path.resolve(rootIdx > -1 ? process.argv[rootIdx + 1] : process.cwd());
const DATA_DIR = process.env.RATCHET_DATA_DIR || path.join(ROOT, 'data');
const BUDGETS_PATH = path.join(DATA_DIR, 'budgets.json');
const STATUS_PATH = path.join(DATA_DIR, 'ratchet-status.json');
const HISTORY_PATH = path.join(DATA_DIR, 'ratchet-history.jsonl');

function loadConfig() {
  const p = process.env.RATCHET_CONFIG || path.join(ROOT, 'ratchet.config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* defaults below */ }
  return {
    files: Array.isArray(cfg.files) ? cfg.files : [],
    aggregates: Array.isArray(cfg.aggregates) ? cfg.aggregates : [],
    slack: Number.isFinite(cfg.slack) && cfg.slack >= 1 ? cfg.slack : 1.10,
  };
}

function sizeOf(abs) { try { return fs.statSync(abs).size; } catch { return null; } }

function aggBytes(dir, recursive) {
  let total = 0, count = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory() && recursive) {
      const sub = aggBytes(abs, true);
      if (sub) { total += sub.total; count += sub.count; }
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      total += fs.statSync(abs).size; count++;
    }
  }
  return { total, count };
}

function measure(cfg) {
  const m = {};
  for (const rel of cfg.files) {
    const b = sizeOf(path.resolve(ROOT, rel));
    if (b !== null) m[rel] = b;
  }
  for (const a of cfg.aggregates) {
    if (!a || !a.key || !a.dir) continue;
    const r = aggBytes(path.resolve(ROOT, a.dir), !!a.recursive);
    if (r !== null) m[a.key] = r.total;
  }
  return m;
}

function main() {
  const ts = new Date().toISOString();
  const cfg = loadConfig();
  if (!cfg.files.length && !cfg.aggregates.length) {
    console.error('ratchet: nothing to watch — add "files"/"aggregates" to ratchet.config.json (or set RATCHET_CONFIG)');
    process.exit(2);
  }
  const measured = measure(cfg);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let budgets = null;
  try { budgets = JSON.parse(fs.readFileSync(BUDGETS_PATH, 'utf8')); } catch { /* first run */ }

  if (REBASE || !budgets) {
    const b = { version: 1, updated: ts, reason: REBASE ? 'rebase' : 'auto-baseline', ceilings: {} };
    for (const [k, v] of Object.entries(measured)) b.ceilings[k] = Math.ceil(v * cfg.slack);
    fs.writeFileSync(BUDGETS_PATH, JSON.stringify(b, null, 2), 'utf8');
    console.log((REBASE ? 'REBASED' : 'AUTO-BASELINED') + ' ' + Object.keys(b.ceilings).length +
      ' ceilings (measured +' + Math.round((cfg.slack - 1) * 100) + '% slack) -> ' + path.relative(ROOT, BUDGETS_PATH));
    budgets = b;
  }

  const violations = [];
  for (const [k, ceiling] of Object.entries(budgets.ceilings || {})) {
    const now = measured[k];
    if (now == null) { violations.push({ key: k, kind: 'missing', ceiling, now: null }); continue; }
    if (now > ceiling) violations.push({ key: k, kind: 'over', ceiling, now, over_by: now - ceiling });
  }
  // new hot surfaces with no ceiling yet = unbounded growth vector -> violation until locked
  for (const k of Object.keys(measured)) {
    if (!(k in (budgets.ceilings || {}))) violations.push({ key: k, kind: 'unlocked', now: measured[k] });
  }

  const status = { ts, ok: violations.length === 0, violations, measured, budgets_updated: budgets.updated };
  fs.writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2), 'utf8');
  fs.appendFileSync(HISTORY_PATH, JSON.stringify({
    ts, ok: status.ok, violations: violations.length,
    total_hot_bytes: Object.values(measured).reduce((a, b) => a + b, 0),
  }) + '\n', 'utf8');

  if (violations.length) {
    console.log('CONTEXT BLOAT: ' + violations.length + ' violation(s)');
    for (const v of violations) {
      console.log('  [' + v.kind + '] ' + v.key + (
        v.kind === 'over' ? ': ' + v.now + ' > ceiling ' + v.ceiling + ' (+' + v.over_by + 'b) — compress/distill (md-optimizer --apply), then --rebase only if the growth is justified'
        : v.kind === 'unlocked' ? ': ' + v.now + 'b unbudgeted — run --rebase to lock'
        : ' missing'));
    }
    process.exit(2);
  }
  console.log('ratchet: CLEAN (' + Object.keys(measured).length + ' hot surfaces within ceilings)');
}

if (require.main === module) main();
module.exports = { loadConfig, measure };
