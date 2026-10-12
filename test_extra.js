// Tests for the second demo batch (Vamshi + 20 creators) and the new profile fields. Run: node test_extra.js
const { spawn } = require('node:child_process'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const PORT = 3461, DBF = path.join(os.tmpdir(), 'forge-extra-' + Date.now() + '.db'), base = 'http://localhost:' + PORT;
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log('  FAIL:', m)); };
const call = async (p, body, tok) => { const r = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j }; };
const start = () => spawn('node', ['server.js'], { env: { ...process.env, PORT, DB_FILE: DBF }, stdio: 'pipe' });
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let srv = start(); await wait(1800);
  try {
    const pub = (await call('/api/state')).j;
    ok(pub.users.length >= 40, 'users seeded: ' + pub.users.length);
    const v = pub.users.find(u => u.name === 'Vamshi Krishna');
    ok(v && v.spec === '3D Animation' && v.tools.includes('Blender') && v.content.includes('3D') && v.languages.includes('Telugu') && v.location === 'Hyderabad' && v.experience === 4, 'Vamshi has full profile attributes');
    ok(pub.users.filter(u => u.id.startsWith('creator')).length === 20, '20 extra creators');
    ok(pub.users.filter(u => u.id.startsWith('creator')).every(u => u.skills.length === 4 && u.tools.length === 4 && u.content.length >= 1 && u.languages.length >= 2 && u.location && u.experience >= 1 && u.charge > 0), 'extra creators have varied, complete attributes');
    ok(new Set(pub.users.filter(u => u.id.startsWith('creator')).map(u => u.skills.join())).size > 10, 'skills are varied across creators');
    const vp = pub.projects.filter(p => p.owner === 'vamshi01');
    ok(vp.length === 3 && vp.every(p => ['cube', 'torus', 'sphere'].includes(p.reel) && p.stages.includes('→')), 'Vamshi portfolio stored in database with demo reels');
    ok(pub.projects.length >= 32 + 43, 'portfolio projects in DB: ' + pub.projects.length);
    ok(pub.collabs.length === 0 && !JSON.stringify(pub).includes('vamshi@forge.demo'), 'public state hides collabs and emails');
    const V = (await call('/api/auth/login', { email: 'vamshi@forge.demo', password: 'demo1234' })).j;
    ok(V.token && V.user.name === 'Vamshi Krishna', 'Vamshi can log in');
    const st = (await call('/api/state', null, V.token)).j;
    ok(st.collabs.length === 7 && st.collabs.every(c => c.creator === 'vamshi01'), 'Collaboration Hub has 7 collabs for Vamshi: ' + st.collabs.length);
    const by = {}; st.collabs.forEach(c => by[c.status] = (by[c.status] || 0) + 1);
    ok(by.Completed === 2 && by.Funded === 1 && by.Delivered === 1 && by.Requested === 1 && by.Accepted === 1 && by.Declined === 1, 'collabs cover every stage ' + JSON.stringify(by));
    ok(st.pay.some(p => p.status === 'Paid out') && st.pay.some(p => p.status === 'Released') && st.pay.filter(p => p.status === 'Held').length === 2, 'payments ledger has paid-out, released and held rows');
    ok(st.growth.vamshi01.length === 10, 'growth log seeded');
    ok(st.collabs.every(c => st.users.some(u => u.id === c.brand && u.role === 'brand')), 'every collab links to a real brand');
    // new profile fields are editable by the owner and validated by the server
    let r = (await call('/api/sync', { changes: { users: { up: [{ id: 'vamshi01', location: 'Warangal', experience: 5, languages: ['Telugu', 'English'], content: ['3D', 'Not a type', 'Animation'], role: 'brand' }] } } }, V.token)).j;
    const me = r.state.users.find(u => u.id === 'vamshi01');
    ok(me.location === 'Warangal' && me.experience === 5 && me.languages.length === 2 && me.content.join() === '3D,Animation' && me.role === 'creator', 'profile fields saved, invalid content type dropped, role protected');
    r = (await call('/api/sync', { changes: { users: { up: [{ id: 'vamshi01', experience: -3 }] } } }, V.token)).j;
    ok(r.rejected.length === 1, 'negative experience rejected');
    // a brand sees the new creators/collabs it is party to, never Vamshi-only data from other brands
    const B = (await call('/api/auth/login', { email: 'brand@forge.demo', password: 'demo1234' })).j;
    const bs = (await call('/api/state', null, B.token)).j;
    ok(bs.collabs.every(c => c.brand === B.user.id) && bs.collabs.some(c => c.creator === 'vamshi01'), 'brand sees only its own collabs (incl. the Vamshi one)');
    // restart on the same database: no duplicates, data persists
    srv.kill(); await wait(600); srv = start(); await wait(1800);
    const again = (await call('/api/state')).j;
    ok(again.users.length === pub.users.length && again.projects.length === pub.projects.length, 'restart keeps data and does not duplicate it');
    const V2 = (await call('/api/auth/login', { email: 'vamshi@forge.demo', password: 'demo1234' })).j;
    ok((await call('/api/state', null, V2.token)).j.users.find(u => u.id === 'vamshi01').location === 'Warangal', 'edit persisted across restart');
  } catch (e) { fail++; console.log('TEST ERROR', e); }
  srv.kill(); try { fs.rmSync(DBF); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
