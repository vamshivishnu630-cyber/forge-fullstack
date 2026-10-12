'use strict';
// Forge backend: zero npm dependencies. Needs Node 22.5+ (built-in node:sqlite).
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'forge.db');
const PUB = path.join(__dirname, 'public');
const SESSION_DAYS = 7, FEE = 0.1;
const CATS = ['AI Video', 'Animation', 'Image Generation', '3D', 'Advertising'];
const STG = ['Found', 'Contacted', 'Replied', 'Negotiating', 'Signed'];

const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, email TEXT UNIQUE, phone TEXT UNIQUE, salt TEXT, hash TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, uid TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS docs(coll TEXT NOT NULL, id TEXT NOT NULL, owner TEXT, body TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(coll, id));
CREATE INDEX IF NOT EXISTS docs_owner ON docs(coll, owner);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, action TEXT, detail TEXT, at TEXT DEFAULT CURRENT_TIMESTAMP);
`);

// ---------- data helpers ----------
const q = {
  get: db.prepare('SELECT body FROM docs WHERE coll=? AND id=?'),
  put: db.prepare("INSERT INTO docs(coll,id,owner,body) VALUES(?,?,?,?) ON CONFLICT(coll,id) DO UPDATE SET owner=excluded.owner, body=excluded.body, updated_at=CURRENT_TIMESTAMP"),
  del: db.prepare('DELETE FROM docs WHERE coll=? AND id=?'),
  all: db.prepare('SELECT body FROM docs WHERE coll=? ORDER BY updated_at, id'),
  count: db.prepare('SELECT COUNT(*) n FROM docs WHERE coll=? AND owner=?'),
  kget: db.prepare('SELECT body FROM kv WHERE k=?'),
  kput: db.prepare('INSERT INTO kv(k,body) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET body=excluded.body'),
  audit: db.prepare('INSERT INTO audit(uid,action,detail) VALUES(?,?,?)'),
};
const get = (c, id) => { const r = q.get.get(c, id); return r ? JSON.parse(r.body) : null; };
const put = (c, id, owner, o) => q.put.run(c, id, owner || null, JSON.stringify(o));
const all = c => q.all.all(c).map(r => JSON.parse(r.body));
const kget = (k, d) => { const r = q.kget.get(k); return r ? JSON.parse(r.body) : d; };
const kput = (k, v) => q.kput.run(k, JSON.stringify(v));
const audit = (uid, action, detail) => q.audit.run(uid || null, action, String(detail || '').slice(0, 300));
const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const newId = () => crypto.randomBytes(6).toString('hex');
const today = () => new Date().toISOString().slice(0, 10);

// ---------- auth ----------
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
function startSession(uid) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,uid,expires) VALUES(?,?,?)').run(token, uid, Date.now() + SESSION_DAYS * 864e5);
  return token;
}
function authUser(req) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const s = db.prepare('SELECT uid, expires FROM sessions WHERE token=?').get(m[1]);
  if (!s) return null;
  if (s.expires < Date.now()) { db.prepare('DELETE FROM sessions WHERE token=?').run(m[1]); return null; }
  return get('users', s.uid);
}
const otps = new Map(); // phone -> {code, exp, tries, verified, sent[]}
const hits = new Map(); // rate limiting: key -> [timestamps]
function limited(key, max, ms) {
  const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < ms);
  if (a.length >= max) { hits.set(key, a); return true; }
  a.push(now); hits.set(key, a); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < 36e5)) hits.delete(k); for (const [k, o] of otps) if (o.exp < now) otps.delete(k); }, 6e4).unref();

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m, s = 400) => { throw new HttpError(s, m); };

// ---------- validation ----------
const S = (v, n) => String(v ?? '').trim().slice(0, n);
const num = (v, max = 1e9) => { v = +v; return Number.isFinite(v) && v >= 0 && v <= max ? v : null; };
const list = (a, n, len) => Array.isArray(a) ? a.slice(0, n).map(x => S(x, len)).filter(Boolean) : [];
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const idOk = s => typeof s === 'string' && /^[a-z0-9]{6,24}$/.test(s);

// ---------- state visible to a user ----------
function stateFor(me) {
  const id = me && me.id, party = x => id && (x.brand === id || x.creator === id);
  return {
    session: id || null,
    users: all('users'),
    projects: all('projects'),
    briefs: all('briefs').filter(b => b.status === 'Published' || b.owner === id),
    collabs: all('collabs').filter(party),
    pay: all('pay').filter(party),
    leads: id ? all('leads').filter(x => x.owner === id) : [],
    growth: id ? { [id]: kget('growth:' + id, []) } : {},
    short: id ? { [id]: kget('short:' + id, []) } : {},
    views: kget('views', {}), pviews: kget('pviews', {}),
  };
}

// ---------- write rules (all authorization lives here) ----------
const H = {
  users: {
    up(me, d) {
      must(d.id === me.id, 'You can only edit your own profile');
      const u = get('users', me.id);
      if (d.name !== undefined) { u.name = S(d.name, 60); must(u.name.length >= 2, 'Name is too short'); }
      for (const k of ['spec', 'bio', 'company', 'avail', 'ig']) if (d[k] !== undefined) u[k] = S(d[k], k === 'bio' ? 500 : 60);
      for (const k of ['tools', 'skills']) if (d[k] !== undefined) u[k] = list(d[k], 20, 40);
      if (d.location !== undefined) u.location = S(d.location, 60);
      if (d.languages !== undefined) u.languages = list(d.languages, 8, 30);
      if (d.content !== undefined) u.content = list(d.content, 5, 30).filter(x => CATS.includes(x));
      for (const k of ['rate', 'followers', 'charge', 'experience']) if (d[k] !== undefined) { const n = num(d[k]); must(n !== null, 'Invalid ' + k); u[k] = n; }
      put('users', me.id, me.id, u);
    },
  },
  projects: {
    up(me, d) {
      must(idOk(d.id), 'Bad id');
      const ex = get('projects', d.id);
      if (ex) must(ex.owner === me.id, 'Not your project');
      else { must(me.role === 'creator', 'Only creators can add portfolio projects'); must(q.count.get('projects', me.id).n < 50, 'Project limit reached'); }
      const title = S(d.title, 120); must(title, 'Title is required'); must(CATS.includes(d.cat), 'Invalid category');
      put('projects', d.id, me.id, { id: d.id, owner: me.id, title, cat: d.cat, desc: S(d.desc, 2000), tools: S(d.tools, 300), stages: S(d.stages, 600), contrib: S(d.contrib, 300), fmt: S(d.fmt, 40), license: S(d.license, 300), date: ex ? ex.date : today(), ...(['cube', 'torus', 'sphere'].includes(d.reel) ? { reel: d.reel } : {}) });
    },
    del(me, id) { const ex = get('projects', id); if (!ex) return; must(ex.owner === me.id, 'Not your project'); q.del.run('projects', id); },
  },
  briefs: {
    up(me, d) {
      must(idOk(d.id), 'Bad id');
      const ex = get('briefs', d.id);
      if (ex) must(ex.owner === me.id, 'Not your brief');
      else { must(me.role === 'brand', 'Only brands can create briefs'); must(q.count.get('briefs', me.id).n < 100, 'Brief limit reached'); }
      const title = S(d.title, 120), desc = S(d.desc, 3000); must(title && desc, 'Title and concept are required');
      must(CATS.includes(d.cat), 'Invalid category'); must(['Draft', 'Published'].includes(d.status), 'Invalid status');
      const budget = d.budget === '' || d.budget == null ? '' : num(d.budget); must(budget !== null, 'Invalid budget');
      put('briefs', d.id, me.id, { id: d.id, owner: me.id, status: d.status, title, cat: d.cat, desc, tools: S(d.tools, 300), skills: S(d.skills, 300), budget, deadline: S(d.deadline, 10), fmt: S(d.fmt, 40), usage: S(d.usage, 30), territory: S(d.territory, 30), duration: S(d.duration, 30), excl: S(d.excl, 30) });
    },
    del(me, id) { const ex = get('briefs', id); if (!ex) return; must(ex.owner === me.id, 'Not your brief'); q.del.run('briefs', id); },
  },
  leads: {
    up(me, d) {
      must(idOk(d.id), 'Bad id');
      const ex = get('leads', d.id);
      if (ex) must(ex.owner === me.id, 'Not your lead'); else must(me.role === 'brand', 'Only brands can track leads');
      must(STG.includes(d.stage), 'Invalid stage');
      const name = S(d.name, 80); must(name, 'Name is required');
      put('leads', d.id, me.id, { id: d.id, owner: me.id, name, platform: S(d.platform, 40), note: S(d.note, 200), stage: d.stage });
    },
    del(me, id) { const ex = get('leads', id); if (!ex) return; must(ex.owner === me.id, 'Not your lead'); q.del.run('leads', id); },
  },
  collabs: {
    up(me, d) {
      must(idOk(d.id), 'Bad id');
      const ex = get('collabs', d.id);
      if (!ex) { // create
        must(me.role === 'brand' && d.brand === me.id, 'Only brands can request collabs');
        const c = get('users', d.creator); must(c && c.role === 'creator', 'Creator not found');
        const amt = num(d.amt, 1e8); must(amt > 0, 'Enter a valid amount');
        const brief = S(d.brief, 1000); must(brief, 'Describe the deliverables');
        put('collabs', d.id, me.id, { id: d.id, brand: me.id, creator: d.creator, amt, brief, status: 'Requested', date: today() });
        audit(me.id, 'collab.create', d.id); return;
      }
      const from = ex.status, to = d.status;
      if (to === from || to === undefined) return; // other field edits are ignored
      const asCreator = me.id === ex.creator, asBrand = me.id === ex.brand;
      const ok = (asCreator && ((from === 'Requested' && ['Accepted', 'Declined'].includes(to)) || (from === 'Funded' && to === 'Delivered')))
              || (asBrand && ((from === 'Accepted' && to === 'Funded') || (from === 'Delivered' && to === 'Completed')));
      must(ok, `You cannot move a collab from ${from} to ${to}`);
      ex.status = to; put('collabs', ex.id, ex.brand, ex);
      if (to === 'Funded') { const pid = newId(); put('pay', pid, ex.brand, { id: pid, collab: ex.id, brand: ex.brand, creator: ex.creator, amt: ex.amt, fee: Math.round(ex.amt * FEE), status: 'Held', date: today() }); }
      if (to === 'Completed') for (const p of all('pay')) if (p.collab === ex.id && p.status === 'Held') { p.status = 'Released'; put('pay', p.id, p.brand, p); }
      audit(me.id, 'collab.' + to, ex.id);
    },
  },
  pay: { // payments are created and released by the server; the only client action is a payout request
    up(me, d) {
      const ex = get('pay', d.id);
      if (!ex || d.status !== 'Paid out') return;
      if (me.id === ex.creator && ex.status === 'Released') { ex.status = 'Paid out'; put('pay', ex.id, ex.brand, ex); audit(me.id, 'payout', ex.id); }
    },
  },
};

function applyChanges(me, ch, kv) {
  const rejected = [];
  tx(() => {
    for (const coll of ['users', 'projects', 'briefs', 'leads', 'collabs', 'pay']) {
      const c = ch && ch[coll]; if (!c || !H[coll]) continue;
      for (const d of (Array.isArray(c.up) ? c.up : []).slice(0, 200)) { try { H[coll].up(me, d || {}); } catch (e) { rejected.push({ coll, id: d && d.id, reason: e.message }); } }
      for (const id of (Array.isArray(c.del) ? c.del : []).slice(0, 200)) { try { if (H[coll].del) H[coll].del(me, String(id)); else rejected.push({ coll, id, reason: 'Deleting is not allowed' }); } catch (e) { rejected.push({ coll, id, reason: e.message }); } }
    }
    if (kv && Array.isArray(kv.growth)) {
      try {
        must(kv.growth.length <= 500, 'Too many growth entries');
        const g = kv.growth.map(e => { const sent = num(e.sent, 1e7), seen = num(e.seen, 1e7), fg = num(e.fg, 1e7); must(idOk(e.id) && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && sent !== null && seen !== null && fg !== null, 'Invalid growth entry'); must(seen <= sent, 'DMs seen cannot exceed DMs sent'); return { id: e.id, date: e.date, sent, seen, fg }; });
        kput('growth:' + me.id, g);
      } catch (e) { rejected.push({ coll: 'growth', reason: e.message }); }
    }
    if (kv && Array.isArray(kv.short)) {
      try {
        must(me.role === 'brand', 'Only brands can shortlist'); must(kv.short.length <= 200, 'Shortlist too long');
        const ids = [...new Set(kv.short.map(String))].filter(id => { const u = get('users', id); return u && u.role === 'creator'; });
        kput('short:' + me.id, ids);
      } catch (e) { rejected.push({ coll: 'short', reason: e.message }); }
    }
  });
  return rejected;
}

// ---------- routes ----------
const PHONE = /^[6-9]\d{9}$/;
const routes = {
  'GET /api/health': () => ({ forge: true, time: new Date().toISOString() }),
  'GET /api/state': (req, body, me) => stateFor(me),
  'POST /api/otp/request'(req, b) {
    const phone = S(b.phone, 10); if (!PHONE.test(phone)) bad('Enter a valid 10-digit mobile number');
    if (limited('otp:' + phone, 5, 6e5) || limited('otpip:' + req.ip, 20, 6e5)) bad('Too many requests. Try again in a few minutes.', 429);
    const code = String(crypto.randomInt(100000, 1000000));
    otps.set(phone, { code, exp: Date.now() + 3e5, tries: 0, verified: false });
    // DEMO MODE: no SMS provider is connected, so the code is returned to the page.
    // For production, send `code` through an SMS provider (MSG91, Twilio, ...) and remove demo_code.
    return { sent: true, demo: true, demo_code: code };
  },
  'POST /api/otp/verify'(req, b) {
    const phone = S(b.phone, 10), o = otps.get(phone);
    if (!o || o.exp < Date.now()) bad('Code expired. Request a new one.');
    if (++o.tries > 5) { otps.delete(phone); bad('Too many attempts. Request a new code.', 429); }
    if (S(b.code, 6) !== o.code) bad('Incorrect code');
    o.verified = true; o.exp = Date.now() + 9e5;
    const acc = db.prepare('SELECT id FROM accounts WHERE phone=?').get(phone);
    if (!acc) return { exists: false };
    return { exists: true, token: startSession(acc.id), user: get('users', acc.id) };
  },
  'POST /api/auth/register'(req, b) {
    const phone = S(b.phone, 10), o = otps.get(phone), p = b.profile || {};
    if (!o || !o.verified || o.exp < Date.now()) bad('Verify your phone number first', 401);
    if (db.prepare('SELECT 1 FROM accounts WHERE phone=?').get(phone)) bad('This number already has an account', 409);
    const name = S(p.name, 60); if (name.length < 2) bad('Enter your full name');
    if (!['creator', 'brand'].includes(p.role)) bad('Choose a role');
    const kind = p.role === 'creator' ? 'Creator' : p.kind === 'Agency' ? 'Agency' : 'Business';
    if (!['Male', 'Female', 'Other'].includes(p.gender)) bad('Choose a gender');
    const company = S(p.company, 60); if (p.role === 'brand' && company.length < 2) bad('Enter your company name');
    const skills = list(p.skills, 10, 40), spec = CATS.includes(p.spec) ? p.spec : '';
    if (p.role === 'creator' && !spec) bad('Pick what you create');
    const id = newId();
    tx(() => {
      db.prepare('INSERT INTO accounts(id,phone) VALUES(?,?)').run(id, phone);
      put('users', id, id, { id, name, role: p.role, kind, gender: p.gender, company, spec, skills, tools: [], bio: '', avail: 'Available', rate: 0, followers: 0, charge: 0, verified: 'none' });
      audit(id, 'register', p.role);
    });
    otps.delete(phone);
    return { token: startSession(id), user: get('users', id) };
  },
  'POST /api/auth/login'(req, b) {
    const email = S(b.email, 120).toLowerCase(), pw = String(b.password || '');
    if (limited('login:' + req.ip, 15, 6e5) || limited('loginu:' + email, 8, 6e5)) bad('Too many attempts. Try again later.', 429);
    const a = db.prepare('SELECT id, salt, hash FROM accounts WHERE email=?').get(email);
    let ok = false;
    if (a && a.hash) { const h = Buffer.from(hashPw(pw, a.salt), 'hex'), e = Buffer.from(a.hash, 'hex'); ok = h.length === e.length && crypto.timingSafeEqual(h, e); }
    else hashPw(pw, 'x'.repeat(16)); // equalise timing for unknown emails
    if (!ok) bad('Incorrect email or password', 401);
    return { token: startSession(a.id), user: get('users', a.id) };
  },
  'POST /api/auth/logout'(req) { const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || ''); if (m) db.prepare('DELETE FROM sessions WHERE token=?').run(m[1]); return { ok: true }; },
  'POST /api/sync'(req, b, me) {
    if (!me) bad('Please log in', 401);
    const rejected = applyChanges(me, b.changes, b.kv);
    return { state: stateFor(get('users', me.id)), rejected };
  },
  'POST /api/view'(req, b, me) {
    if (!me) bad('Please log in', 401);
    if (b.kind === 'views') { const u = get('users', b.id); if (!u || u.role !== 'creator' || u.id === me.id) return { ok: true }; const v = kget('views', {}); v[u.id] = (v[u.id] || 0) + 1; kput('views', v); }
    else if (b.kind === 'pviews') { const p = get('projects', b.id); if (!p || p.owner === me.id) return { ok: true }; const v = kget('pviews', {}); v[p.id] = (v[p.id] || 0) + 1; kput('pviews', v); }
    else bad('Unknown counter');
    return { ok: true };
  },
};
const AUTH_REQUIRED = new Set(['POST /api/sync', 'POST /api/view']);

// ---------- http server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'",
};
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { ...SEC, 'Content-Type': isObj ? 'application/json' : 'text/plain', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 1e6) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(new HttpError(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });
}
const server = http.createServer(async (req, res) => {
  req.ip = req.socket.remoteAddress;
  const url = new URL(req.url, 'http://x'), key = req.method + ' ' + url.pathname;
  try {
    if (url.pathname.startsWith('/api/')) {
      const h = routes[key]; if (!h) return send(res, 404, { error: 'Not found' });
      const body = req.method === 'POST' ? await readBody(req) : {};
      const me = authUser(req);
      if (AUTH_REQUIRED.has(key) && !me) return send(res, 401, { error: 'Please log in' });
      return send(res, 200, h(req, body, me), { 'Cache-Control': 'no-store' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let f = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    if (!f.startsWith(PUB + path.sep) && f !== PUB) return send(res, 403, 'Forbidden');
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
    res.writeHead(200, { ...SEC, 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error('Server error:', e.message); // never log tokens, passwords or request bodies
    send(res, 500, { error: 'Something went wrong on the server' });
  }
});

// ---------- first-run demo data ----------
function seed() {
  if (db.prepare("SELECT COUNT(*) n FROM docs WHERE coll='users'").get().n > 0) return;
  const f = path.join(__dirname, 'seed.json'); if (!fs.existsSync(f)) return;
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  tx(() => {
    for (const u of s.users) {
      const id = u.id, demoLogin = u.pw === 'plain', email = demoLogin ? u.email : null;
      const salt = crypto.randomBytes(16).toString('hex');
      db.prepare('INSERT INTO accounts(id,email,salt,hash) VALUES(?,?,?,?)').run(id, email, salt, demoLogin ? hashPw('demo1234', salt) : null);
      const { email: _e, phone: _p, pw: _w, ...pub } = u; put('users', id, id, pub);
    }
    for (const p of s.projects) put('projects', p.id, p.owner, p);
    for (const b of s.briefs) put('briefs', b.id, b.owner, b);
    for (const c of s.collabs) put('collabs', c.id, c.brand, c);
    for (const p of s.pay) put('pay', p.id, p.brand, p);
    for (const l of s.leads) put('leads', l.id, l.owner, l);
    for (const [k, v] of Object.entries(s.growth || {})) kput('growth:' + k, v);
    for (const [k, v] of Object.entries(s.short || {})) kput('short:' + k, v);
  });
  console.log('Loaded demo data (sample accounts: brand@forge.demo and creator@forge.demo, password demo1234)');
}
function seedExtra() { // additive: adds the second demo batch (Vamshi, 20 creators, portfolios, collabs) once
  if (kget('extra_v1', false)) return;
  const f = path.join(__dirname, 'seed_extra.json'); if (!fs.existsSync(f)) return;
  let j = fs.readFileSync(f, 'utf8'); const byName = {};
  for (const u of all('users')) byName[u.name] = u.id;
  const names = ['Zest Footwear', 'Lumen Beauty', 'Nova Games']; if (!names.every(n => byName[n])) return;
  for (const n of names) j = j.split('@' + n).join(byName[n]);
  const s = JSON.parse(j);
  tx(() => {
    for (const u of s.users) {
      if (get('users', u.id)) continue;
      const demoLogin = u.pw === 'plain', salt = crypto.randomBytes(16).toString('hex');
      db.prepare('INSERT OR IGNORE INTO accounts(id,email,salt,hash) VALUES(?,?,?,?)').run(u.id, demoLogin ? u.email : null, salt, demoLogin ? hashPw('demo1234', salt) : null);
      const { email: _e, phone: _p, pw: _w, ...pub } = u; put('users', u.id, u.id, pub);
    }
    const add = (c, a, owner) => { for (const x of a) if (!get(c, x.id)) put(c, x.id, x[owner], x); };
    add('projects', s.projects, 'owner'); add('briefs', s.briefs, 'owner'); add('collabs', s.collabs, 'brand'); add('pay', s.pay, 'brand');
    for (const [k, v2] of Object.entries(s.growth || {})) if (!q.kget.get('growth:' + k)) kput('growth:' + k, v2);
    kput('extra_v1', true);
  });
  console.log('Added extra demo data: Vamshi (vamshi@forge.demo / demo1234), 20 creators, portfolios, collabs');
}
seed(); seedExtra();
db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
if (require.main === module) server.listen(PORT, () => console.log(`Forge running at http://localhost:${PORT}`));
module.exports = { server, db };
