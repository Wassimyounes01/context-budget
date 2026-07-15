'use strict';
// demo.cjs — register a few signals, watch pressure climb through the load modes, and budget tokens.
// Run: node examples/demo.cjs
const { Meter, Budget, estimateTokens } = require('../lib/ballast.cjs');

// A meter with three weighted signals. Here the values are inline numbers; in a real agent they'd
// be lazy functions reading file sizes, log counts, or a session-start timestamp.
function meterAt({ memoryKB, logLines, sessionMin }) {
  return new Meter()
    .add({ name: 'memory-size', weight: 0.5, value: memoryKB * 1024, comfortable: 50e3, stressed: 200e3, critical: 500e3 })
    .add({ name: 'log-lines', weight: 0.3, value: logLines, comfortable: 500, stressed: 2000, critical: 5000 })
    .add({ name: 'session-min', weight: 0.2, value: sessionMin, comfortable: 30, stressed: 90, critical: 180 });
}

const scenarios = [
  { label: 'fresh session', memoryKB: 40, logLines: 120, sessionMin: 10 },
  { label: 'a few hours in', memoryKB: 180, logLines: 1500, sessionMin: 70 },
  { label: 'marathon session', memoryKB: 460, logLines: 4800, sessionMin: 170 },
];

for (const s of scenarios) {
  const m = meterAt(s);
  const p = m.pressure();
  console.log(`\n${s.label.padEnd(18)} pressure=${p}  mode=${m.mode()}${m.shouldCompact() ? '  ⚠ compact' : ''}`);
  for (const r of m.report()) console.log(`   ${r.name.padEnd(13)} norm=${r.normalized}  contrib=${r.contribution}`);
}

console.log('\n--- token budget ---');
const b = new Budget(120000);
b.spend(estimateTokens('system prompt and tools'.repeat(400)));
b.spend('a big chunk of conversation history '.repeat(3000));
console.log(`spent=${b.spent()}  remaining=${b.remaining()}  fraction=${b.fraction().toFixed(2)}  over=${b.over()}`);
