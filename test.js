// End-to-end API test: node test.js  (starts its own server on a temp database)
const { spawn } = require('node:child_process'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const PORT = 3456, DBF = path.join(os.tmpdir(), 'forge-test-' + Date.now() + '.db'), base = 'http://localhost:' + PORT;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  FAIL:', m)); };
const call = async (p, body, tok) => { const r = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j }; };
const login = async (email) => (await call('/api/auth/login', { email, password: 'demo1234' })).j;
(async () => {
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DB_FILE: DBF }, stdio: 'pipe' });
  await new Promise(r => setTimeout(r, 1500));
  try {
    console.log('health / public state');
    ok((await call('/api/health')).j.forge === true, 'health');
    const pub = (await call('/api/state')).j;
    ok(pub.session === null && pub.users.length >= 15 && pub.collabs.length === 0 && pub.leads.length === 0, 'public state hides private data');
    ok(!JSON.stringify(pub).includes('demo.local') && !JSON.stringify(pub).includes('"pw"'), 'no emails/passwords leak');
    ok((await call('/api/sync', { changes: {} })).s === 401, 'sync needs login');

    console.log('auth');
    ok((await call('/api/auth/login', { email: 'brand@forge.demo', password: 'wrong' })).s === 401, 'wrong password rejected');
    const B = await login('brand@forge.demo'), C = await login('creator@forge.demo');
    ok(B.token && C.token && B.user.role === 'brand' && C.user.role === 'creator', 'demo logins');
    let bs = (await call('/api/state', null, B.token)).j, cs = (await call('/api/state', null, C.token)).j;
    ok(bs.collabs.every(c => c.brand === B.user.id) && bs.leads.length > 0, 'brand sees only own collabs/leads');
    ok(cs.collabs.every(c => c.creator === C.user.id) && cs.leads.length === 0, 'creator sees only own collabs');

    console.log('ownership + roles');
    const pid = 'proj' + Date.now().toString(36);
    let r = (await call('/api/sync', { changes: { projects: { up: [{ id: pid, title: 'Test film', cat: 'AI Video', desc: 'd', tools: 'Runway', stages: 'a → b', contrib: 'x', fmt: '16:9', license: 'tbd' }] } } }, C.token)).j;
    ok(!r.rejected.length && r.state.projects.some(p => p.id === pid && p.owner === C.user.id), 'creator adds project');
    r = (await call('/api/sync', { changes: { projects: { up: [{ id: 'brandproj1', title: 'Nope', cat: 'AI Video' }] } } }, B.token)).j;
    ok(r.rejected.length === 1, 'brand cannot add portfolio project');
    r = (await call('/api/sync', { changes: { projects: { up: [{ id: pid, title: 'Hijacked', cat: 'AI Video' }], } } }, B.token)).j;
    ok(r.rejected.length === 1 && r.state.projects.find(p => p.id === pid).title === 'Test film', "brand cannot edit creator's project");
    r = (await call('/api/sync', { changes: { projects: { del: [pid] } } }, B.token)).j;
    ok(r.rejected.length === 1 && r.state.projects.some(p => p.id === pid), "brand cannot delete creator's project");
    r = (await call('/api/sync', { changes: { users: { up: [{ id: B.user.id, name: 'Zest Footwear', role: 'creator', verified: 'verified' }] } } }, C.token)).j;
    ok(r.rejected.length === 1, "cannot edit another user's profile");
    r = (await call('/api/sync', { changes: { users: { up: [{ id: C.user.id, name: 'Rohan V', role: 'brand', verified: 'verified', charge: 45000 }] } } }, C.token)).j;
    const me = r.state.users.find(u => u.id === C.user.id);
    ok(me.name === 'Rohan V' && me.charge === 45000 && me.role === 'creator' && me.verified === 'none', 'role/verified cannot be self-edited');

    console.log('collab + payment flow');
    const cid = 'collab' + Date.now().toString(36);
    r = (await call('/api/sync', { changes: { collabs: { up: [{ id: cid, brand: B.user.id, creator: C.user.id, amt: 40000, brief: 'Teaser', status: 'Completed' }] } } }, B.token)).j;
    let cb = r.state.collabs.find(c => c.id === cid);
    ok(cb && cb.status === 'Requested', 'new collab is forced to Requested');
    r = (await call('/api/sync', { changes: { collabs: { up: [{ id: cid, status: 'Completed' }] } } }, B.token)).j;
    ok(r.rejected.length === 1, 'brand cannot skip to Completed');
    r = (await call('/api/sync', { changes: { collabs: { up: [{ id: cid, status: 'Accepted' }] } } }, B.token)).j;
    ok(r.rejected.length === 1, 'brand cannot accept on behalf of creator');
    r = (await call('/api/sync', { changes: { collabs: { up: [{ id: cid, status: 'Accepted' }] } } }, C.token)).j;
    ok(!r.rejected.length, 'creator accepts');
    r = (await call('/api/sync', { changes: { collabs: { up: [{ id: cid, status: 'Funded' }] }, pay: { up: [{ id: 'fakepay01', collab: cid, brand: B.user.id, creator: C.user.id, amt: 1, fee: 0, status: 'Released' }] } } }, B.token)).j;
    let pays = r.state.pay.filter(p => p.collab === cid);
    ok(pays.length === 1 && pays[0].status === 'Held' && pays[0].amt === 40000 && pays[0].fee === 4000, 'funding creates a server-side Held payment (client-made payment ignored)');
    r = (await call('/api/sync', { changes: { pay: { up: [{ id: pays[0].id, status: 'Paid out' }] } } }, C.token)).j;
    ok(r.state.pay.find(p => p.id === pays[0].id).status === 'Held', 'creator cannot withdraw held money');
    r = (await call('/api/sync', { changes: { collabs: { up: [{ id: cid, status: 'Delivered' }] } } }, C.token)).j;
    ok(!r.rejected.length, 'creator delivers');
    r = (await call('/api/sync', { changes: { collabs: { up: [{ id: cid, status: 'Completed' }] } } }, B.token)).j;
    ok(r.state.pay.find(p => p.collab === cid).status === 'Released', 'approval releases payment');
    r = (await call('/api/sync', { changes: { pay: { up: [{ id: pays[0].id, status: 'Paid out' }] } } }, B.token)).j;
    ok(r.state.pay.find(p => p.id === pays[0].id).status === 'Released', 'brand cannot mark payout');
    r = (await call('/api/sync', { changes: { pay: { up: [{ id: pays[0].id, status: 'Paid out' }] } } }, C.token)).j;
    ok(r.state.pay.find(p => p.id === pays[0].id).status === 'Paid out', 'creator payout works');

    console.log('growth, shortlist, views');
    r = (await call('/api/sync', { kv: { growth: [{ id: 'g1abcdef', date: '2026-10-01', sent: 20, seen: 30, fg: 4 }] } }, C.token)).j;
    ok(r.rejected.length === 1, 'seen > sent rejected');
    r = (await call('/api/sync', { kv: { growth: [{ id: 'g1abcdef', date: '2026-10-01', sent: 20, seen: 9, fg: 4 }] } }, C.token)).j;
    ok(!r.rejected.length && r.state.growth[C.user.id].length === 1, 'growth saved per user');
    r = (await call('/api/sync', { kv: { short: [C.user.id] } }, C.token)).j;
    ok(r.rejected.length === 1, 'creator cannot shortlist');
    r = (await call('/api/sync', { kv: { short: [C.user.id] } }, B.token)).j;
    ok(r.state.short[B.user.id].includes(C.user.id), 'brand shortlist saved');
    await call('/api/view', { kind: 'views', id: C.user.id }, B.token);
    ok((await call('/api/state')).j.views[C.user.id] === 1, 'profile view counted');

    console.log('phone signup (demo OTP)');
    ok((await call('/api/otp/request', { phone: '12345' })).s === 400, 'bad phone rejected');
    const phone = '9' + String(Date.now()).slice(-9);
    ok((await call('/api/auth/register', { phone, profile: { name: 'New Person', role: 'creator', gender: 'Other', spec: 'Animation' } })).s === 401, 'register needs verified phone');
    const o = (await call('/api/otp/request', { phone })).j;
    ok((await call('/api/otp/verify', { phone, code: '000000' })).s === 400, 'wrong OTP rejected');
    const v = (await call('/api/otp/verify', { phone, code: o.demo_code })).j;
    ok(v.exists === false, 'new number verified');
    const reg = await call('/api/auth/register', { phone, profile: { name: 'New Person', role: 'creator', gender: 'Other', spec: 'Animation', skills: ['animation'] } });
    ok(reg.s === 200 && reg.j.user.name === 'New Person' && reg.j.user.verified === 'none', 'registered');
    const o2 = (await call('/api/otp/request', { phone })).j, v2 = (await call('/api/otp/verify', { phone, code: o2.demo_code })).j;
    ok(v2.exists === true && v2.token && v2.user.name === 'New Person', 'phone login works');
    await call('/api/auth/logout', {}, v2.token);
    ok((await call('/api/state', null, v2.token)).j.session === null, 'logout invalidates token');
    ok((await call('/api/sync', { changes: {} }, 'a'.repeat(64))).s === 401, 'forged token rejected');

    console.log('static + safety');
    const idx = await fetch(base + '/'); ok(idx.status === 200 && (await idx.text()).includes('Forge'), 'serves the app');
    for (const u of ['/..%2fserver.js', '/%2e%2e/server.js', '/..%2f..%2fetc%2fpasswd', '/public/../server.js']) { const t = await fetch(base + u).then(x => x.text()); ok(!t.includes('DatabaseSync') && !t.includes('root:'), 'no path traversal via ' + u); }
  } catch (e) { fail++; console.log('TEST ERROR', e); }
  srv.kill(); try { fs.rmSync(DBF); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
