// Automatic payouts for the DON Creator Program.
//
// Model: after the Development Team converts the 150,000 DON once (the program deducts the
// conversion fee), the net DON sits in a dedicated, public payout wallet. This module sends
// each winner's net reward from that wallet straight to the winner's wallet once the
// 30-day lock has passed. Nothing is sent before then, so nothing can be sold before then.
//
// Safety:
//  - only results with status "submitted" whose SHA-256 hash still matches are paid
//  - every transfer is capped (maxSingleDon) and all transfers together are capped (budgetDon)
//  - the signature is stored BEFORE sending, so a crash can never lead to paying twice:
//    the next run looks the signature up and only resends once that transaction has expired
//  - dryRun prints the plan without sending anything
import {
  ComputeBudgetProgram, Keypair, PublicKey, Transaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
} from '@solana/spl-token';
import { resultHash, toUnits, fromUnits } from './score.js';
import { base58Decode } from './rules.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
  return s;
}

export function loadKeypair(secret) {
  if (!secret) throw new Error('PAYOUT_KEYPAIR is not set. Add the payout wallet key as a repository secret.');
  const s = secret.trim();
  let bytes;
  if (s.startsWith('[')) {
    // keypair file from solana-keygen: a JSON array of 64 numbers
    try { bytes = Uint8Array.from(JSON.parse(s)); } catch { throw new Error('PAYOUT_KEYPAIR looks like a JSON array but could not be read.'); }
  } else {
    // private key exported from Phantom or Solflare: one base58 string
    bytes = base58Decode(s);
  }
  if (!bytes || bytes.length !== 64) throw new Error('PAYOUT_KEYPAIR must be a 64-byte Solana private key (base58 text from your wallet, or the JSON array from a keypair file).');
  return Keypair.fromSecretKey(bytes);
}

const key = (n, rank) => `${n}-${rank}`;
const FINAL = new Set(['paid', 'failed']);

/**
 * results: { [n]: result object from results/period-N.json }
 * ledger:  db.state.payouts (mutated in place): { "n-rank": {status, sig, amountUnits, wallet, ...} }
 * save():  persists ledger + results to disk (called before every send)
 */
export async function runPayouts({ cfg, results, ledger, connection, payer, now, save, log = console.log, dryRun }) {
  const pc = cfg.payout;
  const decimals = cfg.decimals;
  const mint = new PublicKey(pc.mint);
  if (payer.publicKey.toBase58() !== pc.payoutWallet) {
    throw new Error(`The key in PAYOUT_KEYPAIR belongs to ${payer.publicKey.toBase58()}, not to the configured payout wallet ${pc.payoutWallet}.`);
  }
  const srcAta = getAssociatedTokenAddressSync(mint, payer.publicKey, true);
  const budget = toUnits(pc.budgetDon, decimals);
  const maxSingle = toUnits(pc.maxSingleDon, decimals);
  const summary = { paid: 0, sent: 0, planned: [], problems: [] };

  // 1. Reconcile transfers that were sent in an earlier run but not confirmed.
  const open = Object.entries(ledger).filter(([, e]) => e.status === 'sent');
  if (open.length) {
    const { value } = await connection.getSignatureStatuses(open.map(([, e]) => e.sig), { searchTransactionHistory: true });
    const height = await connection.getBlockHeight('confirmed');
    open.forEach(([k, e], i) => {
      const st = value[i];
      if (st && !st.err && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
        Object.assign(e, { status: 'paid', paidAt: now().toISOString() }); log(`Payout ${k}: confirmed (${e.sig}).`);
      } else if (st && st.err) {
        Object.assign(e, { status: 'failed', error: JSON.stringify(st.err) }); summary.problems.push(`${k} failed on-chain`);
      } else if (!st && height > e.lastValidBlockHeight) {
        Object.assign(e, { status: 'expired' }); log(`Payout ${k}: earlier attempt expired without landing; it will be sent again.`);
      }
    });
    save();
  }

  // 2. Work out what is due.
  const committed = Object.values(ledger).filter((e) => e.status === 'paid' || e.status === 'sent').reduce((s, e) => s + BigInt(e.amountUnits), 0n);
  const due = [];
  for (const p of cfg.periods) {
    const r = results[p.n];
    if (!r || r.status !== 'submitted' || !r.claimableFrom) continue;
    if (now() < new Date(r.claimableFrom)) continue;
    if (resultHash(r) !== r.hash) { summary.problems.push(`period ${p.n}: result file does not match its hash, not paying`); continue; }
    for (const w of r.winners) {
      const e = ledger[key(p.n, w.rank)];
      if (e && (FINAL.has(e.status) || e.status === 'sent')) continue;
      const amount = BigInt(w.netAmountUnits ?? w.amountUnits);
      let to;
      try { to = new PublicKey(w.wallet); } catch { summary.problems.push(`${key(p.n, w.rank)}: invalid wallet ${w.wallet}`); continue; }
      if (to.equals(payer.publicKey)) { summary.problems.push(`${key(p.n, w.rank)}: winner wallet is the payout wallet`); continue; }
      if (amount <= 0n || amount > maxSingle) { summary.problems.push(`${key(p.n, w.rank)}: amount ${fromUnits(amount, decimals)} DON is outside the allowed range`); continue; }
      due.push({ n: p.n, rank: w.rank, username: w.username, to, amount });
    }
  }
  const dueTotal = due.reduce((s, d) => s + d.amount, 0n);
  if (committed + dueTotal > budget) {
    summary.problems.push(`budget: paying ${fromUnits(dueTotal, decimals)} DON would exceed the ${pc.budgetDon} DON budget (already ${fromUnits(committed, decimals)}); nothing sent`);
    return finish();
  }
  if (!due.length) { log('Payouts: nothing due.'); return finish(); }

  // 3. Check balances before sending anything.
  const tokenBal = BigInt((await connection.getTokenAccountBalance(srcAta)).value.amount);
  const sol = await connection.getBalance(payer.publicKey);
  if (tokenBal < dueTotal) { summary.problems.push(`payout wallet holds ${fromUnits(tokenBal, decimals)} DON but ${fromUnits(dueTotal, decimals)} DON is due; nothing sent`); return finish(); }
  if (sol < pc.minSolLamports) { summary.problems.push(`payout wallet has ${sol / 1e9} SOL; at least ${pc.minSolLamports / 1e9} SOL is needed for fees; nothing sent`); return finish(); }

  // 4. Send one transfer per winner.
  for (const d of due) {
    const k = key(d.n, d.rank);
    const label = `${k} @${d.username} → ${d.to.toBase58()} : ${fromUnits(d.amount, decimals)} DON`;
    if (dryRun) { summary.planned.push(label); log(`DRY RUN, would send ${label}`); continue; }
    const dstAta = getAssociatedTokenAddressSync(mint, d.to, true);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight });
    if (pc.priorityMicroLamports) tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: pc.priorityMicroLamports }));
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, dstAta, d.to, mint),
      createTransferCheckedInstruction(srcAta, mint, dstAta, payer.publicKey, d.amount, decimals),
    );
    tx.sign(payer);
    const sig = base58Encode(tx.signature);
    const prev = ledger[k];
    ledger[k] = { status: 'sent', sig, lastValidBlockHeight, amountUnits: d.amount.toString(), amount: fromUnits(d.amount, decimals), wallet: d.to.toBase58(), username: d.username, sentAt: now().toISOString(), attempts: (prev?.attempts || 0) + 1 };
    save(); // the signature is on disk before the transaction leaves
    try {
      await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
    } catch (err) {
      // Preflight rejected it, so it cannot land. Safe to try again next run.
      Object.assign(ledger[k], { status: 'error', error: String(err.message || err).slice(0, 300) });
      summary.problems.push(`${k}: send rejected (${ledger[k].error})`);
      save();
      continue;
    }
    summary.sent++;
    try {
      const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      if (res.value.err) { Object.assign(ledger[k], { status: 'failed', error: JSON.stringify(res.value.err) }); summary.problems.push(`${k} failed on-chain`); }
      else { Object.assign(ledger[k], { status: 'paid', paidAt: now().toISOString() }); summary.paid++; log(`Paid ${label} (${sig})`); }
    } catch (err) {
      log(`Payout ${k}: not confirmed yet (${String(err.message || err).slice(0, 120)}); will check again next run.`);
    }
    save();
  }
  return finish();

  function finish() {
    for (const p of summary.problems) log('PAYOUT PROBLEM: ' + p);
    return summary;
  }
}
