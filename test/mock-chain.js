// A tiny stand-in for a Solana RPC node, so payouts can be tested without a network.
// It really decodes and signature-checks the transactions the payout module builds.
import fs from 'node:fs';
import path from 'node:path';
import { Keypair, Transaction, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const enc = (bytes) => { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of bytes) { if (b === 0) s = '1' + s; else break; } return s; };

export function createMockConnection({ nowFn, state, persist = () => {}, failNextSends = 0, dropNextSends = 0 }) {
  state.tokens ||= {};
  state.txs ||= {};
  let fail = failNextSends, drop = dropNextSends;
  const height = () => Math.floor(nowFn().getTime() / 400);
  const conn = {
    sent: [],
    async getBlockHeight() { return height(); },
    async getLatestBlockhash() {
      const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = Math.floor(Math.random() * 256);
      return { blockhash: enc(b), lastValidBlockHeight: height() + 150 };
    },
    async getTokenAccountBalance(ata) { return { value: { amount: String(state.tokens[ata.toBase58()] || '0') } }; },
    async getBalance() { return 1e9; },
    async getSignatureStatuses(sigs) {
      return { value: sigs.map((s) => (state.txs[s] ? { err: null, confirmationStatus: 'finalized' } : null)) };
    },
    async sendRawTransaction(raw) {
      const tx = Transaction.from(raw);
      if (!tx.verifySignatures()) throw new Error('signature verification failed');
      if (fail > 0) { fail--; throw new Error('Simulated preflight failure'); }
      const sig = enc(tx.signature);
      conn.sent.push(sig);
      if (drop > 0) { drop--; return sig; } // accepted by RPC but never lands
      const ix = tx.instructions.find((i) => i.data.length === 10 && i.data[0] === 12); // TransferChecked
      const amount = ix.data.readBigUInt64LE(1);
      const [src, , dst] = ix.keys.map((k) => k.pubkey.toBase58());
      const bal = BigInt(state.tokens[src] || 0);
      if (bal < amount) throw new Error('insufficient funds');
      state.tokens[src] = (bal - amount).toString();
      state.tokens[dst] = (BigInt(state.tokens[dst] || 0) + amount).toString();
      state.txs[sig] = { amount: amount.toString(), dst };
      persist();
      return sig;
    },
    async confirmTransaction({ signature }) {
      if (state.txs[signature]) return { value: { err: null } };
      throw new Error('block height exceeded');
    },
  };
  return conn;
}

export const mockPayer = () => Keypair.fromSeed(new Uint8Array(32).fill(7));

// Used by cli.js when PAYOUT_MOCK points at this file: state is kept in a file so a
// day-by-day simulation in separate processes sees one consistent chain.
export function makeMockChain(cfg, nowFn) {
  const payer = mockPayer();
  const file = path.join(process.env.RANKER_OUT_DIR || '/tmp', 'mock-chain.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new chain */ }
  const srcAta = getAssociatedTokenAddressSync(new PublicKey(cfg.payout.mint), payer.publicKey, true).toBase58();
  state.tokens ||= {};
  if (state.tokens[srcAta] === undefined) state.tokens[srcAta] = (145500n * 10n ** 9n).toString();
  const connection = createMockConnection({ nowFn, state, persist: () => fs.writeFileSync(file, JSON.stringify(state, null, 2)) });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
  return { connection, payer, srcAta, file };
}
