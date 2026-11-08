// Prop Tracker model: runs on GitHub after every line pull.
// 1) evaluates both sides of every pick'em prop that a sportsbook also prices,
// 2) saves each recommendation with its pregame odds and projection (locked at game start),
// 3) grades finished picks from ESPN box-score game logs, and
// 4) refits the probability calibration from its own graded history.
// Writes model.json (for the site), tracker.json (model performance), calib.json (calibration data).
const fs = require('fs');
const BE = 0.5503;                  // per-leg break-even of a 3-pick 6x entry
const PLAY_EV = 0.06, LEAN_EV = 0.03;
const CACHE_DIR = '.cache';
const now = Date.now();
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const wr = (f, o) => fs.writeFileSync(f, JSON.stringify(o));
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------------- stats definitions ----------------
const ALIAS = { NCAAB: 'NBA', WNBA: 'NBA', NCAAF: 'NFL' };
const LG = { NBA: ['basketball', 'nba'], WNBA: ['basketball', 'wnba'], NCAAB: ['basketball', 'mens-college-basketball'], NFL: ['football', 'nfl'], NCAAF: ['football', 'college-football'], NHL: ['hockey', 'nhl'] };
const STAT = {
  NBA: { 'Points': ['points'], 'Rebounds': ['totalRebounds'], 'Assists': ['assists'], 'Steals': ['steals'], 'Blocks': ['blocks'], 'Turnovers': ['turnovers'],
    '3-Pointers': ['threePointFieldGoalsMade'], 'PRA': ['points', 'totalRebounds', 'assists'], 'Pts+Rebs': ['points', 'totalRebounds'], 'Pts+Asts': ['points', 'assists'],
    'Rebs+Asts': ['totalRebounds', 'assists'], 'Blks+Stls': ['blocks', 'steals'] },
  NHL: { 'Shots on Goal': ['shotsTotal'], 'Goals': ['goals'], 'Assists': ['assists'], 'Points': ['points'], 'Power Play Points': ['powerPlayGoals', 'powerPlayAssists'] },
  NFL: { 'Receptions': ['receptions'], 'Rec Yards': ['receivingYards'], 'Rush Yards': ['rushingYards'], 'Rush Attempts': ['rushingAttempts'], 'Rush+Rec Yards': ['rushingYards', 'receivingYards'],
    'Pass Yards': ['passingYards'], 'Pass TDs': ['passingTouchdowns'], 'Pass Attempts': ['passingAttempts'], 'Completions': ['completions'], 'Interceptions': ['interceptions'] }
};
const COUNT = /^(Shots on Goal|Goals|Assists|Points|Power Play Points|Steals|Blocks|Turnovers|3-Pointers|Blks\+Stls|Receptions|Pass TDs|Interceptions|Rebounds)$/;
const base = sp => ALIAS[sp] || sp;
const supported = (sp, st) => !!(STAT[base(sp)] && STAT[base(sp)][st] && LG[sp]);
function oppCol(sp, st) {
  sp = base(sp);
  if (sp === 'NBA') return 'minutes';
  if (sp === 'NHL') return 'timeOnIcePerGame';
  if (/Receptions|Rec Yards/.test(st)) return 'receivingTargets';
  if (/^Rush (Yards|Attempts)$/.test(st)) return 'rushingAttempts';
  if (/^Pass (Yards|TDs)$|Completions|Interceptions/.test(st)) return 'passingAttempts';
  return null;
}
function num(s) { s = String(s == null ? '' : s); if (/^\d+:\d{2}$/.test(s)) { const p = s.split(':'); return Number(p[0]) + Number(p[1]) / 60; } const v = Number(s.replace(/[^0-9.\-]/g, '')); return s !== '' && isFinite(v) ? v : null; }
function col(gl, g, name) {
  const want = name.toLowerCase();
  for (let i = 0; i < gl.names.length; i++) {
    const parts = gl.names[i].split(/[-\/]/);
    for (let p = 0; p < parts.length; p++) if (parts[p].toLowerCase() === want) {
      const raw = String(g.stats[i] == null ? '' : g.stats[i]);
      return num(/^\d+:\d{2}$/.test(raw) ? raw : raw.split(/[-\/]/)[parts.length > 1 ? p : 0]);
    }
  }
  return null;
}
function valueOf(gl, g, sp, st) { let t = 0; for (const c of STAT[base(sp)][st]) { const v = col(gl, g, c); if (v == null) return null; t += v; } return t; }

// ---------------- distributions ----------------
function lgam(x) { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (let j = 0; j < 6; j++) s += c[j] / ++y; return -t + Math.log(2.5066282746310005 * s / x); }
function nbPmf(k, mu, v) { if (v <= mu * 1.0001) return Math.exp(k * Math.log(mu) - mu - lgam(k + 1)); const r = mu * mu / (v - mu), p = r / (r + mu); return Math.exp(lgam(k + r) - lgam(r) - lgam(k + 1) + r * Math.log(p) + k * Math.log(1 - p)); }
function Phi(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }
function sides(line, mu, v, count) {
  const whole = Math.abs(line - Math.round(line)) < 1e-9, k0 = whole ? line : Math.ceil(line);
  if (count && mu < 15) { let cdf = 0; for (let k = 0; k < k0; k++) cdf += nbPmf(k, mu, v); const pk = whole ? nbPmf(k0, mu, v) : 0; return { under: cdf, push: pk, over: Math.max(0, 1 - cdf - pk) }; }
  const sd = Math.sqrt(v);
  if (whole) { const o = 1 - Phi((line + 0.5 - mu) / sd), u = Phi((line - 0.5 - mu) / sd); return { over: o, under: u, push: Math.max(0, 1 - o - u) }; }
  const ov = 1 - Phi((k0 - 0.5 - mu) / sd); return { over: ov, under: 1 - ov, push: 0 };
}

// ---------------- projection from the game log (games before `before` only) ----------------
function project(gl, sp, st, before) {
  if (!gl) return { err: 'no game log found' };
  if (!supported(sp, st)) return { err: 'no free stats source for this market' };
  const oc = oppCol(sp, st), games = [];
  for (const g of gl.games) {
    if (before && !(g.date < before)) continue;
    const v = valueOf(gl, g, sp, st); if (v == null) continue;
    const e = oc ? col(gl, g, oc) : null;
    if (/^(NBA|NHL)$/.test(base(sp)) && !(e > 0)) continue;     // did not play
    games.push({ v, e, date: g.date });
    if (games.length === 20) break;
  }
  const n = games.length, minN = base(sp) === 'NFL' ? 5 : 8;
  if (n < minN) return { err: 'only ' + n + ' games played this season', n };
  let sw = 0, sw2 = 0, sv = 0, se = 0;
  games.forEach((g, i) => { const w = Math.pow(0.5, i / 8); sw += w; sw2 += w * w; sv += w * g.v; if (g.e != null) se += w * g.e; });
  const avg = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const mean = sv / sw, flags = []; let mu = mean;
  if (oc && se > 0 && games.every(g => g.e != null)) {
    const e5 = avg(games.slice(0, 5).map(g => g.e)), e20 = avg(games.map(g => g.e));
    mu = (sv / se) * (0.6 * e5 + 0.4 * se / sw);
    const tr = e5 / e20 - 1, lbl = { minutes: 'minutes', timeOnIcePerGame: 'ice time', receivingTargets: 'targets', rushingAttempts: 'carries', passingAttempts: 'pass attempts' }[oc];
    if (Math.abs(tr) >= 0.15) flags.push((tr > 0 ? 'more ' : 'fewer ') + lbl + ' lately (' + (tr > 0 ? '+' : '') + Math.round(tr * 100) + '% over last 5)');
  }
  mu = Math.max(mu, 0.05);
  let s2 = 0; games.forEach((g, i) => { s2 += Math.pow(0.5, i / 8) * Math.pow(g.v - mean, 2); }); s2 /= sw;
  const count = COUNT.test(st), nEff = sw * sw / sw2;
  const v = Math.max(s2, count ? mu * 1.05 : Math.max(mu, Math.pow(0.15 * mu, 2))) + s2 / nEff;
  return { mu, v, n, count, games, flags, l5: avg(games.slice(0, 5).map(g => g.v)), l10: avg(games.slice(0, 10).map(g => g.v)), l20: avg(games.map(g => g.v)) };
}

// ---------------- market ----------------
const ip = o => { o = Number(o); if (!isFinite(o) || !o) return null; return o < 0 ? -o / (-o + 100) : 100 / (o + 100); };
function devig(po, pu) { if (!(po > 0) || !(pu > 0)) return null; if (po + pu <= 1.0001) return po / (po + pu); let lo = 1, hi = 4; for (let i = 0; i < 40; i++) { const k = (lo + hi) / 2; if (Math.pow(po, k) + Math.pow(pu, k) > 1) lo = k; else hi = k; } const k = (lo + hi) / 2, a = Math.pow(po, k), b = Math.pow(pu, k); return a / (a + b); }
const W2 = b => /pinnacle/i.test(b) ? 3 : /fanduel/i.test(b) ? 1.5 : /draftkings/i.test(b) ? 1.2 : 0.6;
const SB = /^(Pinnacle|DraftKings|FanDuel|BetMGM|Caesars|ESPN BET|BetRivers|Fanatics|bet365)$/i;
const placeholder = r => String(r.over) === String(r.under) && /^-(113|137)$/.test(String(r.over));
function market(books) {
  let w = 0, s = 0, pin = false; const used = [];
  for (const y of books) { if (placeholder(y)) continue; const v = devig(ip(y.over), ip(y.under)); if (v == null) continue; const k = W2(y.book); w += k; s += v * k; if (/pinnacle/i.test(y.book)) pin = true; used.push(y.book + ' ' + y.over + '/' + y.under); }
  if (!w) return null;
  return { over: s / w, q: pin ? 'sharp' : used.length >= 2 ? 'multi' : 'single', books: used };
}
const lg = p => Math.log(p / (1 - p)), sg = z => 1 / (1 + Math.exp(-z)), cl = p => Math.min(0.98, Math.max(0.02, p));

// ---------------- calibration (refit from graded history) ----------------
const calib = rd('calib.json', { rows: [], a: 0.006, b: 0.764, fitN: 2796, fitAt: '2026-11-08 backtest' });
function refit() {
  const rows = calib.rows.filter(r => now - Date.parse(r.d) < 60 * 86400000);
  if (rows.length < 1500) return;
  let w = [calib.a, calib.b];
  for (let it = 0; it < 30; it++) {
    let g0 = 0, g1 = 0, h00 = 1e-6, h01 = 0, h11 = 1e-6;
    for (const r of rows) { const x = lg(cl(r.p)), p = sg(w[0] + w[1] * x), e = p - r.y, q = p * (1 - p); g0 += e; g1 += e * x; h00 += q; h01 += q * x; h11 += q * x * x; }
    const det = h00 * h11 - h01 * h01; w = [w[0] - (h11 * g0 - h01 * g1) / det, w[1] - (h00 * g1 - h01 * g0) / det];
  }
  calib.a = Math.max(-0.3, Math.min(0.3, w[0])); calib.b = Math.max(0.5, Math.min(1.1, w[1])); calib.fitN = rows.length; calib.fitAt = new Date(now).toISOString();
}
const pCal = pm => sg(calib.a + calib.b * lg(cl(pm)));

// ---------------- evaluation of one pick'em line ----------------
function evaluate(o) {
  const out = { flags: [], sides: {} };
  if (!o.mkt) { out.grade = 'Pass'; out.flags.push('no sportsbook prices this exact line'); return out; }
  const pr = o.pr;
  if (!pr || pr.err) { out.grade = 'Pass'; out.flags.push(pr && pr.err ? pr.err : 'no game log'); }
  const pOver = pCal(o.mkt.over);
  let sOver = null;
  if (pr && !pr.err) { const s = sides(o.line, pr.mu, pr.v, pr.count); sOver = s.over / ((s.over + s.under) || 1); out.flags.push(...pr.flags); }
  out.pBooks = o.mkt.over; out.pCal = pOver; out.pStats = sOver;
  if (sOver != null && Math.abs(sOver - o.mkt.over) >= 0.15) out.flags.push('game logs and books disagree (' + Math.round(sOver * 100) + '% vs ' + Math.round(o.mkt.over * 100) + '% over)');
  for (const sd of ['Over', 'Under']) {
    const m = o.pay[sd]; if (m == null) continue;
    const p = sd === 'Over' ? pOver : 1 - pOver, ps = sOver == null ? null : sd === 'Over' ? sOver : 1 - sOver;
    const l5 = pr && pr.games ? pr.games.slice(0, 5) : [], hits5 = l5.filter(g => sd === 'Over' ? g.v > o.line : g.v < o.line).length;
    const ev = p * m / BE - 1, evS = ps == null ? null : ps * m / BE - 1, why = [];
    let grade = ev >= PLAY_EV ? 'Play' : ev >= LEAN_EV ? 'Lean' : 'Pass';
    if (ev < LEAN_EV) why.push('no edge after the payout (' + (ev >= 0 ? '+' : '') + (ev * 100).toFixed(1) + '%)');
    if (evS == null) { if (grade !== 'Pass') why.push('no game-log check possible'); grade = 'Pass'; }
    else if (evS < 0 && grade !== 'Pass') { why.push('game logs do not support it (' + Math.round(ps * 100) + '%)'); grade = 'Pass'; }
    if (l5.length === 5 && hits5 <= 1 && grade !== 'Pass') { why.push('lost ' + (5 - hits5) + ' of the last 5'); grade = 'Pass'; }
    if (pr && pr.n < 10 && grade === 'Play') grade = 'Lean';
    if (sOver != null && Math.abs(sOver - o.mkt.over) >= 0.15 && grade === 'Play') { grade = 'Lean'; why.push('capped at Lean: stats and books far apart'); }
    if (o.mkt.q === 'single' && grade === 'Play') grade = 'Lean';
    if (o.inj === 'out') { why.unshift('player listed out'); grade = 'Pass'; }
    if (o.inj === 'q' && grade === 'Play') { why.push('questionable'); grade = 'Lean'; }
    out.sides[sd] = { grade, pay: m, p, pStats: ps, pBooksSide: sd === 'Over' ? o.mkt.over : 1 - o.mkt.over, ev, evStats: evS, hits5, why };
  }
  const ranked = Object.keys(out.sides).sort((a, b) => out.sides[b].ev - out.sides[a].ev);
  out.side = ranked[0] || null;
  out.grade = out.side ? out.sides[out.side].grade : 'Pass';
  return out;
}

// ---------------- ESPN game logs and injuries (free) ----------------
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z]/g, '');
async function getJ(u) { for (let t = 0; t < 3; t++) { try { const r = await fetch(u, { headers: { 'User-Agent': 'prop-tracker' } }); if (r.ok) return await r.json(); if (r.status === 404) return null; } catch (e) {} await new Promise(z => setTimeout(z, 500 * (t + 1))); } return null; }
function idFrom(j, player, sp) {
  const lgs = LG[sp][1], found = [];
  (function walk(o) { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) { o.forEach(walk); return; } const uid = String(o.uid || ''), nm = o.displayName || o.name || ''; const m = uid.match(/a:(\d+)/); if (m && nm) found.push({ id: m[1], name: nm, league: String(o.defaultLeagueSlug || o.league || uid) }); Object.keys(o).forEach(k => { if (typeof o[k] === 'object') walk(o[k]); }); })(j);
  const ex = found.filter(f => norm(f.name) === norm(player)); const inL = ex.filter(f => f.league.indexOf(lgs) >= 0);
  return (inL[0] || ex[0] || {}).id || null;
}
function parseGL(j) {
  const names = (j.names || []).map(String), ev = j.events || {}, out = [], seen = {};
  (j.seasonTypes || []).forEach(st => { if (/preseason/i.test(st.displayName || '')) return; (st.categories || []).forEach(cat => (cat.events || []).forEach(e => { if (!e || !e.stats || seen[e.eventId]) return; seen[e.eventId] = 1; const inf = ev[e.eventId] || {}; out.push({ date: String(inf.gameDate || '').slice(0, 10), stats: e.stats.map(String) }); })); });
  out.sort((a, b) => b.date.localeCompare(a.date)); return { names, games: out };
}
const ids = rd(CACHE_DIR + '/ids.json', {});
async function gameLog(sp, player, fresh) {
  const ik = sp + '|' + norm(player);
  let id = ids[ik];
  if (id === undefined || (id && id.miss && now - id.at > 86400000)) {
    const s = await getJ('https://site.web.api.espn.com/apis/search/v2?limit=10&type=player&query=' + encodeURIComponent(player));
    const got = s ? idFrom(s, player, sp) : null; ids[ik] = got || { miss: 1, at: now }; id = ids[ik];
  }
  if (!id || id.miss) return null;
  const f = CACHE_DIR + '/gl_' + sp + '_' + id + '.json', c = rd(f, null);
  if (c && !fresh && now - c.t < 6 * 3600000) return c.g;
  const j = await getJ('https://site.web.api.espn.com/apis/common/v3/sports/' + LG[sp][0] + '/' + LG[sp][1] + '/athletes/' + id + '/gamelog');
  if (!j) return c ? c.g : null;
  const g = parseGL(j); wr(f, { t: now, g }); return g;
}
async function injuries(sp) {
  const j = await getJ('https://site.api.espn.com/apis/site/v2/sports/' + LG[sp][0] + '/' + LG[sp][1] + '/injuries');
  const m = {}; if (!j) return m;
  (j.injuries || []).forEach(t => (t.injuries || []).forEach(x => { const nm = x.athlete && x.athlete.displayName, s = String(x.status || '').toLowerCase(); if (nm) m[norm(nm)] = /out|doubtful|injured reserve|suspend/.test(s) ? 'out' : /question|day-to-day/.test(s) ? 'q' : ''; }));
  return m;
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = items[i++]; try { await fn(k); } catch (e) {} } })); }

// ---------------- main ----------------
(async () => {
  const L = rd('lines.json', { rows: [] }).rows || [];
  const tracker = rd('tracker.json', { picks: {} });
  const pending = rd('calib_pending.json', {});
  const isApp = b => /^(Underdog|PrizePicks)$/.test(b);
  // sportsbook prices by exact line
  const books = new Map();
  for (const x of L) if (SB.test(x.book) && x.type === 'Standard') { const k = [x.sport, x.game, x.player, x.stat, x.line].join('|'); (books.get(k) || books.set(k, []).get(k)).push(x); }
  const cand = L.filter(x => isApp(x.book) && (x.type === 'Standard' || /^Payout x/.test(x.type)) && LG[x.sport] && Date.parse(x.start) > now && Date.parse(x.start) < now + 36 * 3600000);
  // game logs for everyone who has a priced line
  const need = [...new Set(cand.filter(x => books.has([x.sport, x.game, x.player, x.stat, x.line].join('|')) && supported(x.sport, x.stat)).map(x => x.sport + '|' + x.player))];
  const GL = {};
  await pool(need, 10, async k => { const [sp, pl] = k.split('|'); GL[k] = await gameLog(sp, pl); });
  const INJ = {}; for (const sp of [...new Set(cand.map(x => x.sport))]) INJ[sp] = await injuries(sp);
  // evaluate
  const verdicts = {}, board = [];
  for (const x of cand) {
    const bk = books.get([x.sport, x.game, x.player, x.stat, x.line].join('|'));
    const mkt = bk ? market(bk) : null;
    const mult = /^Payout x/.test(x.type) ? Number(x.type.split('x')[1]) : 1;
    const pay = { Over: null, Under: null };
    if (x.sides === 'O') pay.Over = mult; else if (x.sides === 'U') pay.Under = mult; else { pay.Over = 1; pay.Under = 1; }
    const before = new Date(Date.parse(x.start)).toISOString().slice(0, 10);
    const pr = supported(x.sport, x.stat) ? project(GL[x.sport + '|' + x.player], x.sport, x.stat, before) : { err: 'no free stats source for this market' };
    const ev = evaluate({ line: Number(x.line), pr, mkt, pay, inj: (INJ[x.sport] || {})[norm(x.player)] || '' });
    for (const sd of Object.keys(ev.sides)) {
      const s = ev.sides[sd];
      const key = [x.sport, x.player, x.stat, x.line, x.book, sd].join('|');
      verdicts[key] = [s.grade, +(s.ev * 100).toFixed(1), Math.round(s.p * 100), s.pStats == null ? null : Math.round(s.pStats * 100), s.why.concat(ev.flags).slice(0, 3).join(' · ')];
      if (s.grade !== 'Pass') board.push({ sport: x.sport, game: x.game, start: x.start, player: x.player, stat: x.stat, line: Number(x.line), app: x.book, side: sd, pay: s.pay, grade: s.grade,
        ev: +(s.ev * 100).toFixed(1), p: +(s.p * 100).toFixed(1), pBooks: +(s.pBooksSide * 100).toFixed(1), pStats: s.pStats == null ? null : +(s.pStats * 100).toFixed(1), evStats: s.evStats == null ? null : +(s.evStats * 100).toFixed(1),
        mu: pr && pr.mu != null ? +pr.mu.toFixed(2) : null, l5: pr && pr.l5 != null ? +pr.l5.toFixed(1) : null, l10: pr && pr.l10 != null ? +pr.l10.toFixed(1) : null, l20: pr && pr.l20 != null ? +pr.l20.toFixed(1) : null,
        n: pr && pr.n, hits5: s.hits5, books: mkt ? mkt.books.join(', ') : '', flags: s.why.concat(ev.flags) });
    }
    if (!ev.side && !Object.keys(ev.sides).length) verdicts[[x.sport, x.player, x.stat, x.line, x.book, 'any'].join('|')] = ['Pass', null, null, null, ev.flags.join(' · ')];
    // calibration data: one row per prop (books' pregame over price), graded later
    if (mkt) { const pk = [x.sport, x.player, x.stat, x.line, before].join('|'); pending[pk] = { p: +mkt.over.toFixed(4), sport: x.sport, player: x.player, stat: x.stat, line: Number(x.line), start: x.start }; }
  }
  board.sort((a, b) => (b.grade === 'Play') - (a.grade === 'Play') || b.ev - a.ev);
  // track every recommendation; the last pregame version is what counts
  const seenNow = new Set();
  for (const r of board) {
    const id = [r.start.slice(0, 10), r.sport, r.player, r.stat, r.line, r.app, r.side].join('|'); seenNow.add(id);
    const t = tracker.picks[id];
    if (t && Date.parse(t.start) <= now) continue;
    tracker.picks[id] = Object.assign({ firstSeen: t ? t.firstSeen : new Date(now).toISOString(), firstGrade: t ? t.firstGrade : r.grade, firstEV: t ? t.firstEV : r.ev }, r, { status: 'open', lastSeen: new Date(now).toISOString() });
  }
  for (const id of Object.keys(tracker.picks)) {   // a pick that fell to Pass (or vanished) before the game is withdrawn
    const t = tracker.picks[id]; if (t.status !== 'open' || seenNow.has(id) || Date.parse(t.start) <= now) continue;
    const vk = [t.sport, t.player, t.stat, t.line, t.app, t.side].join('|');
    if (verdicts[vk] || cand.length) { t.status = 'withdrawn'; t.withdrawnAt = new Date(now).toISOString(); t.withdrawnWhy = verdicts[vk] ? verdicts[vk][4] : 'line came off the board'; }
  }
  // grade finished games
  const due = Object.values(tracker.picks).filter(t => t.status === 'open' && Date.parse(t.start) < now - 3.5 * 3600000);
  const dueCal = Object.entries(pending).filter(([k, v]) => Date.parse(v.start) < now - 3.5 * 3600000);
  const players = [...new Set(due.map(t => t.sport + '|' + t.player).concat(dueCal.map(([k, v]) => v.sport + '|' + v.player)))].filter(k => LG[k.split('|')[0]]);
  const FR = {}; await pool(players, 10, async k => { const [sp, pl] = k.split('|'); FR[k] = await gameLog(sp, pl, true); });
  const actualOf = (sp, pl, st, start) => {
    const gl = FR[sp + '|' + pl]; if (!gl || !supported(sp, st)) return undefined;
    const d0 = start.slice(0, 10), d1 = new Date(Date.parse(start) + 86400000).toISOString().slice(0, 10);
    const g = gl.games.find(z => z.date === d0) || gl.games.find(z => z.date === d1);
    if (!g) return undefined;
    const oc = oppCol(sp, st), e = oc ? col(gl, g, oc) : null;
    if (/^(NBA|NHL)$/.test(base(sp)) && !(e > 0)) return null;   // did not play
    return valueOf(gl, g, sp, st);
  };
  for (const t of due) {
    const a = actualOf(t.sport, t.player, t.stat, t.start);
    if (a === undefined) { if (now - Date.parse(t.start) > 48 * 3600000) { t.status = 'graded'; t.result = 'No data'; t.units = 0; } continue; }
    t.status = 'graded'; t.gradedAt = new Date(now).toISOString();
    if (a === null) { t.result = 'DNP'; t.units = 0; continue; }
    t.actual = a;
    t.result = a === t.line ? 'Push' : (t.side === 'Over' ? a > t.line : a < t.line) ? 'Win' : 'Loss';
    t.units = t.result === 'Win' ? +(t.pay / BE - 1).toFixed(3) : t.result === 'Loss' ? -1 : 0;
  }
  for (const [k, v] of dueCal) {
    const a = actualOf(v.sport, v.player, v.stat, v.start);
    if (a === undefined) { if (now - Date.parse(v.start) > 48 * 3600000) delete pending[k]; continue; }
    delete pending[k]; if (a === null || a === v.line) continue;
    calib.rows.push({ d: v.start.slice(0, 10), s: v.sport, p: v.p, y: a > v.line ? 1 : 0 });
  }
  calib.rows = calib.rows.filter(r => now - Date.parse(r.d) < 90 * 86400000);
  refit();
  // summary of model performance
  const g = Object.values(tracker.picks).filter(t => t.status === 'graded' && /Win|Loss|Push/.test(t.result));
  const sum = arr => { const w = arr.filter(t => t.result === 'Win').length, l = arr.filter(t => t.result === 'Loss').length; const u = arr.reduce((s, t) => s + (t.units || 0), 0); return { picks: arr.length, wins: w, losses: l, hit: w + l ? +(w / (w + l) * 100).toFixed(1) : null, units: +u.toFixed(2), roi: arr.length ? +(u / arr.length * 100).toFixed(1) : null }; };
  const grp = f => { const o = {}; g.forEach(t => { const k = f(t); (o[k] = o[k] || []).push(t); }); const r = {}; Object.keys(o).forEach(k => r[k] = sum(o[k])); return r; };
  tracker.summary = { updated: new Date(now).toISOString(), all: sum(g), byGrade: grp(t => t.grade), bySport: grp(t => t.sport), bySide: grp(t => t.side), byApp: grp(t => t.app),
    calibration: (() => { const b = {}; g.filter(t => t.result !== 'Push').forEach(t => { const k = Math.floor(t.p / 5) * 5; (b[k] = b[k] || { n: 0, w: 0, pred: 0 }); b[k].n++; b[k].pred += t.p; if (t.result === 'Win') b[k].w++; }); return Object.keys(b).sort().map(k => ({ bucket: k + '-' + (+k + 5) + '%', n: b[k].n, predicted: +(b[k].pred / b[k].n).toFixed(1), actual: +(b[k].w / b[k].n * 100).toFixed(1) })); })() };
  // keep tracker for 120 days
  for (const id of Object.keys(tracker.picks)) if (now - Date.parse(tracker.picks[id].start) > 120 * 86400000) delete tracker.picks[id];
  wr('tracker.json', tracker); wr('calib.json', calib); wr('calib_pending.json', pending); wr(CACHE_DIR + '/ids.json', ids);
  wr('model.json', { generated: new Date(now).toISOString(), breakEven: BE, playEV: PLAY_EV, leanEV: LEAN_EV, calib: { a: calib.a, b: calib.b, n: calib.fitN, at: calib.fitAt },
    counts: { lines: cand.length, priced: Object.keys(verdicts).length, plays: board.filter(b => b.grade === 'Play').length, leans: board.filter(b => b.grade === 'Lean').length },
    board: board.slice(0, 60), verdicts });
  console.log('model:', cand.length, 'lines,', board.length, 'recs,', due.length, 'graded,', dueCal.length, 'calib rows; calib', calib.a.toFixed(3), calib.b.toFixed(3));
})().catch(e => { console.log('model failed', e && e.stack || e); process.exitCode = 0; });
