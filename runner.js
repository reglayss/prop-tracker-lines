// Runs the site's own line-pulling code (engine.js, copied from Code.gs) on GitHub instead of Google.
const fs = require('fs'), vm = require('vm'), path = require('path'), { execFileSync } = require('child_process');
let state = { props: {}, cache: {} };
try { state = JSON.parse(fs.readFileSync('state.json', 'utf8')); } catch (e) {}
state.props = state.props || {}; state.cache = state.cache || {};
const SECRET = { PROPLINE_KEY: process.env.PROPLINE_KEY || '', KASHROCK_KEY: process.env.KASHROCK_KEY || '' };
const now = () => Date.now();

// ---- Apps Script look-alikes ----
function syncFetch(reqs) {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'fetchall.js')], { input: JSON.stringify(reqs), maxBuffer: 1024 * 1024 * 1024 });
  return JSON.parse(out.toString());
}
const resp = x => ({ getResponseCode: () => x.code, getContentText: () => x.body, getHeaders: () => x.headers, getAllHeaders: () => x.headers });
global.UrlFetchApp = {
  fetch: (url, opt) => resp(syncFetch([Object.assign({ url }, opt || {})])[0]),
  fetchAll: reqs => syncFetch(reqs.map(r => (typeof r === 'string' ? { url: r } : r))).map(resp)
};
const props = {
  getProperty: k => (SECRET[k] ? SECRET[k] : (k in state.props ? state.props[k] : null)),
  setProperty: (k, v) => { if (!(k in SECRET)) state.props[k] = String(v); return props; },
  deleteProperty: k => { delete state.props[k]; return props; },
  getProperties: () => Object.assign({}, state.props),
  setProperties: o => { Object.assign(state.props, o); return props; },
  getKeys: () => Object.keys(state.props)
};
global.PropertiesService = { getScriptProperties: () => props, getUserProperties: () => props, getDocumentProperties: () => props };
const cache = {
  get: k => { const e = state.cache[k]; if (!e) return null; if (e.x < now()) { delete state.cache[k]; return null; } return e.v; },
  put: (k, v, t) => { state.cache[k] = { v: String(v), x: now() + 1000 * (t || 600) }; },
  getAll: ks => { const o = {}; ks.forEach(k => { const v = cache.get(k); if (v != null) o[k] = v; }); return o; },
  putAll: (o, t) => Object.keys(o).forEach(k => cache.put(k, o[k], t)),
  remove: k => { delete state.cache[k]; },
  removeAll: ks => ks.forEach(k => delete state.cache[k])
};
global.CacheService = { getScriptCache: () => cache, getUserCache: () => cache, getDocumentCache: () => cache };
const parts = (d, tz) => {
  const o = {}; new Intl.DateTimeFormat('en-US', { timeZone: tz === 'GMT' ? 'UTC' : tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23' })
    .formatToParts(d).forEach(p => (o[p.type] = p.value));
  return o;
};
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
global.Utilities = {
  formatDate: (d, tz, f) => {
    const p = parts(new Date(d), tz), H = Number(p.hour), h12 = H % 12 || 12;
    return String(f).replace(/'([^']*)'|yyyy|MMM|MM|dd|d|HH|H|hh|h|mm|ss|EEE|a/g, (m, lit) => {
      if (lit !== undefined) return lit;
      return { yyyy: p.year, MMM: MON[Number(p.month) - 1], MM: p.month, dd: p.day, d: String(Number(p.day)), HH: String(H).padStart(2, '0'), H: String(H),
        hh: String(h12).padStart(2, '0'), h: String(h12), mm: p.minute, ss: p.second, EEE: p.weekday, a: H < 12 ? 'AM' : 'PM' }[m];
    });
  },
  sleep: ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  base64Encode: s => Buffer.from(String(s)).toString('base64'),
  base64EncodeWebSafe: s => Buffer.from(String(s)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
  base64Decode: s => [...Buffer.from(String(s), 'base64')],
  newBlob: s => ({ getDataAsString: () => String(s), getBytes: () => [...Buffer.from(String(s))] })
};
global.Logger = { log: (...a) => console.log(...a) };
global.LockService = { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) };
global.Session = { getScriptTimeZone: () => 'America/Chicago' };

// ---- load the site's code ----
vm.runInThisContext(fs.readFileSync('engine.js', 'utf8'), { filename: 'engine.js' });
global.UF_SOFT_CAP = 1e12;   // Google's limit doesn't apply here
global.logIssue_ = m => console.log('issue:', m);

console.log('keys seen: PropLine ' + (SECRET.PROPLINE_KEY ? 'yes (' + SECRET.PROPLINE_KEY.length + ' chars)' : 'NO') + ', KashRock ' + (SECRET.KASHROCK_KEY ? 'yes (' + SECRET.KASHROCK_KEY.length + ' chars)' : 'NO'));
const ctHour = Number(Utilities.formatDate(new Date(), 'America/Chicago', 'H'));
const SPORTS_LIST = (process.env.SPORTS || 'basketball_nba,football_nfl,hockey_nhl,football_ncaaf,basketball_ncaab,esports').split(',');
const BOOKS = (process.env.BOOKS || 'prizepicks,underdog,pinnacle,draftkings,fanduel,betmgm').split(',');
let pl = []; try { pl = JSON.parse(fs.readFileSync('pl_rows.json', 'utf8')); } catch (e) {}
const lastPL = Number(state.props.GH_PL_AT || 0);
const wantPL = process.env.FORCE_PL === '1' || (AUTO_PULL_HOURS.indexOf(ctHour) >= 0 && now() - lastPL > 55 * 60000);
let notes = [];
if (wantPL && SECRET.PROPLINE_KEY && !quotaHitToday_()) {
  try {
    const pre = []; let sp = SPORTS_LIST.slice(); try { sp = resolveSports_(sp, pre); } catch (e) {}
    const r = fetchLines_(sp, BOOKS, HOURS_AHEAD);
    notes = notes.concat(r.notes);
    if (r.rows.length) { pl = r.rows; state.props.GH_PL_AT = String(now()); }
    console.log('PropLine rows', r.rows.length);
  } catch (e) { notes.push('PropLine: ' + e.message); console.log('PropLine failed', e.message); }
} else console.log('PropLine skipped this run (hour ' + ctHour + ')');
pl = pl.filter(x => new Date(x.start).getTime() > now() - 3 * 3600000);
const res = { rows: pl.map(x => Object.assign({}, x, { start: new Date(x.start) })), notes };
try { if (SECRET.KASHROCK_KEY) addKashRock_(res); } catch (e) { console.log('KashRock failed', e.message); }
try { addUnderdog_(res); } catch (e) { console.log('Underdog failed', e.message); }
const used = state.props['REQ_' + utcDay_()];
fs.writeFileSync('pl_rows.json', JSON.stringify(pl));
fs.writeFileSync('lines.json', JSON.stringify({ pulled: new Date().toISOString(), plPulled: state.props.GH_PL_AT ? new Date(Number(state.props.GH_PL_AT)).toISOString() : null, plUsed: used != null ? Number(used) : null, rows: res.rows, notes: res.notes }));
Object.keys(state.cache).forEach(k => { const e = state.cache[k]; if (!e || e.x < now() || e.v.length > 50000) delete state.cache[k]; });
fs.writeFileSync('state.json', JSON.stringify(state));
const by = {}; res.rows.forEach(x => (by[x.sport] = (by[x.sport] || 0) + 1));
console.log('wrote', res.rows.length, 'lines', JSON.stringify(by));
