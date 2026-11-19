// Thin client for the X API v2 (app-only bearer token), plus a mock for testing.
const BASE = 'https://api.x.com/2';
const TWEET_FIELDS = 'created_at,public_metrics,author_id,note_tweet,in_reply_to_user_id,referenced_tweets';
const USER_FIELDS = 'created_at,public_metrics,username,name';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export function createXClient({ token, fetchImpl = fetch, log = console.log } = {}) {
  if (!token) throw new Error('X_BEARER_TOKEN is not set. Add it as a repository secret.');
  let calls = 0;
  let resources = 0;

  async function get(path, params) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
      calls++;
      if (res.status === 429 && attempt < 3) {
        const reset = Number(res.headers.get('x-rate-limit-reset')) * 1000;
        const wait = Math.min(Math.max((reset || 0) - Date.now(), 5000), 15 * 60e3);
        log(`Rate limited on ${path}; waiting ${Math.round(wait / 1000)} s`);
        await sleep(wait);
        continue;
      }
      if (res.status >= 500 && attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`X API ${res.status} on ${path}: ${JSON.stringify(body).slice(0, 400)}`);
      resources += (body.data ? (Array.isArray(body.data) ? body.data.length : 1) : 0);
      return body;
    }
  }

  return {
    stats: () => ({ calls, resources }),

    async searchRecent(query, { startTime } = {}) {
      const posts = [];
      const users = new Map();
      let next;
      do {
        const b = await get('/tweets/search/recent', {
          query, max_results: 100, start_time: startTime, next_token: next,
          'tweet.fields': TWEET_FIELDS, expansions: 'author_id', 'user.fields': USER_FIELDS,
        });
        for (const p of b.data || []) posts.push(p);
        for (const u of b.includes?.users || []) users.set(u.id, u);
        next = b.meta?.next_token;
      } while (next);
      return { posts, users: [...users.values()] };
    },

    async lookupPosts(ids) {
      const out = [];
      for (const c of chunks(ids, 100)) {
        const b = await get('/tweets', { ids: c.join(','), 'tweet.fields': TWEET_FIELDS });
        out.push(...(b.data || []));
      }
      return out;
    },

    async lookupUsers(ids) {
      const out = [];
      for (const c of chunks(ids, 100)) {
        const b = await get('/users', { ids: c.join(','), 'user.fields': USER_FIELDS });
        out.push(...(b.data || []));
      }
      return out;
    },
  };
}

// Mock client: serves a generated dataset and lets metrics grow with post age,
// so the whole flow can be tested without an X key.
export function createMockClient(dataset, nowFn) {
  const userById = new Map(dataset.users.map((u) => [u.id, u]));
  const metricsAt = (p) => {
    const ageH = (nowFn() - new Date(p.created_at)) / 36e5;
    const f = Math.max(0, Math.min(1, ageH / 72));
    const m = {};
    for (const [k, v] of Object.entries(p.final_metrics)) m[k] = Math.round(v * f);
    return m;
  };
  const view = (p) => ({
    id: p.id, author_id: p.author_id, created_at: p.created_at, text: p.text,
    ...(p.in_reply_to_user_id ? { in_reply_to_user_id: p.in_reply_to_user_id } : {}),
    public_metrics: metricsAt(p),
  });
  const visible = (p) => new Date(p.created_at) <= nowFn() && !p.deleted;
  let calls = 0;
  return {
    stats: () => ({ calls, resources: 0 }),
    async searchRecent(query, { startTime } = {}) {
      calls++;
      const from = new Set([...query.matchAll(/from:(\w+)/g)].map((m) => m[1].toLowerCase()));
      const tag = (query.match(/#\w+/) || [''])[0].toLowerCase();
      const start = startTime ? new Date(startTime) : new Date(0);
      const posts = dataset.posts.filter((p) => {
        if (!visible(p) || new Date(p.created_at) < start) return false;
        const u = userById.get(p.author_id);
        if (from.size) return from.has(u.username.toLowerCase()) && !p.text.toLowerCase().includes('#doncreator');
        return tag && p.text.toLowerCase().includes(tag);
      });
      const users = [...new Set(posts.map((p) => p.author_id))].map((id) => userById.get(id));
      return { posts: posts.map(view), users };
    },
    async lookupPosts(ids) {
      calls++;
      const set = new Set(ids);
      return dataset.posts.filter((p) => set.has(p.id) && visible(p)).map(view);
    },
    async lookupUsers(ids) {
      calls++;
      const set = new Set(ids);
      return dataset.users.filter((u) => set.has(u.id));
    },
  };
}
