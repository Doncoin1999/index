// Rule checks on a single post, and Solana wallet parsing for registrations.

const norm = (s) => (s || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ');

export function postText(p) {
  return p.note_tweet?.text || p.text || '';
}

export function checkPost(text, cfg) {
  const r = cfg.rules;
  const t = norm(text);
  const reasons = [];
  if (r.requireProjectMention) {
    const keys = [...cfg.projectKeywords, '@' + cfg.projectHandle].map(norm);
    if (!keys.some((k) => t.includes(k))) reasons.push('no_project_mention');
  }
  if (r.requireAdLabel && !r.adLabels.some((l) => hasTag(t, norm(l)))) reasons.push('missing_ad_label');
  if (r.requireDisclaimer && !r.disclaimerKeywords.every((k) => t.includes(norm(k)))) reasons.push('missing_disclaimer');
  const banned = r.bannedPhrases.filter((b) => t.includes(norm(b)));
  if (banned.length) reasons.push('banned_phrase:' + banned.join('|'));
  return reasons;
}

// "#ad" must not match "#adventure"; plain phrases match anywhere.
function hasTag(t, label) {
  if (!label.startsWith('#')) return t.includes(label);
  const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w])');
  return re.test(t);
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(s) {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of s) { if (ch === '1') bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}

export function findWallet(text) {
  for (const m of text.matchAll(/[1-9A-HJ-NP-Za-km-z]{32,44}/g)) {
    const b = base58Decode(m[0]);
    if (b && b.length === 32) return m[0];
  }
  return null;
}
