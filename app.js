/* Swiss 4000ers – private web app. Data and logs are only loaded after login (Supabase). */
'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const local = { get(k, d){ try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch(e){ return d; } }, set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }, del(k){ try { localStorage.removeItem(k); } catch(e){} } };
const show = (id, on) => $(id).classList.toggle('hidden', !on);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'e' + Date.now() + Math.random().toString(16).slice(2));

// Invite / recovery links put "type=invite|recovery" in the URL hash – remember it before supabase-js consumes the hash
const HASH_TYPE = new URLSearchParams(location.hash.slice(1)).get('type');
const sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
let USER = null, D = null, LOG = {}, DIRTY = {}, PROFILE = { done: {}, display_name: '' };
const isAdmin = () => USER && (USER.email || '').toLowerCase() === CFG.ADMIN_EMAIL.toLowerCase();

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));

// ================= AUTH =================
async function boot(){
  const { data: { session } } = await sb.auth.getSession();
  $('boot').classList.add('hidden');
  if (!session) return showLogin();
  USER = session.user;
  if (HASH_TYPE === 'invite' || HASH_TYPE === 'recovery' || USER.user_metadata?.must_change) return showSetPassword();
  startApp();
}
function showLogin(){ show('authView', true); show('appView', false); show('loginCard', true); show('pwCard', false); }
function showSetPassword(){ show('authView', true); show('appView', false); show('loginCard', false); show('pwCard', true);
  $('pwName').value = USER.user_metadata?.name || ''; $('pwIntro').textContent = `Logged in as ${USER.email}. Choose your own password (at least 8 characters).`; }
$('loginForm').onsubmit = async e => { e.preventDefault(); $('liErr').textContent = '';
  const { data, error } = await sb.auth.signInWithPassword({ email: $('liEmail').value.trim().toLowerCase(), password: $('liPw').value });
  if (error) { $('liErr').textContent = error.message === 'Invalid login credentials' ? 'Wrong e-mail or password.' : error.message; return; }
  USER = data.user; $('liPw').value = '';
  if (USER.user_metadata?.must_change) return showSetPassword();
  startApp(); };
$('pwForm').onsubmit = async e => { e.preventDefault(); $('pwErr').textContent = '';
  if ($('pw1').value.length < 8) return $('pwErr').textContent = 'At least 8 characters, please.';
  if ($('pw1').value !== $('pw2').value) return $('pwErr').textContent = 'The two passwords are different.';
  const name = $('pwName').value.trim();
  const { data, error } = await sb.auth.updateUser({ password: $('pw1').value, data: { must_change: false, name } });
  if (error) return $('pwErr').textContent = error.message;
  USER = data.user; $('pw1').value = $('pw2').value = '';
  history.replaceState(null, '', location.pathname);
  await sb.from('profiles').upsert({ user_id: USER.id, email: USER.email, display_name: name || USER.email.split('@')[0] });
  startApp(); };

// ================= DATA + SYNC =================
async function loadData(){
  const key = 'data4000';
  try {
    const { data, error } = await sb.storage.from('appdata').download('data.json');
    if (error) throw error;
    D = JSON.parse(await data.text()); local.set(key, D);
  } catch (e) { D = local.get(key, null); }
  if (!D) throw new Error('Could not load the route data. Check your connection and reload.');
}
const LK = () => 'log4000_' + USER.id, DK = () => 'dirty4000_' + USER.id, PK = () => 'profile4000_' + USER.id;
function saveLocal(){ local.set(LK(), LOG); local.set(DK(), DIRTY); local.set(PK(), PROFILE); }
function setSync(t){ const el = $('syncState'); if (el) el.textContent = t; }
let syncing = false;
async function sync(){
  if (!USER || syncing) return; syncing = true;
  try {
    const dirtyIds = Object.keys(DIRTY);
    if (dirtyIds.length) {
      const rows = dirtyIds.filter(id => LOG[id]).map(id => ({ user_id: USER.id, id, entry: LOG[id], updated_at: LOG[id].updated }));
      const { error } = await sb.from('logs').upsert(rows); if (error) throw error;
      DIRTY = {};
    }
    const { data, error } = await sb.from('logs').select('id, entry, updated_at'); if (error) throw error;
    for (const r of data) { const l = LOG[r.id]; if (!l || (l.updated || '') <= (r.entry.updated || r.updated_at)) LOG[r.id] = r.entry; }
    if (PROFILE._dirty) { const { error: pe } = await sb.from('profiles').upsert({ user_id: USER.id, email: USER.email, done: PROFILE.done, display_name: PROFILE.display_name, updated_at: new Date().toISOString() }); if (pe) throw pe; delete PROFILE._dirty; }
    else { const { data: p } = await sb.from('profiles').select('done, display_name').eq('user_id', USER.id).maybeSingle(); if (p) { PROFILE.done = p.done || {}; PROFILE.display_name = p.display_name || ''; } }
    saveLocal(); setSync('✓ Synced'); return true;
  } catch (e) { saveLocal(); setSync(navigator.onLine ? 'Sync error – will retry' : 'Offline – saved on this device, will sync later'); return false; }
  finally { syncing = false; }
}
window.addEventListener('online', () => sync().then(refreshAll));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync().then(refreshAll); });
const entries = () => Object.values(LOG).filter(e => !e.deleted);

// ================= APP =================
let started = false;
async function startApp(){
  show('authView', false); show('appView', true);
  LOG = local.get(LK(), {}); DIRTY = local.get(DK(), {}); PROFILE = local.get(PK(), { done: {}, display_name: '' });
  try { await loadData(); } catch (e) { $('list').innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  if (!started) { initFinder(); initLog(); started = true; }
  show('navAdmin', isAdmin());
  await sync();
  $('whoami').textContent = PROFILE.display_name || USER.email;
  refreshAll();
  setTimeout(() => map.invalidateSize(), 100);
}
function refreshAll(){ if (!started) return; render(); renderLog(); renderAccount(); }

// ---------- navigation
document.querySelectorAll('nav button').forEach(b => b.onclick = () => showView(b.dataset.view));
function showView(v){ document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x.dataset.view === v)); document.querySelectorAll('.view').forEach(x => x.classList.toggle('on', x.id === 'v-' + v));
  if (v === 'finder') { setTimeout(() => map.invalidateSize(), 50); render(); } else if (v === 'log') renderLog(); else if (v === 'account') renderAccount(); else if (v === 'admin') loadUsers(); window.scrollTo(0, 0); }

// ---------- finder
const GC = ['#999','#2e9e5b','#7fb03a','#e0a526','#e06a26','#c8102e','#7a1f5c','#2a2a2a'];
const GL = ['','L / F','WS / PD','ZS / AD','S / D','SS / TD','AS / ED','EX / ABO'];
const S = { season: 'all', origin: 'zrh', days: 'all', lift: '1' };
const fmt = m => m == null ? '–' : Math.floor(m/60) + ':' + String(m%60).padStart(2,'0') + ' h';
const gcol = v => v == null ? '#999' : GC[Math.max(1, Math.min(7, Math.round(v)))];
let map, markers = {}, peakById = {}, routesByPeak = {}, peaksSorted = [];
const effDays = r => S.lift === '1' ? r.days : (r.days_nl ?? r.days);
const summited = () => { const s = new Set(Object.keys(PROFILE.done || {}).filter(k => PROFILE.done[k]).map(Number)); entries().forEach(e => { if (e.result === 'Summit') s.add(+e.peak); }); return s; };

function initFinder(){
  peakById = Object.fromEntries(D.peaks.map(p => [p.id, p]));
  D.routes.forEach((r, i) => { r.idx = i; (routesByPeak[r.peak] = routesByPeak[r.peak] || []).push(r); });
  D.archive.forEach(a => { const n = peakById[a.peak].normal || {}; Object.assign(a, { zrh: n.zrh, lsn: n.lsn, days: n.days, days_nl: n.days_nl, station: n.station, isArch: true, disc_en: a.disc === 'skitouren' ? 'Ski tour' : 'Alpine tour' }); });
  peaksSorted = D.peaks.slice().sort((a, b) => b.alt - a.alt);
  for (const [i, l] of GL.entries()) if (i) { $('gmin').add(new Option(l + (i===1?' (easiest)':''), i)); $('gmax').add(new Option(l + (i===7?' (hardest)':''), i)); }
  $('gmin').value = 1; $('gmax').value = 7;
  [...new Set(D.peaks.map(p => p.group))].forEach(g => $('group').add(new Option(g, g)));
  const seg = (id, key) => $(id).addEventListener('click', e => { if (e.target.tagName !== 'BUTTON') return; [...$(id).children].forEach(b => b.classList.toggle('on', b === e.target)); S[key] = e.target.dataset.v; render(); });
  seg('season','season'); seg('origin','origin'); seg('days','days'); seg('lift','lift');
  ['q','gmin','gmax','tmax','group','normal','arch','desc','hideDone','sort'].forEach(id => $(id).addEventListener('input', render));
  $('toggleF').onclick = () => $('filters').classList.toggle('open');
  $('reset').onclick = () => { $('q').value=''; $('gmin').value=1; $('gmax').value=7; $('tmax').value=999; $('group').value=''; ['normal','arch','desc','hideDone'].forEach(i => $(i).checked = false); $('sort').value='alt';
    for (const [id, key, v] of [['season','season','all'],['origin','origin','zrh'],['days','days','all'],['lift','lift','1']]) { S[key] = v; [...$(id).children].forEach(b => b.classList.toggle('on', b.dataset.v === v)); } render(); };
  map = L.map('map', { scrollWheelZoom: true }).setView([46.3, 7.9], 8);
  L.tileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg', { maxZoom: 18, attribution: '© swisstopo' }).addTo(map);
  map.fitBounds(L.latLngBounds(D.peaks.map(p => [p.lat, p.lon])).pad(0.08));
}
function match(r){
  const q = $('q').value.trim().toLowerCase();
  const gmin = +$('gmin').value - 0.34, gmax = +$('gmax').value + 0.34;
  if (S.season !== 'all' && r.season !== S.season) return false;
  if (r.gval != null && (r.gval < gmin || r.gval > gmax)) return false;
  if (r.gval == null && (+$('gmin').value > 1 || +$('gmax').value < 7)) return false;
  const t = r[S.origin]; const tmax = +$('tmax').value;
  if (tmax < 999 && (t == null || t > tmax)) return false;
  if (S.days !== 'all') { const d = effDays(r) || 2; if (S.days === '3' ? d < 3 : d !== +S.days) return false; }
  if ($('normal').checked && !r.normal) return false;
  if (!$('desc').checked && r.descent) return false;
  const p = peakById[r.peak];
  if ($('group').value && p.group !== $('group').value) return false;
  if ($('hideDone').checked && summited().has(p.id)) return false;
  if (q && !(p.name+' '+p.sac_name+' '+r.name+' '+(r.start||'')+' '+(r.station||'')+' '+(r.book||'')).toLowerCase().includes(q)) return false;
  return true;
}
const gBadge = r => `<span class="g" style="background:${gcol(r.gval)}">${esc(r.grade2 || r.grade || 'n/a')}</span>`;
function routeRow(r){
  const seasonTag = r.season.startsWith('Winter') ? '<span class="pill ski">Ski</span>' : '<span class="pill sum">Summer</span>';
  const tz = r.zrh != null ? fmt(r.zrh) : (r.station ? '–' : 'n/a'); const tl = r.lsn != null ? fmt(r.lsn) : (r.station ? '–' : 'n/a');
  const est = r.train_est ? ' <span class="muted" title="Summer-only bus, estimated">≈</span>' : '';
  const src = r.src === 'camptocamp.org' ? 'camptocamp' : 'SAC';
  if (r.isArch) return `<tr><td>${esc(r.name)}<span class="pill arch">archive</span><div class="muted">${esc(r.book||'')}</div></td>
   <td class="n">${gBadge(r)}</td><td>${seasonTag}</td><td class="hide-m muted">see guidebook</td>
   <td class="n muted">${tz}</td><td class="n muted">${tl}</td><td class="n muted">${effDays(r)||'–'} (est.)</td><td><a href="${r.link}" target="_blank" rel="noopener">SAC</a></td></tr>`;
  const nl = S.lift === '0';
  const note = nl ? (r.access_note_nl || r.access_note) : r.access_note;
  const dn = nl ? (r.days_note_nl || r.days_note) : r.days_note;
  const liftTag = r.lift ? (nl ? '<span class="pill lift">no-lift version</span>' : '<span class="pill lift">cable car</span>') : '';
  return `<tr><td>${esc(r.name)}${r.normal?'<span class="pill norm">normal route</span>':''}${liftTag}${r.src==='camptocamp.org'?'<span class="pill c2c">camptocamp</span>':''}
   <div class="muted">${r.disc_en}${r.start?' · from '+esc(r.start):''}${r.station?' · valley: '+esc(r.station):''}</div>${note?'<div class="muted">'+esc(note)+'</div>':''}</td>
   <td class="n">${gBadge(r)}</td><td>${seasonTag}</td>
   <td class="hide-m">${esc(r.up)||'–'}${r.down?'<div class="muted">down: '+esc(r.down)+'</div>':''}${r.expo?'<div class="muted">slope aspect: '+esc(r.expo)+'</div>':''}</td>
   <td class="n">${tz}${est}</td><td class="n">${tl}${est}</td><td class="n" title="${esc(dn)}">${effDays(r)}</td>
   <td class="n"><a href="${r.link}" target="_blank" rel="noopener">${src}</a><br><button class="tag" data-log="${r.idx}">+ Log</button></td></tr>`;
}
function render(){
  if (!D) return;
  let pool = D.routes.slice(); if ($('arch').checked) pool = pool.concat(D.archive);
  const by = {}; let nR = 0; const sm = summited();
  for (const r of pool) if (match(r)) { (by[r.peak] = by[r.peak] || []).push(r); nR++; }
  let peaks = D.peaks.filter(p => by[p.id]);
  const minG = p => Math.min(...by[p.id].map(r => r.gval ?? 9));
  const minT = p => Math.min(...by[p.id].map(r => r[S.origin] ?? 9999));
  const sort = $('sort').value;
  peaks.sort((a, b) => sort==='alt' ? b.alt-a.alt : sort==='easy' ? minG(a)-minG(b) : sort==='train' ? minT(a)-minT(b) : a.name.localeCompare(b.name));
  $('nP').textContent = peaks.length; $('nR').textContent = nR;
  $('nD').innerHTML = `Done: <b>${sm.size}</b> / ${D.peaks.length}`;
  const ents = entries();
  $('list').innerHTML = peaks.map(p => {
    const rs = by[p.id].sort((a, b) => (b.normal - a.normal) || (!!a.isArch - !!b.isArch) || ((a.gval ?? 9) - (b.gval ?? 9)));
    const main = rs.filter(r => !r.isArch), arch = rs.filter(r => r.isArch);
    const head = '<tr><th>Route</th><th>Grade SAC / FR</th><th>Season</th><th class="hide-m">Ascent</th><th>Zurich</th><th>Lausanne</th><th>Days</th><th>Link</th></tr>';
    const archBlock = arch.length ? `<details ${main.length?'':'open'}><summary>${arch.length} archive route${arch.length>1?'s':''} (older SAC guidebooks, links to scanned pages)</summary><div class="tbl"><table>${head}${arch.map(routeRow).join('')}</table></div></details>` : '';
    const n = p.normal; const nd = n ? (S.lift === '1' ? n.days : n.days_nl) : null;
    const logs = ents.filter(e => +e.peak === p.id);
    return `<div class="peak" id="p${p.id}">
     <div class="ph">${p.photo?`<img loading="lazy" src="${p.photo}" alt="${esc(p.name)}" title="${esc(p.photo_cap)}">`:'<div></div>'}
      <div><h2>${esc(p.name)} <span class="muted" style="font-weight:400">${p.alt} m</span></h2>
       <div class="sub">${esc(p.group)} · ${p.country}${p.sac_name!==p.name?' · '+esc(p.sac_name):''}${logs.length?` · logged ${logs.length}×, last ${esc(logs.map(e=>e.date).sort().pop())}`:''}</div>
       <div class="tags">${n?`<span class="tag">Normal route <span class="g" style="background:${gcol(n.gval)}">${esc(n.grade2)}</span></span><span class="tag">${nd} day${nd>1?'s':''}</span>`:''}
        ${p.has_ski?'<span class="tag">Ski route</span>':''}<span class="tag">${p.n_routes} current + ${p.n_archive} archive routes</span>
        <a class="tag" href="${p.url}" target="_blank" rel="noopener">${p.source==='camptocamp.org'?'camptocamp page':'SAC page'}</a>
        ${p.c2c && p.source!=='camptocamp.org'?`<a class="tag" href="${p.c2c}" target="_blank" rel="noopener">camptocamp</a>`:''}
        <label class="tag${sm.has(p.id)?' done-tag':''}" style="cursor:pointer"><input type="checkbox" data-done="${p.id}" ${sm.has(p.id)?'checked':''}> Done</label>
        <button class="tag" data-logpeak="${p.id}">+ Log</button></div></div></div>
     ${main.length?`<div class="tbl"><table>${head}${main.map(routeRow).join('')}</table></div>`:''}${archBlock}</div>`;
  }).join('') || '<p class="muted">No route matches these filters.</p>';
  for (const p of D.peaks) {
    const showIt = !!by[p.id];
    if (!markers[p.id]) { markers[p.id] = L.marker([p.lat, p.lon]); markers[p.id].on('click', () => { const el = $('p'+p.id); if (el) { document.querySelectorAll('.peak.sel').forEach(x => x.classList.remove('sel')); el.classList.add('sel'); } }); }
    const m = markers[p.id];
    if (showIt) {
      const g = Math.min(...by[p.id].map(r => r.gval ?? 9));
      m.setIcon(L.divIcon({ className: '', html: `<div class="pin${sm.has(p.id)?' done':''}" style="background:${gcol(g===9?null:g)}"></div>`, iconSize: [16,16], iconAnchor: [8,8] }));
      const n = p.normal; const nd = n ? (S.lift === '1' ? n.days : n.days_nl) : null;
      m.bindPopup(`<div class="pop">${p.photo?`<img src="${p.photo}" alt="">`:''}<b>${esc(p.name)}</b> ${p.alt} m${sm.has(p.id)?' <span class="pill donep">done</span>':''}<br>${by[p.id].length} matching route${by[p.id].length>1?'s':''}, easiest ${GL[Math.max(1,Math.min(7,Math.round(g)))]||'?'}<br>${n?`Normal: ${esc(n.grade2)} · ${nd} d · Zurich ${fmt(n.zrh)} · Lausanne ${fmt(n.lsn)}<br>`:''}<a href="#p${p.id}">Show routes ↓</a></div>`);
      m.bindTooltip(`${p.name} ${p.alt} m`);
      if (!map.hasLayer(m)) m.addTo(map);
    } else if (map.hasLayer(m)) map.removeLayer(m);
  }
}
document.addEventListener('change', e => { const id = e.target.dataset && e.target.dataset.done; if (id) { PROFILE.done[id] = e.target.checked; PROFILE._dirty = true; saveLocal(); render(); sync(); } });
document.addEventListener('click', e => {
  const t = e.target; if (!t.dataset) return;
  if (t.dataset.log !== undefined) { const r = D.routes[+t.dataset.log]; openLogForm(r.peak, r.idx); }
  if (t.dataset.logpeak) openLogForm(+t.dataset.logpeak, null);
  if (t.dataset.edit) editEntry(t.dataset.edit);
  if (t.dataset.del && confirm('Delete this log entry?')) { const x = LOG[t.dataset.del]; x.deleted = true; x.updated = new Date().toISOString(); DIRTY[x.id] = 1; saveLocal(); renderLog(); sync(); }
  if (t.dataset.goto) { e.preventDefault(); showView('finder'); setTimeout(() => { const el = $('p'+t.dataset.goto); if (el) el.scrollIntoView({ behavior: 'smooth' }); }, 80); }
  if (t.dataset.reset) adminReset(t.dataset.reset, t.dataset.email);
  if (t.dataset.remove) adminDelete(t.dataset.remove, t.dataset.email);
});

// ---------- log
let editing = null;
function initLog(){
  peaksSorted.forEach(p => $('lPeak').add(new Option(`${p.name} (${p.alt} m)`, p.id)));
  $('lPeak').onchange = () => fillRoutes(+$('lPeak').value, null);
  $('lRoute').onchange = syncRoute;
  $('lCancel').onclick = resetForm;
  $('lSave').onclick = saveEntry;
  $('hFilter').oninput = renderLog; $('hSearch').oninput = renderLog;
  $('exJson').onclick = () => download(`4000ers_log_${new Date().toISOString().slice(0,10)}.json`, JSON.stringify({ app: 'swiss-4000ers', version: 2, exported: new Date().toISOString(), log: entries(), done: PROFILE.done }, null, 1), 'application/json');
  $('exCsv').onclick = () => { const cols = ['date','peakName','alt','route','grade','result','season','days','hut','transport','partners','gear','rating','notes'];
    const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    download('4000ers_log.csv', '﻿' + cols.join(';') + '\n' + entries().sort((a,b) => a.date.localeCompare(b.date)).map(e => cols.map(c => q(e[c])).join(';')).join('\n'), 'text/csv'); };
  $('imJson').onchange = ev => { const f = ev.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { try { const j = JSON.parse(rd.result); let n = 0;
      for (const e of (j.log || [])) { if (!e || !e.date || !e.peak) continue; const id = (e.id && !LOG[e.id]) ? String(e.id) : uuid(); if (LOG[e.id]) continue; LOG[id] = { ...e, id, updated: new Date().toISOString() }; DIRTY[id] = 1; n++; }
      for (const [k, v] of Object.entries(j.done || {})) if (v) PROFILE.done[k] = true; PROFILE._dirty = true;
      saveLocal(); $('imMsg').textContent = `Imported ${n} new entr${n===1?'y':'ies'}.`; sync().then(refreshAll); } catch (e) { $('imMsg').textContent = 'This file could not be read.'; } }; rd.readAsText(f); ev.target.value = ''; };
  resetForm(); fillRoutes(peaksSorted[0].id);
}
function fillRoutes(pid, sel){
  const rs = (routesByPeak[pid] || []).filter(r => !r.descent);
  $('lRoute').innerHTML = rs.map(r => `<option value="${r.idx}">${esc(r.name)} – ${esc(r.grade2)}${r.season.startsWith('Winter')?' (ski)':''}</option>`).join('') + '<option value="other">Other / own route</option>';
  if (sel != null) $('lRoute').value = sel;
  syncRoute();
}
function syncRoute(){ const v = $('lRoute').value; if (v === 'other') return; const r = D.routes[+v]; if (!r) return;
  $('lSeason').value = r.season.startsWith('Winter') ? 'Ski' : 'Summer'; $('lDays').value = effDays(r) || 2; if (!editing) $('lHut').value = r.start ? r.start.replace(/\s*\(\d+ m\)$/, '') : ''; }
function resetForm(){ editing = null; $('formTitle').textContent = 'Log a tour'; show('lCancel', false); $('lDate').value = new Date().toISOString().slice(0,10);
  ['lRouteOther','lHut','lPartners','lGear','lNotes'].forEach(i => $(i).value = ''); $('lResult').value = 'Summit'; $('lRating').value = ''; $('lTransport').selectedIndex = S.lift === '1' ? 0 : 1; }
function openLogForm(pid, ridx){ showView('log'); resetForm(); $('lPeak').value = pid; fillRoutes(pid, ridx != null ? ridx : undefined); }
function editEntry(id){ const e = LOG[id]; if (!e) return; resetForm(); editing = id; $('formTitle').textContent = 'Edit entry'; show('lCancel', true);
  $('lPeak').value = e.peak; fillRoutes(+e.peak, e.routeIdx != null ? e.routeIdx : 'other');
  Object.entries({ lDate:'date', lRouteOther:'routeOther', lResult:'result', lSeason:'season', lDays:'days', lHut:'hut', lTransport:'transport', lPartners:'partners', lGear:'gear', lRating:'rating', lNotes:'notes' }).forEach(([i, k]) => { if (e[k] != null) $(i).value = e[k]; });
  window.scrollTo({ top: 0, behavior: 'smooth' }); }
function saveEntry(){
  const pid = +$('lPeak').value; const rv = $('lRoute').value; const r = rv === 'other' ? null : D.routes[+rv];
  if (!$('lDate').value) return alert('Please add a date.');
  const id = editing || uuid();
  LOG[id] = { id, date: $('lDate').value, peak: pid, peakName: peakById[pid].name, alt: peakById[pid].alt,
    routeIdx: r ? r.idx : null, route: r ? r.name : ($('lRouteOther').value || 'Own route'), routeOther: $('lRouteOther').value, grade: r ? r.grade2 : '', gain: r ? r.up_hm : null,
    result: $('lResult').value, season: $('lSeason').value, days: +$('lDays').value || null, hut: $('lHut').value, transport: $('lTransport').value,
    partners: $('lPartners').value, gear: $('lGear').value, rating: $('lRating').value, notes: $('lNotes').value, updated: new Date().toISOString() };
  DIRTY[id] = 1; saveLocal(); setSync('Saving…'); resetForm(); fillRoutes(pid); renderLog(); sync().then(() => renderLog());
}
function renderLog(){
  if (!D) return;
  const sm = summited(); const ent = entries().sort((a, b) => b.date.localeCompare(a.date));
  const summits = ent.filter(e => e.result === 'Summit');
  const gain = summits.reduce((s, e) => s + (e.gain || 0), 0); const dsum = ent.reduce((s, e) => s + (e.days || 0), 0);
  const highest = summits.reduce((m, e) => Math.max(m, e.alt || 0), 0);
  $('kpis').innerHTML = `<div class="kpi"><b>${sm.size} / ${D.peaks.length}</b><span>4000ers done</span><div class="bar" style="margin-top:6px"><i style="width:${(100*sm.size/D.peaks.length).toFixed(0)}%"></i></div></div>
   <div class="kpi"><b>${ent.length}</b><span>log entries (${summits.length} summits, ${ent.length-summits.length} turned back)</span></div>
   <div class="kpi"><b>${dsum}</b><span>days in the mountains</span></div>
   <div class="kpi"><b>${gain.toLocaleString('de-CH')} m</b><span>height gain on logged routes</span></div>
   <div class="kpi"><b>${highest || '–'}${highest ? ' m' : ''}</b><span>highest summit</span></div>`;
  const f = $('hFilter').value, q = $('hSearch').value.toLowerCase();
  const list = ent.filter(e => (!f || e.result === f) && (!q || JSON.stringify(e).toLowerCase().includes(q)));
  let html = '', y = null;
  for (const e of list) {
    if (e.date.slice(0,4) !== y) { y = e.date.slice(0,4); const n = ent.filter(x => x.date.startsWith(y) && x.result === 'Summit').length; html += `<div class="year">${y} <span class="muted" style="font-weight:400">· ${n} summit${n!==1?'s':''}</span></div>`; }
    html += `<div class="entry"><div class="muted">${esc(e.date)}</div><div class="d"><b><a href="#" data-goto="${e.peak}">${esc(e.peakName)}</a></b> ${e.alt} m · ${esc(e.route)} ${e.grade?`<span class="g" style="background:${gcol(D.routes[e.routeIdx]?.gval)}">${esc(e.grade)}</span>`:''}
      <span class="pill ${e.result==='Summit'?'donep':'arch'}">${esc(e.result)}</span>${DIRTY[e.id]?' <span class="muted" title="Not yet synced">⟳</span>':''}
      <div class="muted">${[e.season, e.days?e.days+' day'+(e.days>1?'s':''):'', e.hut, e.transport, e.partners?'with '+e.partners:'', e.gear?'gear: '+e.gear:'', e.rating?'★'.repeat(+e.rating):''].filter(Boolean).map(esc).join(' · ')}</div>
      ${e.notes?`<div>${esc(e.notes)}</div>`:''}</div>
      <div style="display:flex;gap:6px"><button class="tag" data-edit="${e.id}">Edit</button><button class="btn del" data-del="${e.id}">Delete</button></div></div>`;
  }
  $('history').innerHTML = html || '<p class="muted">No entries yet. Log a tour above, or use "+ Log" next to any route in the Finder. Ticking "Done" on a peak also counts it as done.</p>';
  $('togo').innerHTML = peaksSorted.filter(p => !sm.has(p.id)).map(p => `<button class="tag" data-goto="${p.id}">${esc(p.name)} ${p.alt}</button>`).join('') || '<p>All 48 done. Congratulations!</p>';
}
function download(name, text, type){ const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }

// ---------- account
function renderAccount(){ $('accInfo').textContent = `Logged in as ${USER.email}${isAdmin() ? ' (admin)' : ''}.`; $('accName').value = PROFILE.display_name || ''; $('whoami').textContent = PROFILE.display_name || USER.email; }
$('accNameSave').onclick = async () => { PROFILE.display_name = $('accName').value.trim(); PROFILE._dirty = true; saveLocal(); await sync(); await sb.auth.updateUser({ data: { name: PROFILE.display_name } }); $('accNameMsg').textContent = 'Saved'; renderAccount(); setTimeout(() => $('accNameMsg').textContent = '', 2000); };
$('accPwSave').onclick = async () => { const a = $('accPw1').value, b = $('accPw2').value;
  if (a.length < 8) return $('accPwMsg').textContent = 'At least 8 characters.'; if (a !== b) return $('accPwMsg').textContent = 'The two passwords are different.';
  const { error } = await sb.auth.updateUser({ password: a }); $('accPwMsg').textContent = error ? error.message : 'Password changed.'; $('accPw1').value = $('accPw2').value = ''; };
$('logout').onclick = async () => { await sync(); await sb.auth.signOut(); local.del('data4000'); location.reload(); };

// ---------- admin
async function adminCall(body){ const { data, error } = await sb.functions.invoke('admin-users', { body });
  if (error) { let m = error.message; try { const j = await error.context.json(); m = j.error || m; } catch(e){} throw new Error(m); } return data; }
async function loadUsers(){ if (!isAdmin()) return; $('adUsers').innerHTML = '<p class="muted">Loading…</p>';
  try { const { users } = await adminCall({ action: 'list' });
    $('adUsers').innerHTML = `<table><tr><th>E-mail</th><th>Name</th><th class="hide-m">Created</th><th>Last login</th><th></th></tr>${users.sort((a,b)=>a.created_at.localeCompare(b.created_at)).map(u => `<tr>
      <td>${esc(u.email)}${u.is_admin?' <span class="pill norm">admin</span>':''}${u.must_change?' <span class="pill arch">temp password</span>':''}</td><td>${esc(u.name)}</td>
      <td class="hide-m n">${esc((u.created_at||'').slice(0,10))}</td><td class="n">${esc((u.last_sign_in_at||'never').slice(0,10))}</td>
      <td class="n">${u.is_admin?'':`<button class="tag" data-reset="${u.id}" data-email="${esc(u.email)}">New password</button> <button class="btn del" data-remove="${u.id}" data-email="${esc(u.email)}">Remove</button>`}</td></tr>`).join('')}</table>`;
  } catch (e) { $('adUsers').innerHTML = `<p class="err">${esc(e.message)}</p>`; } }
const credsBox = (email, pw) => `<div class="card" style="background:var(--bg)"><b>Send this to your friend:</b><br>App: <a href="${location.origin + location.pathname}">${esc(location.origin + location.pathname)}</a><br>E-mail: ${esc(email)}<br>Temporary password: <span class="pw">${esc(pw)}</span><br><span class="muted">They choose their own password at first login. This password is shown only once.</span><div style="margin-top:8px"><button class="btn sec" id="copyCreds">Copy message</button></div></div>`;
function wireCopy(email, pw){ const b = $('copyCreds'); if (b) b.onclick = () => { navigator.clipboard?.writeText(`Hi! Here is your access to my Swiss 4000ers app:\n${location.origin + location.pathname}\nE-mail: ${email}\nTemporary password: ${pw}\nYou'll choose your own password at first login. On iPhone: open the link in Safari → Share → Add to Home Screen.`); b.textContent = 'Copied'; }; }
$('adCreate').onclick = async () => { const email = $('adEmail').value.trim(); if (!email) return; $('adResult').textContent = 'Creating…';
  try { const r = await adminCall({ action: 'create', email, name: $('adName').value.trim() }); $('adResult').innerHTML = credsBox(r.email, r.password); wireCopy(r.email, r.password); $('adEmail').value = $('adName').value = ''; loadUsers(); }
  catch (e) { $('adResult').innerHTML = `<span class="err">${esc(e.message)}</span>`; } };
async function adminReset(id, email){ if (!confirm(`Create a new temporary password for ${email}?`)) return;
  try { const r = await adminCall({ action: 'reset', id }); $('adResult').innerHTML = credsBox(r.email, r.password); wireCopy(r.email, r.password); window.scrollTo(0,0); loadUsers(); } catch (e) { alert(e.message); } }
async function adminDelete(id, email){ if (!confirm(`Remove ${email}? Their account and log are deleted permanently.`)) return;
  try { await adminCall({ action: 'delete', id }); loadUsers(); } catch (e) { alert(e.message); } }

boot();
