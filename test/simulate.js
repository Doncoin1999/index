// Runs the bot once per simulated day across the whole program in mock mode.
//   node creator/test/simulate.js [outDir]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.js');
const out = path.resolve(process.argv[2] || '/tmp/ranker-sim');
fs.rmSync(out, { recursive: true, force: true });
const env = (now) => ({ ...process.env, X_MOCK: path.join(here, 'mock-data.js'), PAYOUT_MOCK: path.join(here, 'mock-chain.js'), RANKER_OUT_DIR: out, RANKER_NOW: now });
const run = (now, ...args) => execFileSync('node', [cli, ...args], { env: env(now), encoding: 'utf8' });

let t = new Date('2026-11-20T06:17:00Z');
const stop = new Date('2027-11-24T06:17:00Z');
while (t <= stop) {
  const now = t.toISOString();
  const o = run(now, 'daily');
  const lines = o.split('\n').filter((l) => /proposed|submitted|Paid|PROBLEM|qualified|returns|rolls/.test(l));
  if (lines.length) console.log(`--- ${now.slice(0, 10)}\n` + lines.join('\n'));
  // Admin action during the first approval window: veto a creator, then approve early.
  if (now.startsWith('2027-03-22')) {
    console.log('--- admin: veto @daily_degen for period 1, then approve');
    console.log(run(now, 'veto', '--period', '1', '--user', 'daily_degen').trim());
    console.log(run(now, 'approve', '--period', '1').trim());
  }
  t = new Date(t.getTime() + 864e5);
}
console.log('\n' + run(stop.toISOString(), 'status'));
console.log('Output in', out);
