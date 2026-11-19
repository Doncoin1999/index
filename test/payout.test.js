import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PublicKey, Keypair } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { scorePeriod, resultHash } from '../src/score.js';
import { runPayouts } from '../src/payout.js';
import { createMockConnection, mockPayer } from './mock-chain.js';

const base = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
const payer = mockPayer();
const cfg = { ...base, payout: { ...base.payout, enabled: true, dryRun: false, payoutWallet: payer.publicKey.toBase58() } };
const mint = new PublicKey(cfg.payout.mint);
const src = getAssociatedTokenAddressSync(mint, payer.publicKey, true).toBase58();
const OK = 'Daily check-in at doncoin.app #ad DON is a game token for entertainment, not an investment.';
const wallets = Array.from({ length: 5 }, (_, i) => Keypair.fromSeed(new Uint8Array(32).fill(i + 1)).publicKey.toBase58());

function submittedResult() {
  const creators = wallets.map((w, i) => ({ id: String(i + 1), username: 'u' + (i + 1), wallet: w, registeredAt: '2026-11-21T00:00:00Z', user: { created_at: '2020-01-01T00:00:00Z', public_metrics: { followers_count: 9000 } } }));
  const posts = creators.map((c, i) => ({ id: String(i + 1), author_id: c.id, created_at: '2026-12-01T00:00:00Z', text: OK, metrics: { like_count: 100 * (5 - i), retweet_count: 0, reply_count: 0, quote_count: 0, impression_count: 100000 } }));
  const r = scorePeriod({ period: cfg.periods[0], creators, posts, cfg });
  return { ...r, hash: resultHash(r), status: 'submitted', submittedAt: '2027-03-23T06:17:00Z', claimableFrom: '2027-04-22T06:17:00Z' };
}
function setup(opts = {}) {
  const state = { tokens: { [src]: (145500n * 10n ** 9n).toString() } };
  let t = new Date(opts.now || '2027-04-22T07:00:00Z');
  const nowFn = () => t;
  const connection = createMockConnection({ nowFn, state, failNextSends: opts.fail || 0, dropNextSends: opts.drop || 0 });
  const ledger = {};
  const results = { 1: submittedResult() };
  const run = (extra = {}) => runPayouts({ cfg: extra.cfg || cfg, results, ledger, connection, payer, now: nowFn, save: () => {}, log: () => {}, dryRun: extra.dryRun || false });
  return { state, ledger, results, connection, run, advance: (ms) => { t = new Date(t.getTime() + ms); } };
}
const dst = (w) => getAssociatedTokenAddressSync(mint, new PublicKey(w), true).toBase58();

test('pays the five winners their net amounts once the lock has passed', async () => {
  const s = setup();
  const sum = await s.run();
  assert.equal(sum.paid, 5);
  assert.deepEqual(sum.problems, []);
  assert.equal(s.state.tokens[dst(wallets[0])], '16975000000000');
  assert.equal(s.state.tokens[dst(wallets[4])], '4850000000000');
  assert.equal(s.state.tokens[src], ((145500n - 48500n) * 10n ** 9n).toString());
  assert.ok(Object.values(s.ledger).every((e) => e.status === 'paid'));
});

test('running again never pays twice', async () => {
  const s = setup();
  await s.run();
  const again = await s.run();
  assert.equal(again.paid, 0);
  assert.equal(s.connection.sent.length, 5);
});

test('nothing is sent before the 30-day lock ends', async () => {
  const s = setup({ now: '2027-04-21T23:59:00Z' });
  const sum = await s.run();
  assert.equal(s.connection.sent.length, 0);
  assert.equal(sum.paid, 0);
});

test('dry run sends nothing', async () => {
  const s = setup();
  const sum = await s.run({ dryRun: true });
  assert.equal(sum.planned.length, 5);
  assert.equal(s.connection.sent.length, 0);
});

test('a transfer that never lands is resent only after it has expired', async () => {
  const s = setup({ drop: 1 });
  await s.run();
  const first = Object.values(s.ledger).find((e) => e.status === 'sent');
  assert.ok(first, 'one transfer is left unconfirmed');
  await s.run(); // still within its blockhash lifetime: must not resend
  assert.equal(s.connection.sent.length, 5);
  s.advance(5 * 60e3); // blockhash expired
  await s.run(); // marks expired
  await s.run(); // resends
  assert.ok(Object.values(s.ledger).every((e) => e.status === 'paid'));
  assert.equal(s.state.tokens[dst(first.wallet)], first.amountUnits);
});

test('a rejected send is retried on the next run', async () => {
  const s = setup({ fail: 1 });
  const first = await s.run();
  assert.equal(first.paid, 4);
  assert.equal(first.problems.length, 1);
  const second = await s.run();
  assert.equal(second.paid, 1);
});

test('a tampered result is not paid', async () => {
  const s = setup();
  s.results[1].winners[0].wallet = wallets[1];
  const sum = await s.run();
  assert.equal(s.connection.sent.length, 0);
  assert.match(sum.problems[0], /does not match its hash/);
});

test('budget and per-transfer caps stop payouts', async () => {
  const s = setup();
  const tight = { ...cfg, payout: { ...cfg.payout, budgetDon: 40000 } };
  const sum = await s.run({ cfg: tight });
  assert.equal(s.connection.sent.length, 0);
  assert.match(sum.problems[0], /budget/);
  const s2 = setup();
  const small = { ...cfg, payout: { ...cfg.payout, maxSingleDon: 10000 } };
  const sum2 = await s2.run({ cfg: small });
  assert.equal(sum2.paid, 3);
  assert.equal(sum2.problems.length, 2);
});

test('wrong key is refused', async () => {
  const s = setup();
  const other = { ...cfg, payout: { ...cfg.payout, payoutWallet: wallets[0] } };
  await assert.rejects(() => s.run({ cfg: other }), /not to the configured payout wallet/);
});

test('keys load from a keypair file or a wallet export', async () => {
  const { loadKeypair, base58Encode } = await import('../src/payout.js');
  const kp = mockPayer();
  assert.equal(loadKeypair(JSON.stringify([...kp.secretKey])).publicKey.toBase58(), kp.publicKey.toBase58());
  assert.equal(loadKeypair(base58Encode(kp.secretKey)).publicKey.toBase58(), kp.publicKey.toBase58());
  assert.throws(() => loadKeypair('abc'), /64-byte/);
});
