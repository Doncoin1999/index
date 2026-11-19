import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scorePeriod, postPoints, toUnits, fromUnits, resultHash } from '../src/score.js';
import { checkPost, findWallet } from '../src/rules.js';

const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
const P1 = cfg.periods[0];
const OK = 'Daily check-in at doncoin.app #ad DON is a game token for entertainment, not an investment.';
const W = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

const creator = (id, extra = {}) => ({ id, username: 'user' + id, wallet: W, registeredAt: '2026-11-21T00:00:00Z', user: { created_at: '2020-01-01T00:00:00Z', public_metrics: { followers_count: 50000 } }, ...extra });
const post = (id, author, likes, extra = {}) => ({ id: String(id), author_id: author, created_at: '2026-12-01T12:00:00Z', text: OK, is_reply: false, deleted: false, metrics: { like_count: likes, retweet_count: 0, reply_count: 0, quote_count: 0, impression_count: likes * 20 }, ...extra });

test('rule checks', () => {
  assert.deepEqual(checkPost(OK, cfg), []);
  assert.ok(checkPost(OK.replace('#ad', ''), cfg).includes('missing_ad_label'));
  assert.ok(checkPost(OK.replace('#ad', '#adventure'), cfg).includes('missing_ad_label'));
  assert.ok(checkPost(OK.replace(', not an investment', ''), cfg).includes('missing_disclaimer'));
  assert.ok(checkPost(OK + ' To the moon!', cfg).some((r) => r.startsWith('banned_phrase')));
  assert.ok(checkPost('gm #ad not an investment', cfg).includes('no_project_mention'));
  assert.ok(checkPost(OK.replace('#ad', 'Paid partnership'), cfg).length === 0);
});

test('wallet parsing', () => {
  assert.equal(findWallet(`Joining #DONCreator wallet: ${W}`), W);
  assert.equal(findWallet('Joining #DONCreator wallet: not-a-wallet'), null);
});

test('points formula', () => {
  assert.equal(postPoints({ retweet_count: 2, quote_count: 1, reply_count: 3, like_count: 10, impression_count: 1000 }, cfg.scoring), 6 + 3 + 6 + 10 + 10);
});

test('top 5 get 35/25/18/12/10 and amounts add up', () => {
  const creators = [1, 2, 3, 4, 5, 6].map((i) => creator(String(i)));
  const posts = creators.map((c, i) => post(i + 1, c.id, 100 * (i + 1)));
  const r = scorePeriod({ period: P1, creators, posts, cfg });
  assert.deepEqual(r.winners.map((w) => w.username), ['user6', 'user5', 'user4', 'user3', 'user2']);
  assert.deepEqual(r.winners.map((w) => w.amount), [17500, 12500, 9000, 6000, 5000]);
  assert.equal(r.leftover, 0);
  assert.equal(r.winners.reduce((s, w) => s + BigInt(w.amountUnits), 0n), toUnits(50000, 9));
});

test('fewer than 5 qualifiers leaves a remainder that rolls over', () => {
  const creators = [creator('1'), creator('2')];
  const r = scorePeriod({ period: P1, creators, posts: [post(1, '1', 50), post(2, '2', 40)], cfg, carryIn: 1000 });
  assert.equal(r.period.total, 51000);
  assert.equal(r.leftover, 51000 * 0.4);
});

test('eligibility, vetoes, flags and post caps', () => {
  const creators = [
    creator('1'),
    creator('2', { user: { created_at: '2026-10-01T00:00:00Z', public_metrics: { followers_count: 50000 } } }), // too new
    creator('3', { user: { created_at: '2020-01-01T00:00:00Z', public_metrics: { followers_count: 10 } } }),    // too few followers
    creator('4'), // botted
    creator('5'), // vetoed
    creator('6', { registeredAt: '2027-03-25T00:00:00Z' }), // registered after period
  ];
  const posts = [
    ...Array.from({ length: 60 }, (_, i) => post(100 + i, '1', 10)),
    post(2, '2', 500), post(3, '3', 500),
    post(4, '4', 900, { metrics: { like_count: 900, retweet_count: 0, reply_count: 0, quote_count: 0, impression_count: 1000 } }),
    post(5, '5', 800), post(6, '6', 800),
    post(7, '1', 999, { is_reply: true }), post(8, '1', 999, { deleted: true }),
    post(9, '1', 999, { created_at: '2026-11-20T12:00:00Z' }), // before registration
  ];
  const r = scorePeriod({ period: P1, creators, posts, cfg, overrides: { veto: ['user5'] } });
  const e = Object.fromEntries(r.entries.map((x) => [x.username, x]));
  assert.equal(e.user1.postsCounted, 40); // 10 per month × 4 months
  assert.equal(e.user1.rejected.length, 3);
  assert.deepEqual(e.user2.ineligibleReasons, ['account_too_new']);
  assert.deepEqual(e.user3.ineligibleReasons, ['too_few_followers']);
  assert.equal(e.user4.flags[0].code, 'engagement_rate');
  assert.equal(e.user4.qualifies, false);
  assert.equal(e.user5.qualifies, false);
  assert.deepEqual(e.user6.ineligibleReasons, ['registered_after_period']);
  assert.deepEqual(r.winners.map((w) => w.username), ['user1']);
  const cleared = scorePeriod({ period: P1, creators, posts, cfg, overrides: { veto: ['user5'], clear: ['user4'] } });
  assert.deepEqual(cleared.winners.map((w) => w.username), ['user4', 'user1']);
});

test('units and hash are stable', () => {
  assert.equal(toUnits(17500, 9), 17500000000000n);
  assert.equal(fromUnits(123456789n, 9), 0.123456789);
  const creators = [creator('1')];
  const a = scorePeriod({ period: P1, creators, posts: [post(1, '1', 10)], cfg });
  const b = scorePeriod({ period: P1, creators, posts: [post(1, '1', 10)], cfg });
  assert.equal(resultHash(a), resultHash(b));
  assert.match(resultHash(a), /^[0-9a-f]{64}$/);
});
