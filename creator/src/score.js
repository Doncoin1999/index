// Pure scoring, ranking and allocation. No I/O, so it is easy to test and audit.
import { createHash } from 'node:crypto';
import { checkPost } from './rules.js';

const DAY = 864e5;

export function postPoints(m, sc) {
  if (!m) return 0;
  return (m.retweet_count || 0) * sc.repost
    + (m.quote_count || 0) * sc.quote
    + (m.reply_count || 0) * sc.reply
    + (m.like_count || 0) * sc.like
    + (m.impression_count || 0) / sc.impressionsPerPoint;
}

export function monthsInPeriod(p) {
  const days = (new Date(p.end) - new Date(p.start)) / DAY;
  return Math.max(1, Math.round(days / 30.44));
}

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Score every registered creator for one period.
 * creators: [{id, username, wallet, registeredAt, user:{created_at, public_metrics}}]
 * posts:    [{id, author_id, created_at, text, is_reply, deleted, metrics}]
 * overrides: {veto:[username], clear:[username]}
 */
export function scorePeriod({ period, creators, posts, cfg, overrides = {}, carryIn = 0 }) {
  const start = new Date(period.start), end = new Date(period.end);
  const maxPosts = cfg.scoring.maxPostsPerMonth * monthsInPeriod(period);
  const veto = new Set((overrides.veto || []).map((s) => s.toLowerCase()));
  const clear = new Set((overrides.clear || []).map((s) => s.toLowerCase()));
  const r = cfg.rules, fr = cfg.fraud;

  const entries = creators.map((c) => {
    const reasons = [];
    const regAt = new Date(c.registeredAt);
    if (regAt >= end) reasons.push('registered_after_period');
    const created = c.user?.created_at ? new Date(c.user.created_at) : null;
    if (!created || (end - created) / DAY < r.minAccountAgeDays) reasons.push('account_too_new');
    const followers = c.user?.public_metrics?.followers_count ?? 0;
    if (followers < r.minFollowers) reasons.push('too_few_followers');

    const mine = posts.filter((p) => p.author_id === c.id && new Date(p.created_at) >= start && new Date(p.created_at) < end);
    const accepted = [], rejected = [];
    for (const p of mine) {
      const why = [];
      if (p.deleted) why.push('deleted');
      if (r.excludeReplies && p.is_reply) why.push('reply');
      if (r.onlyPostsAfterRegistration && new Date(p.created_at) < regAt) why.push('before_registration');
      why.push(...checkPost(p.text, cfg));
      const pts = postPoints(p.metrics, cfg.scoring);
      if (why.length) rejected.push({ id: p.id, reasons: why });
      else accepted.push({ id: p.id, created_at: p.created_at, points: round2(pts), metrics: p.metrics || null });
    }
    accepted.sort((a, b) => b.points - a.points || a.created_at.localeCompare(b.created_at));
    const counted = accepted.slice(0, maxPosts);
    const score = round2(counted.reduce((s, p) => s + p.points, 0));

    const flags = [];
    const rateHits = counted.filter((p) => {
      const m = p.metrics || {};
      const imp = m.impression_count || 0;
      const eng = (m.like_count || 0) + (m.retweet_count || 0) + (m.reply_count || 0) + (m.quote_count || 0);
      return imp >= fr.minImpressionsForRateCheck && eng / imp > fr.maxEngagementRate;
    });
    if (rateHits.length) flags.push({ code: 'engagement_rate', severity: 'high', detail: `${rateHits.length} post(s) above ${fr.maxEngagementRate * 100}% engagement rate`, posts: rateHits.map((p) => p.id) });
    const reachHits = counted.filter((p) => followers > 0 && (p.metrics?.impression_count || 0) / followers > fr.maxImpressionsPerFollower);
    if (reachHits.length) flags.push({ code: 'reach_vs_followers', severity: 'medium', detail: `${reachHits.length} post(s) with more than ${fr.maxImpressionsPerFollower}x followers in views`, posts: reachHits.map((p) => p.id) });
    const top = counted[0]?.points || 0;
    if (score > 0 && counted.length > 1 && top / score > fr.dominantPostShare) flags.push({ code: 'dominant_post', severity: 'info', detail: `one post is ${Math.round(top / score * 100)}% of the score`, posts: [counted[0].id] });
    if (rejected.length) flags.push({ code: 'rejected_posts', severity: 'info', detail: `${rejected.length} post(s) did not meet the rules` });

    const cleared = clear.has(c.username.toLowerCase());
    const vetoed = veto.has(c.username.toLowerCase());
    const blocking = !cleared && flags.some((f) => f.severity === 'high');
    return {
      username: c.username, userId: c.id, wallet: c.wallet, followers,
      eligible: reasons.length === 0, ineligibleReasons: reasons,
      score, postsCounted: counted.length, postsAccepted: accepted.length,
      counted: counted.map((p) => ({ id: p.id, points: p.points })),
      rejected, flags, flagsCleared: cleared, vetoed,
      qualifies: reasons.length === 0 && !vetoed && !blocking && score > 0,
      firstPostAt: counted.length ? counted.map((p) => p.created_at).sort()[0] : null,
    };
  });

  entries.sort((a, b) => b.score - a.score || (a.firstPostAt || '9').localeCompare(b.firstPostAt || '9') || a.username.localeCompare(b.username));
  const winners = allocate(entries.filter((e) => e.qualifies).slice(0, cfg.sharesBps.length), period.amount + carryIn, cfg);
  const total = toUnits(period.amount + carryIn, cfg.decimals);
  const paid = winners.reduce((s, w) => s + BigInt(w.amountUnits), 0n);
  return {
    period: { n: period.n, start: period.start, end: period.end, amount: period.amount, carryIn, total: period.amount + carryIn, maxPostsCounted: maxPosts },
    winners,
    leftover: fromUnits(total - paid, cfg.decimals),
    entries,
  };
}

export function allocate(top, totalDon, cfg) {
  const total = toUnits(totalDon, cfg.decimals);
  return top.map((e, i) => {
    const units = (total * BigInt(cfg.sharesBps[i])) / 10000n;
    return { rank: i + 1, username: e.username, userId: e.userId, wallet: e.wallet, score: e.score, shareBps: cfg.sharesBps[i], amount: fromUnits(units, cfg.decimals), amountUnits: units.toString() };
  });
}

export function toUnits(don, decimals) {
  const [w, f = ''] = String(don).split('.');
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

export function fromUnits(units, decimals) {
  const d = 10n ** BigInt(decimals);
  const w = units / d, f = units % d;
  return f === 0n ? Number(w) : Number(`${w}.${f.toString().padStart(decimals, '0').replace(/0+$/, '')}`);
}

export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

// The hash covers the period, every score and the winners; it is what goes on-chain.
export function resultHash(result) {
  const { period, winners, leftover, entries } = result;
  return createHash('sha256').update(canonical({ period, winners, leftover, entries })).digest('hex');
}
