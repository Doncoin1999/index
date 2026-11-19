// Deterministic fake creators and posts for testing the ranker without an X key.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function wallet(r) {
  let n = 0n;
  for (let i = 0; i < 32; i++) n = n * 256n + BigInt(Math.floor(r() * 256) || 1);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  return s;
}

const GOOD = 'Playing DONCOIN daily on Solana — check in at doncoin.app 🎮 #ad DON is a game token for entertainment, not an investment.';

const PROFILES = [
  // username, followers, account age (days), register offset (days), post every N days, base impressions, engagement rate, quirks
  ['solana_sam', 48000, 2000, 1, 3, 9000, 0.05, {}],
  ['nordicnodes', 9000, 900, 3, 2, 3000, 0.07, {}],
  ['chain_walker', 210000, 3000, 2, 4, 40000, 0.012, {}],
  ['lina_plays', 18000, 700, 10, 2, 5000, 0.08, {}],
  ['daily_degen', 75000, 1500, 5, 2, 15000, 0.04, { sometimesNoAd: 0.4, sometimesBanned: 0.15 }],
  ['botfarm_alpha', 30000, 1200, 4, 1, 6000, 0.45, {}],            // bought engagement -> high flag
  ['fresh_account', 25000, 60, 2, 2, 7000, 0.05, {}],              // account too new
  ['tiny_voice', 600, 1500, 2, 2, 800, 0.08, {}],                   // too few followers
  ['tokentalk_no', 6000, 1000, 150, 3, 2500, 0.07, {}],             // joins in April 2027
  ['crypto_kari', 120000, 2500, 20, 3, 25000, 0.03, { changesWallet: 200, deletesSome: 0.1 }],
  ['late_starter', 15000, 800, 240, 2, 4000, 0.06, {}],             // joins in July 2027
  ['quiet_quinn', 11000, 900, 7, 9, 2000, 0.05, { noDisclaimer: 1 }], // never adds the disclaimer
];

export function makeDataset(cfg) {
  const start = new Date(cfg.periods[0].start).getTime();
  const end = new Date(cfg.periods.at(-1).end).getTime();
  const users = [], posts = [];
  let pid = 1000;
  PROFILES.forEach(([username, followers, ageDays, regOff, every, imp, rate, q], i) => {
    const r = rng(i * 7919 + 17);
    const id = String(100 + i);
    users.push({ id, username, name: username, created_at: new Date(start - ageDays * 864e5).toISOString(), public_metrics: { followers_count: followers, following_count: 300, tweet_count: 5000 } });
    const reg = start + regOff * 864e5 + 3600e3 * 10;
    posts.push({ id: String(pid++), author_id: id, created_at: new Date(reg).toISOString(), text: `Joining the DON Creator Program ${cfg.registrationHashtag} wallet: ${wallet(r)}`, final_metrics: { impression_count: 100, like_count: 3, retweet_count: 0, reply_count: 0, quote_count: 0 } });
    if (q.changesWallet) posts.push({ id: String(pid++), author_id: id, created_at: new Date(start + q.changesWallet * 864e5).toISOString(), text: `New wallet for ${cfg.registrationHashtag}: ${wallet(r)}`, final_metrics: { impression_count: 50, like_count: 1, retweet_count: 0, reply_count: 0, quote_count: 0 } });
    for (let t = reg + 864e5; t < end + 5 * 864e5; t += every * 864e5 * (0.7 + r() * 0.6)) {
      const growth = 1 + (t - start) / (end - start);
      const im = Math.round(imp * growth * (0.5 + r()));
      const eng = im * rate * (0.6 + r() * 0.8);
      let text = GOOD;
      if (q.sometimesNoAd && r() < q.sometimesNoAd) text = text.replace(' #ad', '');
      if (q.sometimesBanned && r() < q.sometimesBanned) text = text.replace('🎮', '🎮 This goes to the moon!');
      if (q.noDisclaimer) text = 'Playing DONCOIN daily at doncoin.app #ad';
      posts.push({
        id: String(pid++), author_id: id, created_at: new Date(t).toISOString(), text,
        deleted: q.deletesSome ? r() < q.deletesSome : false,
        final_metrics: { impression_count: im, like_count: Math.round(eng * 0.75), retweet_count: Math.round(eng * 0.12), reply_count: Math.round(eng * 0.09), quote_count: Math.round(eng * 0.04) },
      });
    }
  });
  return { users, posts };
}
