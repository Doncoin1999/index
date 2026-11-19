#!/usr/bin/env node
// DON Creator Program ranker.
//   node creator/src/cli.js daily                     register, collect, refresh, leaderboard, finalize/submit when due
//   node creator/src/cli.js approve --period N        submit a proposed ranking now
//   node creator/src/cli.js veto    --period N --user NAME   exclude a creator from period N
//   node creator/src/cli.js unveto  --period N --user NAME
//   node creator/src/cli.js clear   --period N --user NAME   clear a high-severity fraud flag
//   node creator/src/cli.js propose --period N        recompute the proposal from stored data
//   node creator/src/cli.js status
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createXClient, createMockClient } from './x.js';
import { findWallet, postText } from './rules.js';
import { scorePeriod, resultHash } from './score.js';
import { submitRanking } from './onchain.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.RANKER_OUT_DIR ? path.resolve(process.env.RANKER_OUT_DIR) : ROOT;
const DIR = { data: path.join(OUT, 'data'), results: path.join(OUT, 'results'), payouts: path.join(OUT, 'payouts') };
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const now = () => (process.env.RANKER_NOW ? new Date(process.env.RANKER_NOW) : new Date());
const H = 36e5, DAY = 864e5;
const log = (...a) => console.log(...a);

/* ---------- storage ---------- */
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); };
const F = {
  creators: path.join(DIR.data, 'creators.json'),
  posts: path.join(DIR.data, 'posts.json'),
  state: path.join(DIR.data, 'state.json'),
  overrides: path.join(DIR.data, 'overrides.json'),
  leaderboard: path.join(DIR.results, 'leaderboard.json'),
  period: (n) => path.join(DIR.results, `period-${n}.json`),
  payout: (n) => path.join(DIR.payouts, `period-${n}.csv`),
};
const db = {
  creators: readJson(F.creators, {}),
  posts: readJson(F.posts, {}),
  state: readJson(F.state, { periods: {} }),
  overrides: readJson(F.overrides, {}),
};
const save = () => {
  writeJson(F.creators, db.creators);
  writeJson(F.posts, db.posts);
  writeJson(F.state, db.state);
  writeJson(F.overrides, db.overrides);
};

/* ---------- helpers ---------- */
let _client;
async function client() {
  if (_client) return _client;
  if (process.env.X_MOCK) {
    const { makeDataset } = await import(path.resolve(process.env.X_MOCK));
    _client = createMockClient(makeDataset(cfg), now);
  } else {
    _client = createXClient({ token: process.env.X_BEARER_TOKEN, log });
  }
  return _client;
}
const iso = (d) => new Date(d).toISOString();
const searchStart = (from) => {
  const floor = now().getTime() - 7 * DAY + 5 * 60e3; // recent search only covers 7 days
  return iso(Math.max(from ? new Date(from).getTime() : 0, floor));
};
const programStart = new Date(cfg.periods[0].start);
const programEnd = new Date(cfg.periods.at(-1).end);
const periodOf = (t) => cfg.periods.find((p) => new Date(t) >= new Date(p.start) && new Date(t) < new Date(p.end));
const pstate = (n) => (db.state.periods[n] ||= { status: 'pending' });
const ov = (n) => (db.overrides[n] ||= { veto: [], clear: [] });

function storeUser(u) {
  const c = db.creators[u.id];
  if (c) c.user = { username: u.username, created_at: u.created_at, public_metrics: u.public_metrics };
}

/* ---------- steps ---------- */
async function register() {
  const x = await client();
  const st = db.state;
  const { posts, users } = await x.searchRecent(`${cfg.registrationHashtag} -is:retweet`, { startTime: searchStart(st.lastRegistrationScan && new Date(st.lastRegistrationScan) - H) });
  const byId = new Map(users.map((u) => [u.id, u]));
  let added = 0, updated = 0;
  for (const p of posts.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (new Date(p.created_at) >= programEnd) continue;
    const wallet = findWallet(postText(p));
    const u = byId.get(p.author_id);
    if (!wallet || !u) continue;
    const c = db.creators[p.author_id];
    if (!c) {
      db.creators[p.author_id] = { id: p.author_id, username: u.username, wallet, registeredAt: p.created_at, registrationPostId: p.id, walletUpdatedAt: p.created_at };
      added++;
    } else if (c.registrationPostId !== p.id && p.created_at > c.walletUpdatedAt && c.wallet !== wallet) {
      c.wallet = wallet; c.walletUpdatedAt = p.created_at; c.walletPostId = p.id; updated++;
    }
    if (db.creators[p.author_id]) { db.creators[p.author_id].username = u.username; storeUser(u); }
  }
  st.lastRegistrationScan = iso(now());
  log(`Registration: ${added} new creator(s), ${updated} wallet update(s), ${Object.keys(db.creators).length} registered.`);
}

function buildQueries() {
  const kw = [...cfg.projectKeywords.map((k) => (/[\s.]/.test(k) ? `"${k}"` : k)), '@' + cfg.projectHandle];
  const tail = ` (${kw.join(' OR ')}) -is:retweet${cfg.rules.excludeReplies ? ' -is:reply' : ''}`;
  const names = Object.values(db.creators).map((c) => c.username);
  const qs = [];
  let cur = [];
  const q = (list) => `(${list.map((n) => 'from:' + n).join(' OR ')})${tail}`;
  for (const n of names) {
    if (cur.length && q([...cur, n]).length > cfg.maxQueryLength) { qs.push(q(cur)); cur = []; }
    cur.push(n);
  }
  if (cur.length) qs.push(q(cur));
  return qs;
}

function storePost(p, t) {
  if (!db.creators[p.author_id]) return false;
  const created = new Date(p.created_at);
  if (created < programStart || created >= programEnd) return false;
  const prev = db.posts[p.id];
  db.posts[p.id] = {
    id: p.id, author_id: p.author_id, created_at: p.created_at, text: postText(p),
    is_reply: Boolean(p.in_reply_to_user_id),
    metrics: p.public_metrics || prev?.metrics || null, metrics_at: iso(t), deleted: false,
  };
  return !prev;
}

async function collect() {
  const x = await client();
  const st = db.state;
  if (!Object.keys(db.creators).length) { log('Collect: no creators registered yet.'); return; }
  const start = searchStart(st.lastCollect && new Date(st.lastCollect) - H);
  let found = 0, fresh = 0;
  for (const query of buildQueries()) {
    const { posts, users } = await x.searchRecent(query, { startTime: start });
    users.forEach(storeUser);
    for (const p of posts) { found++; if (storePost(p, now())) fresh++; }
  }
  st.lastCollect = iso(now());
  log(`Collect: ${found} post(s) seen, ${fresh} new, ${Object.keys(db.posts).length} stored.`);
}

async function refreshPosts(ids, label) {
  if (!ids.length) return;
  const x = await client();
  const got = await x.lookupPosts(ids);
  const seen = new Set(got.map((p) => p.id));
  for (const p of got) { const s = db.posts[p.id]; if (s) { s.metrics = p.public_metrics; s.metrics_at = iso(now()); s.text = postText(p) || s.text; } }
  let gone = 0;
  for (const id of ids) if (!seen.has(id) && db.posts[id] && !db.posts[id].deleted) { db.posts[id].deleted = true; gone++; }
  log(`Refresh ${label}: ${got.length} updated, ${gone} deleted.`);
}

async function refreshRecent() {
  const cutoff = now().getTime() - cfg.refreshRecentDays * DAY;
  const ids = Object.values(db.posts).filter((p) => !p.deleted && new Date(p.created_at).getTime() >= cutoff && pstate(periodOf(p.created_at)?.n).status === 'pending').map((p) => p.id);
  await refreshPosts(ids, 'recent posts');
}

const postsOf = (period) => Object.values(db.posts).filter((p) => periodOf(p.created_at)?.n === period.n);

function carryInFor(n) {
  if (n === 1) return 0;
  const prev = db.state.periods[n - 1];
  if (prev?.status !== 'submitted') throw new Error(`Period ${n - 1} must be submitted before period ${n} can be scored.`);
  return prev.leftover || 0;
}

function compute(period, carryIn) {
  return scorePeriod({ period, creators: Object.values(db.creators), posts: postsOf(period), cfg, overrides: ov(period.n), carryIn });
}

async function finalize(period) {
  const ids = postsOf(period).filter((p) => !p.deleted).map((p) => p.id);
  await refreshPosts(ids, `period ${period.n} (final)`);
  const x = await client();
  const users = await x.lookupUsers(Object.keys(db.creators));
  users.forEach(storeUser);
  log(`Refreshed ${users.length} creator profile(s).`);
}

function propose(period) {
  const st = pstate(period.n);
  if (st.status === 'submitted') throw new Error(`Period ${period.n} is already submitted and cannot change.`);
  const carryIn = carryInFor(period.n);
  const r = compute(period, carryIn);
  const t = now();
  const result = {
    program: cfg.program, status: 'proposed', generatedAt: iso(t),
    autoSubmitAt: iso(t.getTime() + cfg.approvalWindowHours * H),
    ...r, hash: null, overrides: ov(period.n),
  };
  result.hash = resultHash(r);
  writeJson(F.period(period.n), result);
  Object.assign(st, { status: 'proposed', proposedAt: iso(t), hash: result.hash });
  log(`Period ${period.n} proposed (hash ${result.hash.slice(0, 12)}…):`);
  for (const w of r.winners) log(`  #${w.rank} @${w.username}  score ${w.score}  →  ${w.amount} DON (creator receives ${w.netAmount} after fee)`);
  if (r.winners.length < cfg.sharesBps.length) log(`  Only ${r.winners.length} creator(s) qualified; ${r.leftover} DON rolls over.`);
  const review = r.entries.filter((e) => e.flags.some((f) => f.severity !== 'info'));
  for (const e of review) log(`  Review @${e.username}: ${e.flags.filter((f) => f.severity !== 'info').map((f) => `${f.code} (${f.severity})`).join(', ')}${e.qualifies ? '' : ' – excluded'}`);
  return result;
}

async function submit(period) {
  const st = pstate(period.n);
  if (st.status !== 'proposed') throw new Error(`Period ${period.n} has no proposal to submit (status: ${st.status}).`);
  const result = readJson(F.period(period.n));
  const t = now();
  result.status = 'submitted';
  result.submittedAt = iso(t);
  result.claimableFrom = iso(t.getTime() + cfg.claimLockDays * DAY);
  delete result.autoSubmitAt;
  const last = period.n === cfg.periods.at(-1).n;
  if (last) result.returnToDevelopmentTeam = result.leftover;
  result.onchain = await submitRanking(cfg, result);
  writeJson(F.period(period.n), result);
  const csv = ['rank,username,wallet,reward_don_before_fee,fee_bps,creator_receives_don,creator_receives_units,claimable_from', ...result.winners.map((w) => [w.rank, w.username, w.wallet, w.amount, w.feeBps, w.netAmount, w.netAmountUnits, result.claimableFrom].join(','))].join('\n') + '\n';
  fs.mkdirSync(DIR.payouts, { recursive: true });
  fs.writeFileSync(F.payout(period.n), csv);
  Object.assign(st, { status: 'submitted', submittedAt: result.submittedAt, leftover: result.leftover });
  log(`Period ${period.n} submitted. Claimable from ${result.claimableFrom.slice(0, 10)}. ${last ? `${result.leftover} DON returns to the Development Team.` : `${result.leftover} DON rolls over to period ${period.n + 1}.`}`);
}

async function progressPeriods() {
  const t = now().getTime();
  for (const p of cfg.periods) {
    const st = pstate(p.n);
    if (st.status === 'pending' && t >= new Date(p.end).getTime() + cfg.finalizeAfterHours * H) {
      if (p.n > 1 && db.state.periods[p.n - 1]?.status !== 'submitted') break;
      await finalize(p);
      propose(p);
    }
    if (st.status === 'proposed' && t >= new Date(st.proposedAt).getTime() + cfg.approvalWindowHours * H) await submit(p);
    if (st.status !== 'submitted') break;
  }
}

function writeLeaderboard() {
  const t = now();
  const current = periodOf(t);
  let live = null;
  if (current) {
    let carryIn = 0;
    try { carryIn = carryInFor(current.n); } catch { carryIn = 0; }
    const r = compute(current, carryIn);
    const qualifying = r.entries.filter((e) => e.qualifies);
    live = {
      period: r.period,
      endsAt: current.end,
      standings: [...r.entries].sort((a, b) => (b.qualifies - a.qualifies) || (b.score - a.score)).slice(0, 25).map((e) => ({
        username: e.username, score: e.score, postsCounted: e.postsCounted, postsRejected: e.rejected.length,
        status: !e.eligible ? 'not_eligible' : e.vetoed ? 'excluded' : !e.qualifies && e.score > 0 ? 'under_review' : e.score > 0 ? 'ok' : e.rejected.length ? 'rules_not_met' : 'no_posts',
        reasons: e.ineligibleReasons,
        provisionalRank: e.qualifies ? qualifying.indexOf(e) + 1 : null,
        provisionalAmount: r.winners.find((w) => w.username === e.username)?.amount ?? null,
        provisionalNet: r.winners.find((w) => w.username === e.username)?.netAmount ?? null,
      })),
    };
  }
  const history = cfg.periods.map((p) => {
    const st = db.state.periods[p.n];
    if (!st || st.status === 'pending') return { n: p.n, start: p.start, end: p.end, amount: p.amount, status: 'pending' };
    const r = readJson(F.period(p.n), {});
    return { n: p.n, start: p.start, end: p.end, amount: p.amount, status: st.status, hash: r.hash, claimableFrom: r.claimableFrom || null, autoSubmitAt: r.autoSubmitAt || null, winners: (r.winners || []).map(({ rank, username, wallet, amount, netAmount }) => ({ rank, username, wallet, amount, netAmount })) };
  });
  writeJson(F.leaderboard, { program: cfg.program, updatedAt: iso(t), registeredCreators: Object.keys(db.creators).length, live, periods: history });
}

/* ---------- commands ---------- */
function arg(name) {
  const i = process.argv.indexOf('--' + name);
  const v = i > 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : undefined;
}
function needPeriod() {
  const n = Number(arg('period'));
  const p = cfg.periods.find((x) => x.n === n);
  if (!p) throw new Error('Give a valid --period (1–' + cfg.periods.length + ').');
  return p;
}
function needUser() {
  const u = (arg('user') || '').replace(/^@/, '');
  if (!u) throw new Error('Give --user with the X username.');
  return u;
}
function editList(p, list, user, add) {
  const o = ov(p.n);
  const has = o[list].some((x) => x.toLowerCase() === user.toLowerCase());
  if (add && !has) o[list].push(user);
  if (!add) o[list] = o[list].filter((x) => x.toLowerCase() !== user.toLowerCase());
  log(`${add ? 'Added' : 'Removed'} @${user} ${add ? 'to' : 'from'} ${list} for period ${p.n}.`);
  if (pstate(p.n).status === 'proposed') propose(p);
}

const commands = {
  async daily() {
    await register();
    await collect();
    await refreshRecent();
    await progressPeriods();
    writeLeaderboard();
  },
  async approve() { await submit(needPeriod()); writeLeaderboard(); },
  async veto() { editList(needPeriod(), 'veto', needUser(), true); writeLeaderboard(); },
  async unveto() { editList(needPeriod(), 'veto', needUser(), false); writeLeaderboard(); },
  async clear() { editList(needPeriod(), 'clear', needUser(), true); writeLeaderboard(); },
  async propose() { propose(needPeriod()); writeLeaderboard(); },
  async status() {
    log(`${Object.keys(db.creators).length} creator(s), ${Object.keys(db.posts).length} post(s). Last collect: ${db.state.lastCollect || 'never'}`);
    for (const p of cfg.periods) log(`  Period ${p.n} (${p.start.slice(0, 10)} → ${p.end.slice(0, 10)}, ${p.amount} DON): ${pstate(p.n).status}`);
  },
};

const cmd = process.argv[2] || 'daily';
if (!commands[cmd]) { console.error(`Unknown command "${cmd}". Use: ${Object.keys(commands).join(', ')}`); process.exit(2); }
try {
  await commands[cmd]();
  save();
  const s = _client?.stats?.();
  if (s && !process.env.X_MOCK) log(`X API: ${s.calls} call(s), ~${s.resources} resource(s) read.`);
} catch (e) {
  save();
  console.error('Error: ' + e.message);
  process.exit(1);
}
