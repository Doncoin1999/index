// Hand-off to the Solana program. The Creator module does not exist yet, so this is a
// clearly marked stub: with onchain.enabled = false the bot only writes payouts/period-N.csv.
//
// When the module is deployed, implement submitRanking() to send
//   submit_ranking(period: u8, winners: [Pubkey; <=5], result_hash: [u8; 32])
// signed with the ranker key from the RANKER_KEYPAIR secret. The program itself must check:
// the signer is the ranker, the period has ended, it has not been submitted before,
// every winner is a registered creator, and the amounts follow the fixed shares.

export async function submitRanking(cfg, result) {
  if (!cfg.onchain?.enabled) {
    return { skipped: true, reason: 'On-chain Creator module not enabled; pay out from the CSV in payouts/.' };
  }
  throw new Error('onchain.enabled is true, but submitRanking() is not implemented yet. Wire it up to the Creator module IDL.');
}
