'use strict';

/**
 * ratchet-demo.cjs — the bloat ratchet's full lifecycle in a sandbox:
 * baseline → clean check → a file grows past its ceiling → loud violation (exit 2)
 * → deliberate --rebase → clean again. Deterministic, offline, $0.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RATCHET = path.join(__dirname, '..', 'lib', 'ratchet.cjs');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-demo-'));

fs.writeFileSync(path.join(sandbox, 'AGENTS.md'), '# Agent instructions\n' + 'stable content line\n'.repeat(20));
fs.mkdirSync(path.join(sandbox, 'skills'));
fs.writeFileSync(path.join(sandbox, 'skills', 'search.md'), '# Search skill\nhow to search\n');
fs.writeFileSync(path.join(sandbox, 'ratchet.config.json'), JSON.stringify({
  files: ['AGENTS.md'],
  aggregates: [{ key: 'agg:skills', dir: 'skills', recursive: true }],
  slack: 1.10,
}, null, 2));

function run(args) {
  try {
    const out = execFileSync('node', [RATCHET, '--root', sandbox, ...args], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

console.log('1) first run auto-baselines the ceilings:');
let r = run([]);
console.log('   ' + r.out.trim().split('\n')[0] + '  (exit ' + r.code + ')');

console.log('\n2) second run is a clean check:');
r = run([]);
console.log('   ' + r.out.trim() + '  (exit ' + r.code + ')');
const cleanCode = r.code;

console.log('\n3) AGENTS.md bloats 3x — the ratchet fires the same day:');
fs.appendFileSync(path.join(sandbox, 'AGENTS.md'), 'accumulated cruft nobody distilled\n'.repeat(40));
r = run([]);
console.log('   ' + r.out.trim().split('\n').slice(0, 2).join('\n   ') + '  (exit ' + r.code + ')');
const violationCode = r.code;

console.log('\n4) growth judged deliberate -> --rebase re-locks at current + slack:');
r = run(['--rebase']);
console.log('   ' + r.out.trim().split('\n')[0] + '  (exit ' + r.code + ')');
r = run([]);
console.log('   ' + r.out.trim() + '  (exit ' + r.code + ')');

fs.rmSync(sandbox, { recursive: true, force: true });

if (cleanCode !== 0 || violationCode !== 2 || r.code !== 0) {
  console.error('demo: unexpected exit codes (clean=' + cleanCode + ', violation=' + violationCode + ', rebased=' + r.code + ')');
  process.exit(1);
}
console.log('\nlifecycle verified: clean 0 · violation 2 · rebased 0');
