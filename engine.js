var API_BASE = 'https://api.prop-line.com/v1';
var HOURS_AHEAD = 36;        // only games starting within this many hours

var SPORTS = {
  basketball_nba: 'NBA', football_nfl: 'NFL', baseball_mlb: 'MLB', hockey_nhl: 'NHL',
  basketball_wnba: 'WNBA', football_ncaaf: 'NCAAF', basketball_ncaab: 'NCAAB', tennis: 'Tennis',
  soccer_epl: 'Soccer', soccer_la_liga: 'Soccer', soccer_uefa_champions_league: 'Soccer', soccer_mls: 'Soccer',
  esports: 'CS2'
};
var MAX_EVENTS_PER_SPORT = 30;   // soonest games per sport, keeps the free daily limit safe
var MARKETS = {
  basketball_nba: {
    player_points: 'Points', player_rebounds: 'Rebounds', player_assists: 'Assists', player_threes: '3-Pointers',
    player_points_rebounds_assists: 'PRA', player_points_rebounds: 'Pts+Rebs', player_points_assists: 'Pts+Asts',
    player_rebounds_assists: 'Rebs+Asts', player_steals: 'Steals', player_blocks: 'Blocks', player_turnovers: 'Turnovers'
  },
  football_nfl: {
    player_pass_yds: 'Pass Yards', player_pass_tds: 'Pass TDs', player_pass_attempts: 'Pass Attempts',
    player_pass_completions: 'Completions', player_rush_yds: 'Rush Yards', player_reception_yds: 'Rec Yards',
    player_receptions: 'Receptions', player_rush_reception_yds: 'Rush+Rec Yards'
  },
  baseball_mlb: {
    pitcher_strikeouts: 'Strikeouts', batter_hits: 'Hits', batter_total_bases: 'Total Bases', batter_home_runs: 'Home Runs',
    batter_rbis: 'RBIs', batter_runs: 'Runs', pitcher_outs: 'Pitcher Outs', pitcher_earned_runs: 'Earned Runs',
    pitcher_hits_allowed: 'Hits Allowed', batter_hits_runs_rbis: 'Hits+Runs+RBIs'
  },
  hockey_nhl: { player_shots_on_goal: 'Shots on Goal', player_goals: 'Goals', player_points: 'Points', player_assists: 'Assists', player_power_play_points: 'Power Play Points', goalie_saves: 'Saves', player_blocked_shots: 'Blocked Shots' }
};
MARKETS.basketball_wnba = MARKETS.basketball_nba;
MARKETS.basketball_ncaab = MARKETS.basketball_nba;
MARKETS.football_ncaaf = MARKETS.football_nfl;
MARKETS.tennis = {};   // tennis: take whatever player markets the books offer
['soccer_epl','soccer_la_liga','soccer_uefa_champions_league','soccer_mls'].forEach(function (s) { MARKETS[s] = {}; });
MARKETS.esports = {};

var BOOK_NAMES = {
  prizepicks: 'PrizePicks', underdog: 'Underdog', sleeper: 'Sleeper', dabble: 'Dabble', pick6: 'DraftKings Pick6', draftkings_pick6: 'DraftKings Pick6', betr: 'Betr', draftkings: 'DraftKings', fanduel: 'FanDuel',
  betmgm: 'BetMGM', caesars: 'Caesars', williamhill_us: 'Caesars', espnbet: 'ESPN Bet', fanatics: 'Fanatics', bovada: 'Bovada',
  pinnacle: 'Pinnacle', unibet: 'Unibet'
};
function cs2Stat_(k) {
  var t = String(k || '').toLowerCase().replace(/^(esports|cs2|csgo|player)_/, '').replace(/^(esports|cs2|player)_/, '');
  var base = /headshot/.test(t) ? 'Headshots' : /assist/.test(t) ? 'Assists' : /death/.test(t) ? 'Deaths' : /damage|adr/.test(t) ? 'Damage' : /fantasy/.test(t) ? 'Fantasy Score' : /kill/.test(t) ? 'Kills' : prettify_(t);
  var m = t.match(/maps?_?(\d)(?:_(\d))?(?:_(\d))?/);
  if (m) return base + (m[2] ? ' Maps ' + m[1] + '-' + (m[3] || m[2]) : ' Map ' + m[1]);
  return base;
}
function addKashRock_(res) {
  try {
    var kr = fetchKashRock_(res.notes); if (!kr.length) return;
    var have = {}; res.rows.forEach(function (r) { if (r.sport === 'CS2') have[(r.bookKey + '|' + r.player + '|' + r.stat + '|' + r.line).toLowerCase()] = 1; });
    var added = 0; kr.forEach(function (r) { if (have[(r.bookKey + '|' + r.player + '|' + r.stat + '|' + r.line).toLowerCase()]) return; res.rows.push(r); added++; });
    if (added) res.notes = res.notes.filter(function (n) { return !/^CS2:/.test(n); });
  } catch (e) { res.notes.push('CS2 (KashRock): ' + e.message); }
}
function fetchKashRock_(notes) {
  var key = PropertiesService.getScriptProperties().getProperty('KASHROCK_KEY');
  if (!key) return [];
  var res;
  try { res = ufetch_('https://kashrock.up.railway.app/v6/esports/props?game=cs2', { headers: { 'X-API-Key': key }, muteHttpExceptions: true }); }
  catch (e) { notes.push('CS2 (KashRock): could not connect.'); return []; }
  var code = res.getResponseCode();
  if (code === 401 || code === 403) { notes.push('CS2 (KashRock): key was rejected. Re-enter it with Prop Tracker > Set my KashRock key.'); return []; }
  if (code === 429) { notes.push('CS2 (KashRock): too many requests right now, try again in a minute.'); return []; }
  if (code >= 400) { notes.push('CS2 (KashRock): error ' + code + '.'); return []; }
  var data; try { data = JSON.parse(res.getContentText()); } catch (e) { notes.push('CS2 (KashRock): unreadable reply.'); return []; }
  var props = (data && (data.props || data.data)) || [];
  var now = Date.now(), rows = {}, games = {};
  props.forEach(function (p) {
    var side = String(p.direction || p.side || '').toLowerCase(), line = Number(p.line);
    if ((side !== 'over' && side !== 'under') || !p.player_name || !isFinite(line)) return;
    var start = new Date(p.event_time || p.start_time || '');
    if (isFinite(start.getTime()) && start.getTime() < now - 3 * 3600e3) return;   // old match
    var ev = p.eventId || ((p.team || '') + '|' + (p.opponent || ''));
    var game = games[ev] || (games[ev] = (p.team && p.opponent) ? p.team + ' vs ' + p.opponent : (p.team || 'CS2 match'));
    var book = String(p.book_name || 'KashRock'), bk = book.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (/dabble|sleeper|betr|pick6/.test(bk)) return;
    var stat = cs2Stat_(p.stat_type), type = 'Standard';
    var k = bk + '|' + p.player_name + '|' + stat + '|' + line;
    var r = rows[k] || (rows[k] = { sport: 'CS2', game: game, start: isFinite(start.getTime()) ? start : new Date(), bookKey: bk, book: book,
      player: String(p.player_name), stat: stat, line: line, over: '', under: '', type: type, sides: '' });
    var price = p.odds == null || p.odds === '' ? '' : Number(p.odds);
    if (side === 'over') { r.over = price; if (r.sides.indexOf('O') < 0) r.sides = 'O' + r.sides; }
    else { r.under = price; if (r.sides.indexOf('U') < 0) r.sides += 'U'; }
  });
  var out = Object.keys(rows).map(function (k) { return rows[k]; });
  if (!out.length) notes.push('CS2 (KashRock): no CS2 props posted right now.');
  return out;
}

function getKey_() {
  var k = PropertiesService.getScriptProperties().getProperty('PROPLINE_KEY');
  if (!k) throw new Error('No API key yet. Use Prop Tracker > Set my PropLine API key first.');
  return k;
}
var DAILY_REQUEST_CAP = 4700;   // Hobby plan: 5,000 a day. Override with script property DAILY_CAP.
function dailyCap_() { var v = Number(PropertiesService.getScriptProperties().getProperty('DAILY_CAP') || 0); return v > 0 ? v : DAILY_REQUEST_CAP; }
function utcDay_() { return Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd'); }
function resetText_() { var d = new Date(); d.setUTCHours(24, 0, 0, 0); return Utilities.formatDate(d, 'America/Chicago', 'h a') + ' Central'; }
function quotaHit_() { PropertiesService.getScriptProperties().setProperty('QUOTA_HIT', String(Date.now())); }
function quotaHitToday_() { var t = Number(PropertiesService.getScriptProperties().getProperty('QUOTA_HIT') || 0); if (!(t > 0)) return false; var d = new Date(t); var reset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); return Date.now() < reset; }
function quotaMsg_() { return 'Today\'s 5,000 PropLine requests are used up. They reset at 6 PM Central.'; }
function countRequest_() {
  var pr = PropertiesService.getScriptProperties(), cap = dailyCap_();
  if (quotaHitToday_()) throw new Error(quotaMsg_());
  var key = 'REQ_' + utcDay_(), n = Number(pr.getProperty(key) || 0);
  if (n >= cap) throw new Error('Daily data limit reached (' + cap + ' requests). Lines refresh again at ' + resetText_() + '.');
  pr.setProperty(key, String(n + 1));
}
function api_(path, params) {
  countRequest_();
  params = params || {};
  params.apiKey = getKey_();
  var q = Object.keys(params).filter(function (k) { return params[k] !== '' && params[k] != null; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
  var res = ufetch_(API_BASE + path + '?' + q, { muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code === 401 || code === 403) throw new Error('PropLine rejected the API key. Re-enter it with Prop Tracker > Set my PropLine API key.');
  for (var tr = 0; (code === 429 || code === 503) && tr < 3 && /burst|concurr/i.test(res.getContentText() + code); tr++) { Utilities.sleep(2000); res = ufetch_(API_BASE + path + '?' + q, { muteHttpExceptions: true }); code = res.getResponseCode(); }
  if (code === 429) { var rb = res.getContentText(); if (!/burst/i.test(rb)) quotaHit_(); throw new Error(/burst/i.test(rb) ? 'PropLine asked us to slow down. Try again in a minute.' : quotaMsg_()); }
  try { var h1 = res.getHeaders(), u1 = h1['X-Daily-Used'] || h1['x-daily-used']; if (u1 != null && !isNaN(Number(u1))) PropertiesService.getScriptProperties().setProperty('REQ_' + utcDay_(), String(Number(u1))); } catch (e) {}
  if (code >= 400) return { error: code, body: res.getContentText() };
  return JSON.parse(res.getContentText());
}

function apiAll_(reqs) {
  if (!reqs.length) return [];
  var pr = PropertiesService.getScriptProperties();
  var day = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');
  var ck = 'REQ_' + utcDay_(), n = Number(pr.getProperty(ck) || 0), cap = dailyCap_();
  if (quotaHitToday_()) return reqs.map(function () { return { error: 429 }; });
  if (n + reqs.length > cap) { quotaHit_(); return reqs.map(function () { return { error: 429 }; }); }   // keep what earlier calls got instead of failing the whole pull
  pr.setProperty(ck, String(n + reqs.length));
  var key = getKey_();
  var urls = reqs.map(function (r) {
    var params = {}; Object.keys(r.params || {}).forEach(function (k) { params[k] = r.params[k]; }); params.apiKey = key;
    var q = Object.keys(params).filter(function (k) { return params[k] !== '' && params[k] != null; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    return { url: API_BASE + r.path + '?' + q, muteHttpExceptions: true };
  });
  var out = new Array(urls.length), pending = urls.map(function (u, i) { return i; }), CH = 12;
  for (var round = 0; round < 4 && pending.length; round++) {
    var retry = [], waitS = 0, dailyOut = false;
    for (var i = 0; i < pending.length; i += CH) {
      var idx = pending.slice(i, i + CH);
      var res = ufetchAll_(idx.map(function (k) { return urls[k]; }));
      res.forEach(function (x, n) {
        var k = idx[n], code = x.getResponseCode(), h = x.getHeaders() || {};
        var rem = h['X-Daily-Remaining'] != null ? h['X-Daily-Remaining'] : h['x-daily-remaining'];
        var used = h['X-Daily-Used'] != null ? h['X-Daily-Used'] : h['x-daily-used'];
        if (used != null && !isNaN(Number(used))) pr.setProperty(ck, String(Number(used)));
        if (code === 401 || code === 403) throw new Error('PropLine rejected the API key. Re-enter it with Prop Tracker > Set my PropLine API key.');
        if (code === 429 || code === 503) {
          var body = ''; try { body = x.getContentText(); } catch (e) {}
          var isDaily = code === 429 && ((rem != null && Number(rem) <= 0) || /daily/i.test(body)) && !/burst/i.test(body);
          if (isDaily) { dailyOut = true; out[k] = { error: 429 }; return; }
          var ra = Number(h['Retry-After'] || h['retry-after'] || 1); if (isNaN(ra)) ra = 1;
          waitS = Math.max(waitS, Math.min(ra, 10)); retry.push(k); return;
        }
        if (code >= 400) { out[k] = { error: code }; return; }
        try { out[k] = JSON.parse(x.getContentText()); } catch (e) { out[k] = { error: 'bad' }; }
      });
      if (dailyOut) break;
      if (i + CH < pending.length) Utilities.sleep(1200);   // stay under PropLine's burst limit
    }
    if (dailyOut) { quotaHit_(); pending.forEach(function (k) { if (!out[k]) out[k] = { error: 429 }; }); break; }
    pending = retry;
    if (pending.length) Utilities.sleep(Math.max(2, waitS) * 1000);
  }
  pending.forEach(function (k) { if (!out[k]) out[k] = { error: 429 }; });
  return out;
}
function fetchLines_(sports, books, hoursAhead) {
  var now = new Date();
  var out = [], notes = [], soccerLeft = 30;
  if (quotaHitToday_()) throw new Error(quotaMsg_());
  sports = sports.filter(function (sp) { return !/^soccer_/.test(sp) && sp !== 'tennis'; });   // soccer and tennis turned off
  sports = sports.filter(function (sp) { if (!MARKETS[sp]) { notes.push('Unknown sport "' + sp + '" skipped.'); return false; } return true; });
  var evRes = apiAll_(sports.map(function (sp) { return { path: '/sports/' + sp + '/events', params: {} }; }));
  var col = sports.filter(function (sp) { return sp !== 'basketball_ncaab' && EVENT_CAP[sp]; });
  var colRes = apiAll_(col.map(function (sp) { return { path: '/sports/' + sp + '/odds', params: { markets: 'h2h', bookmakers: 'bovada,draftkings,fanduel,betmgm,pinnacle', oddsFormat: 'american' } }; }));
  var priced = {}; col.forEach(function (sp, i) { var m = {}; var d = colRes[i]; ((d && !d.error && (d.data || d)) || []).forEach(function (e) { if (e && e.id != null && (e.bookmakers || []).length) m[e.id] = e.bookmakers.length; }); if (Object.keys(m).length) priced[sp] = m; });
  var jobs = [], count = {};
  sports.forEach(function (sport, si) {
    var isCS2 = SPORTS[sport] === 'CS2', isSoc = /^soccer_/.test(sport), label = SPORTS[sport] || sport;
    var events = evRes[si];
    if (!events || events.error) { notes.push(label + ' (' + sport + '): could not load games.'); return; }
    events = events.data || events; if (!Array.isArray(events)) events = [];
    var win = /^football_/.test(sport) ? 100 : (sport === 'tennis' || isCS2) ? 120 : isSoc ? 144 : hoursAhead;
    var untilS = new Date(now.getTime() + win * 3600 * 1000);
    events = events.filter(function (e) {
      var t = new Date(e.commence_time);
      if (sport !== 'basketball_ncaab' && priced[sport] && !priced[sport][e.id]) return false;
      if (sport === 'esports') { var tg = [e.tour, e.league, e.game, e.sport_title].filter(Boolean).join(' '); if (tg && /valorant|league of legends|lol|dota|rocket|call of duty|overwatch|rainbow/i.test(tg) && !CS2_RX.test(tg)) return false; }
      if (sport === 'tennis' && e.is_outright) return false;
      return t > now && t <= untilS;
    }).sort(function (a, b) { var pa = priced[sport] ? (priced[sport][a.id] || 0) : 0, pb = priced[sport] ? (priced[sport][b.id] || 0) : 0; return (pb - pa) || (new Date(a.commence_time) - new Date(b.commence_time)); })
      .slice(0, sport === 'basketball_ncaab' ? events.length : EVENT_CAP[sport] || (isCS2 ? 12 : isSoc ? Math.max(0, Math.min(8, soccerLeft)) : MAX_EVENTS_PER_SPORT));
    events = skipKnownEmpty_(sport, events, now);
    if (isSoc) soccerLeft -= events.length;
    count[label] = (count[label] || 0) + events.length;
    var markets = MARKETS[sport], anyMarket = Object.keys(markets).length === 0;
    events.forEach(function (ev) {
      var p = { oddsFormat: 'american' };
      if (isCS2) p.period = 'all';
      if (!anyMarket) p.markets = Object.keys(markets).join(',');
      var rb = books.slice();
      if (isCS2) ['bovada','kalshi','draftkings','underdog','prizepicks'].forEach(function (b) { if (rb.indexOf(b) < 0) rb.push(b); });
      if (sport === 'tennis' || isSoc) ['draftkings','underdog','prizepicks','bovada'].forEach(function (b) { if (rb.indexOf(b) < 0) rb.push(b); });
      if (EVENT_CAP[sport]) ['bovada','draftkings','fanduel','betmgm','underdog','prizepicks'].forEach(function (b) { if (rb.indexOf(b) < 0) rb.push(b); });   // college props: Bovada is PropLine's main college book
      if (rb.length) p.bookmakers = rb.join(',');
      jobs.push({ sport: sport, ev: ev, markets: markets, req: { path: '/sports/' + sport + '/events/' + ev.id + '/odds', params: p } });
    });
  });
  var res = apiAll_(jobs.map(function (j) { return j.req; }));
  var retry = []; res.forEach(function (od, i) { if (od && od.error && jobs[i].req.params.markets) retry.push(i); });
  var res2 = apiAll_(retry.map(function (i) { var p = {}; Object.keys(jobs[i].req.params).forEach(function (k) { if (k !== 'markets') p[k] = jobs[i].req.params[k]; }); return { path: jobs[i].req.path, params: p }; }));
  retry.forEach(function (i, k) { res[i] = res2[k]; });
  var lines = {}, emptyJobs = [];
  res.forEach(function (od, i) { if (!od || od.error) return; var j = jobs[i];
    var got = parseEventOdds_(j.sport, j.ev, od, j.markets); if (!got.length) emptyJobs.push(j);
    got.forEach(function (r) { out.push(r); lines[r.sport] = (lines[r.sport] || 0) + 1; }); });
  rememberEmpty_(emptyJobs);
  Object.keys(count).forEach(function (lb) { if (/^(Soccer|CS2|Tennis|NCAAB|NCAAF)$/.test(lb) && !lines[lb]) notes.push(lb + ': ' + (count[lb] ? count[lb] + ' upcoming match' + (count[lb] === 1 ? '' : 'es') + ' found, but no player props are posted for them yet.' : 'no matches in the next few days.')); });
  if (quotaHitToday_()) notes.push('PropLine daily limit was reached during this pull, so some games may be missing. Requests reset at ' + resetText_() + '.');
  return { rows: out, notes: notes };
}
function skipKnownEmpty_(sport, events, now) {
  try {
    if (!events.length) return events;
    var got = CacheService.getScriptCache().getAll(events.map(function (e) { return 'NP_' + sport + '_' + e.id; }));
    return events.filter(function (e) { var soon = new Date(e.commence_time).getTime() - now.getTime() < 3 * 3600e3; return soon || !got['NP_' + sport + '_' + e.id]; });
  } catch (x) { return events; }
}
function rememberEmpty_(jobs) {
  try { if (!jobs.length) return; var m = {}; jobs.forEach(function (j) { m['NP_' + j.sport + '_' + j.ev.id] = '1'; }); CacheService.getScriptCache().putAll(m, 3 * 3600); } catch (x) {}
}
function parseEventOdds_(sport, ev, od, markets) {
  var game = (ev.away_team || od.away_team || '') + ' @ ' + (ev.home_team || od.home_team || '');
  var start = new Date(ev.commence_time || od.commence_time);
  var rows = {};
  (od.bookmakers || []).forEach(function (bk) {
    if (/dabble|sleeper|betr|pick6/i.test(String(bk.key))) return;
    (bk.markets || []).forEach(function (m) {
      var stat = markets[m.key];
      if (!stat && sport === 'tennis' && !/^(h2h|spreads|totals)$/.test(m.key)) stat = prettify_(m.key);
      if (!stat) {
        var k = String(m.key || '');
        var athleteMarket = /^(player_|batter_|pitcher_|goalie_)/.test(k);
        var isCS2m = SPORTS[sport] === 'CS2';
        var socMarket = /^soccer_/.test(sport) && /(shots|on_target|goal_or_assist|tackles|passes|saves|fouls|crosses|clearances|assists|goals)/.test(k) && !/^(h2h|spreads|totals|both_teams|total_corners|correct_score|team_)/.test(k);
        var cs2Market = isCS2m && /(?:^|_)(?:kills|headshots|assists|damage)(?:_|$)/.test(k) && !/^(?:total_kills|kills_handicap|odd_even_total_kills)$/.test(k);
        if (!athleteMarket && !cs2Market && !socMarket) return;
        stat = isCS2m ? cs2Stat_(m.key) : prettify_(m.key);
      }
      if (SPORTS[sport] === 'CS2' && m.period && m.period !== 'full') stat += ' (' + String(m.period).toUpperCase() + ')';
      (m.outcomes || []).forEach(function (o) {
        var side = String(o.name || '').toLowerCase();
        var player = o.description || o.participant || '';
        if (side !== 'over' && side !== 'under') {             // some feeds put the player in name
          if (/over|under/i.test(o.description || '')) { side = /over/i.test(o.description) ? 'over' : 'under'; player = o.name; }
          else return;
        }
        if (o.point == null || !player) return;
        var type = 'Standard';
        if (o.dfs_odds_type && o.dfs_odds_type !== 'standard') type = cap_(o.dfs_odds_type);
        if (o.payout_multiplier != null && Number(o.payout_multiplier) !== 1) type = 'Payout x' + o.payout_multiplier;
        var key = bk.key + '|' + player + '|' + stat + '|' + o.point + '|' + type;
        var r = rows[key] || (rows[key] = {
          sport: SPORTS[sport] || sport, game: game, start: start, bookKey: bk.key, book: BOOK_NAMES[bk.key] || bk.title || bk.key,
          player: player, stat: stat, line: Number(o.point), over: '', under: '', type: type, sides: ''
        });
        if (side === 'over') { r.over = o.price == null ? '' : o.price; if (r.sides.indexOf('O') < 0) r.sides = 'O' + r.sides; }
        else { r.under = o.price == null ? '' : o.price; if (r.sides.indexOf('U') < 0) r.sides += 'U'; }
      });
    });
  });
  return Object.keys(rows).map(function (k) { return rows[k]; });
}

function prettify_(k) {
  return String(k).replace(/^(player|batter|pitcher|goalie)_/, '').split('_').map(cap_).join(' ');
}
function cap_(s) { s = String(s); return s.charAt(0).toUpperCase() + s.slice(1); }
var SOCCER_WANT = /^soccer_(epl|la_liga|serie_a|bundesliga|ligue_1|mls|uefa_champions_league|uefa_champs_league|uefa_europa_league)$/;
var CS2_RX = /cs2|counter.?strike|csgo|cs_go/i;
function sportCatalog_() {
  var c = CacheService.getScriptCache(), hit = c.get('PL_SPORTS');
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  var res = null; try { res = api_('/sports', { all: 'true' }); if (!res || res.error) res = api_('/sports', {}); } catch (e) { return null; }
  var list = res && !res.error ? (res.data || res) : null;
  if (!Array.isArray(list) || !list.length) return null;
  var out = list.map(function (x) { return { key: String(x.key || '').toLowerCase(), title: String(x.title || x.key || ''), group: String(x.group || ''), active: x.active !== false }; }).filter(function (x) { return x.key; });
  try { c.put('PL_SPORTS', JSON.stringify(out), 21600); } catch (e) {}
  return out;
}
function resolveSports_(sports, notes) {
  var cat = sportCatalog_();
  if (!cat) {                                    // could not check: use PropLine's documented soccer leagues
    notes.push('Could not check PropLine\'s sport list, so the usual soccer leagues were used.');
    var base = sports.filter(function (x) { return MARKETS[x] && !/^soccer_uefa/.test(x); });
    ['soccer_epl','soccer_la_liga','soccer_serie_a','soccer_bundesliga','soccer_ligue_1','soccer_mls'].forEach(function (k) { if (base.indexOf(k) < 0) base.push(k); if (!MARKETS[k]) MARKETS[k] = {}; SPORTS[k] = 'Soccer'; });
    return base;
  }
  var have = {}; cat.forEach(function (x) { have[x.key] = x; });
  var out = [];
  sports.forEach(function (s) { if (have[s]) out.push(s); });
  var soccer = cat.filter(function (x) { return SOCCER_WANT.test(x.key) && x.active; }).map(function (x) { return x.key; });
  var cs2 = cat.filter(function (x) { return x.active && (CS2_RX.test(x.key) || CS2_RX.test(x.title) || (/esport/i.test(x.key + ' ' + x.group) && (CS2_RX.test(x.title) || x.key === 'esports'))); }).map(function (x) { return x.key; });
  soccer.concat(cs2).forEach(function (k) {
    if (out.indexOf(k) < 0) out.push(k);
    if (!MARKETS[k]) MARKETS[k] = {};
    if (!SPORTS[k]) SPORTS[k] = /^soccer_/.test(k) ? 'Soccer' : 'CS2';
  });
  if (!soccer.length) notes.push('Soccer: PropLine has no soccer leagues open right now.');
  if (!cs2.length) notes.push('CS2: PropLine does not offer a CS2 feed on your plan right now, so CS2 props can\'t show.');
  return out;
}

var EVENT_CAP = { football_ncaaf: 60, basketball_ncaab: 0 };   // college slates are huge; most small-school games have no props
var AUTO_PULL_HOURS = [8, 10, 12, 14, 16, 17, 18, 19, 20, 21, 22];
var UD_SPORT = { NBA: 'NBA', NFL: 'NFL', NHL: 'NHL', CBB: 'NCAAB', CFB: 'NCAAF' };
var UD_STAT = {
  NBA: { points: 'Points', rebounds: 'Rebounds', assists: 'Assists', three_points_made: '3-Pointers', pts_rebs_asts: 'PRA', pts_rebs: 'Pts+Rebs', pts_asts: 'Pts+Asts', rebs_asts: 'Rebs+Asts', steals: 'Steals', blocks: 'Blocks', turnovers: 'Turnovers' },
  NFL: { passing_yds: 'Pass Yards', passing_tds: 'Pass TDs', passing_att: 'Pass Attempts', passing_comps: 'Completions', rushing_yds: 'Rush Yards', receiving_yds: 'Rec Yards', receiving_rec: 'Receptions', rush_rec_yds: 'Rush+Rec Yards' },
  NHL: { shots: 'Shots on Goal', points: 'Points', assists: 'Assists', power_play_points: 'Power Play Points', saves: 'Saves', blocked_shots: 'Blocked Shots' }
};
UD_STAT.NCAAB = UD_STAT.NBA; UD_STAT.NCAAF = UD_STAT.NFL;
function fetchUnderdog_(notes) {
  var res; try { res = ufetch_('https://api.underdogfantasy.com/v1/over_under_lines', { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, muteHttpExceptions: true }); }
  catch (e) { notes.push('Underdog: could not connect.'); return []; }
  if (res.getResponseCode() !== 200) { notes.push('Underdog: error ' + res.getResponseCode() + '.'); return []; }
  var j; try { j = JSON.parse(res.getContentText()); } catch (e) { notes.push('Underdog: unreadable reply.'); return []; }
  var games = {}, players = {}, apps = {}, now = Date.now();
  (j.games || []).forEach(function (g) { games[g.id] = g; });
  (j.players || []).forEach(function (p) { players[p.id] = p; });
  (j.appearances || []).forEach(function (a) { apps[a.id] = a; });
  var out = [];
  (j.over_under_lines || []).forEach(function (l) {
    if (l.status !== 'active' || l.live_event || !l.options || l.options.length !== 2) return;
    var st = l.over_under && l.over_under.appearance_stat; if (!st) return;
    var a = apps[st.appearance_id], p = a && players[a.player_id], g = a && games[a.match_id]; if (!p || !g) return;
    var sport = UD_SPORT[p.sport_id || g.sport_id]; if (!sport) return;
    var stat = (UD_STAT[sport] || {})[st.stat]; if (!stat) return;
    var start = new Date(g.scheduled_at); if (!(start.getTime() > now)) return;
    var hi = l.options.filter(function (o) { return o.choice === 'higher'; })[0], lo = l.options.filter(function (o) { return o.choice === 'lower'; })[0]; if (!hi || !lo) return;
    var type = Math.abs(Number(hi.payout_multiplier || 1) - 1) < 0.001 && Math.abs(Number(lo.payout_multiplier || 1) - 1) < 0.001 ? 'Standard' : 'Payout x' + hi.payout_multiplier;
    var px = function (o) { var v = o.american_price; return v == null || v === '' ? '' : Number(String(v).replace('+', '')); };
    out.push({ sport: sport, game: String(g.full_team_names_title || g.abbreviated_title || ''), start: start, bookKey: 'underdog', book: 'Underdog',
      player: String((p.first_name || '') + ' ' + (p.last_name || '')).trim(), stat: stat, line: Number(l.stat_value), over: px(hi), under: px(lo), type: type, sides: 'OU' });
  });
  return out;
}
function addUnderdog_(res) {
  var have = {}; res.rows.forEach(function (x) { if (x.bookKey === 'underdog' || /underdog/i.test(x.book)) have[x.sport] = 1; });
  var ud = [], covered = {}; try { ud = fetchUnderdog_(res.notes); } catch (e) { res.notes.push('Underdog: ' + e.message); }
  ud.forEach(function (x) { if (have[x.sport]) return; covered[x.sport] = 1; res.rows.push(x); });
  return covered;
}
var UF_ESSENTIAL = /^(apiAll_|api_|fetchUnderdog_|fetchKashRock_|getInjuries|injuryWatch|fetchLines_|pullLinesWeb|pullCS2Only_|addKashRock_|addUnderdog_|autoPullLines|runPullNow)$/;
var UF_SOFT_CAP = 14000;   // past this, only line refreshes + injuries may use the network
function ufDay_() { return Utilities.formatDate(new Date(), 'America/Chicago', 'yyyyMMdd'); }
function ufCaller_() {
  var st = String(new Error().stack || '').split('\n'), names = [];
  st.forEach(function (l) { var m = l.match(/at (\w+) /); if (m && !/^(ufCaller_|ufCount_|ufetch_|ufetchAll_|Error)$/.test(m[1])) names.push(m[1]); });
  return names;
}
function ufCount_(n) {
  var c = CacheService.getScriptCache(), d = ufDay_(), names = ufCaller_(), who = names[0] || '?';
  var tot = Number(c.get('UF_' + d) || PropertiesService.getScriptProperties().getProperty('UF_TOTAL_' + d) || 0) + n; c.put('UF_' + d, String(tot), 21600);
  var k = 'UFW_' + d + '_' + who; c.put(k, String(Number(c.get(k) || 0) + n), 21600);
  var reg = c.get('UFL_' + d) || ''; if ((',' + reg + ',').indexOf(',' + who + ',') < 0) c.put('UFL_' + d, reg ? reg + ',' + who : who, 21600);
  if (tot % 500 < n) { try { PropertiesService.getScriptProperties().setProperty('UF_TOTAL_' + d, String(tot)); } catch (e) {} }
  var essential = names.some(function (x) { return UF_ESSENTIAL.test(x); });
  return { tot: tot, ok: essential || tot < UF_SOFT_CAP };
}
function ufBlocked_() { return { getResponseCode: function () { return 429; }, getContentText: function () { return ''; }, getHeaders: function () { return {}; }, getBlob: function () { return Utilities.newBlob(''); } }; }
function ufetch_(url, opt) { var u = ufCount_(1); if (!u.ok) return ufBlocked_(); return UrlFetchApp.fetch(url, opt || {}); }
function ufetchAll_(reqs) { var u = ufCount_(reqs.length); if (!u.ok) return reqs.map(ufBlocked_); return UrlFetchApp.fetchAll(reqs); }
