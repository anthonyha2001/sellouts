/* ============================================================
   Delivery module: orders (quick-entry row), driver payments,
   reports, customers, drivers, settings. Ported from delivery.html.
   Everything lives inside this function so its names (db, $, today,
   loadAll, PAGES, ...) never clash with the other modules.
   Public API: window.Delivery = { start, show }.
   ============================================================ */
(function () {
/* ---------- constants & storage ---------- */
const PAYMENTS = ['Cash','Online','Credit Card','On Account'];
const PLATFORMS = ['Application','WhatsApp'];
const DEFAULT_AREAS = ['Achkout','Ain Rihane','Ajaltoun','Ballouneh','Batha','Bzommar','Daraya','Faraya','Feytroun','Ghosta','Hrajel','Jeita','Kfardebian','Kleiat','Mayrouba','Mrah El Mir','Reyfoun','Shaileh'];
// other spellings found in the customer list -> one clean name (keys: lowercase letters only)
const AREA_ALIASES = {ajaltoune:'Ajaltoun', ajatoun:'Ajaltoun', ajaltun:'Ajaltoun', shaile:'Shaileh', shaeily:'Shaileh', shaily:'Shaileh', shaileh:'Shaileh',
  raifoun:'Reyfoun', rayfoun:'Reyfoun', faitroun:'Feytroun', faytroun:'Feytroun', feitroun:'Feytroun', balloune:'Ballouneh', kleiaat:'Kleiat', klayat:'Kleiat'};
/* ================= DATABASE (Supabase) ================= */
// Uses the app-wide signed-in client `sb` (js/core/config.js). Access is enforced by RLS
// and the dt_orders_guard trigger; the role checks below only shape the UI.
const OLD_LOCAL_KEY = 'supermarket_delivery_tracker_v1';
const panel = document.getElementById('panel-delivery');

let db = {customers:[], drivers:[], orders:[], areas:[...DEFAULT_AREAS], currency:'$'};
function loadLast(){ try{ return JSON.parse(localStorage.getItem('dt_last')) || {}; }catch(e){ return {}; } }
db.last = Object.assign({platform:'WhatsApp', payment:'Cash', driverId:''}, loadLast());

const TBL = {
  drivers: { table:'dt_drivers',
    to: d => ({id:d.id, name:d.name, phone:d.phone || ''}),
    from: r => ({id:r.id, name:r.name, phone:r.phone || ''}) },
  customers: { table:'dt_customers',
    to: c => ({id:c.id, name:c.name, phone:c.phone || '', area:c.area || '', address:c.address || ''}),
    from: r => ({id:r.id, name:r.name, phone:r.phone || '', area:r.area || '', address:r.address || ''}) },
  orders: { table:'dt_orders',
    to: o => ({id:o.id, created:o.created || 0, order_date:o.date, customer_id:o.customerId || null,
      c_name:o.cName || '', c_phone:o.cPhone || '', c_area:o.cArea || '', c_address:o.cAddress || '',
      driver_id:o.driverId || null, amount:+o.amount || 0, platform:o.platform, payment:o.payment,
      paid:!!o.paid, paid_at:o.paidAt || null, note:o.note || ''}),
    from: r => ({id:r.id, created:+r.created || 0, date:r.order_date, customerId:r.customer_id,
      cName:r.c_name || '', cPhone:r.c_phone || '', cArea:r.c_area || '', cAddress:r.c_address || '',
      driverId:r.driver_id, amount:+r.amount, platform:r.platform, payment:r.payment,
      paid:!!r.paid, paidAt:r.paid_at || '', note:r.note || ''}) },
};
// snapshot of what the database has, so save() only sends what changed
const snap = {drivers:new Map(), customers:new Map(), orders:new Map()};
let snapSettings = '', syncTimer = null, syncing = false, syncAgain = false, syncState = 'loading', appStarted = false;
const settingsJSON = () => JSON.stringify({areas:db.areas, currency:db.currency});

function save(){
  try{ localStorage.setItem('dt_last', JSON.stringify(db.last)); }catch(e){}
  if(!appStarted) return;
  clearTimeout(syncTimer); syncTimer = setTimeout(sync, 100);
}
function setSync(state, msg){
  syncState = state;
  const el = document.getElementById('syncStatus'); if(!el) return;
  el.className = 'sync ' + state;
  el.querySelector('span').textContent = {saved:'Saved', saving:'Saving…', loading:'Loading…', error:'Not saved — retrying'}[state];
  el.title = msg || '';
}
async function sync(){
  if(!sb || !appStarted) return;
  if(syncing){ syncAgain = true; return; }
  syncing = true;
  try{
    for(const k of ['drivers','customers','orders']){
      const {table, to} = TBL[k];
      const cur = new Map(db[k].map(x => [x.id, JSON.stringify(to(x))]));
      const ups = []; for(const [id, j] of cur) if(snap[k].get(id) !== j) ups.push(j);
      const dels = [...snap[k].keys()].filter(id => !cur.has(id));
      if(ups.length || dels.length) setSync('saving');
      for(let i = 0; i < ups.length; i += 500){
        const chunk = ups.slice(i, i+500);
        const {error} = await sb.from(table).upsert(chunk.map(j => JSON.parse(j)));
        if(error) throw error;
        chunk.forEach(j => snap[k].set(JSON.parse(j).id, j));
      }
      for(let i = 0; i < dels.length; i += 200){
        const chunk = dels.slice(i, i+200);
        // RLS does not error on a forbidden delete, it just deletes nothing: compare counts.
        const {data, error} = await sb.from(table).delete().in('id', chunk).select('id');
        if(error) throw error;
        if((data || []).length < chunk.length) throw {code:'42501', message:''};
        chunk.forEach(id => snap[k].delete(id));
      }
    }
    const sv = settingsJSON();
    if(sv !== snapSettings){
      setSync('saving');
      const {error} = await sb.from('dt_settings').upsert({key:'app', value:JSON.parse(sv), updated_at:new Date().toISOString()});
      if(error) throw error;
      snapSettings = sv;
    }
    setSync('saved');
  }catch(err){
    console.error(err);
    if(isPermissionError(err)){
      // The database refused this change (role rules). Retrying would fail forever, so say why
      // and reload what the server really has, which drops the refused local change.
      showToast(friendlyError(err), true);
      syncAgain = false;
      await reloadFromServer();
    }else{
      setSync('error', err.message || String(err));
      clearTimeout(syncTimer); syncTimer = setTimeout(sync, 5000);   // keep retrying, nothing is lost
    }
  }finally{
    syncing = false;
    if(syncAgain){ syncAgain = false; sync(); }
  }
}
async function fetchAll(table){
  let out = [];
  for(let from = 0; ; from += 1000){
    const {data, error} = await sb.from(table).select('*').order('id').range(from, from + 999);
    if(error) throw error;
    out = out.concat(data);
    if(data.length < 1000) break;
  }
  return out;
}
async function loadAll(){
  const [d, c, o, st] = await Promise.all([fetchAll('dt_drivers'), fetchAll('dt_customers'), fetchAll('dt_orders'),
    sb.from('dt_settings').select('*').eq('key', 'app').maybeSingle()]);
  if(st.error) throw st.error;
  const put = (k, rows) => { db[k] = rows.map(TBL[k].from); snap[k] = new Map(db[k].map(x => [x.id, JSON.stringify(TBL[k].to(x))])); };
  put('drivers', d); put('customers', c); put('orders', o);
  const v = st.data?.value || {};
  db.areas = v.areas || [...DEFAULT_AREAS]; db.currency = v.currency || '$';
  snapSettings = st.data ? settingsJSON() : '';
}
async function reloadFromServer(){
  try{
    await loadAll();
    setSync('saved');
    refreshLists(); renderers[currentPage]?.();   // no page yet when Delivery was never opened
  }catch(err){
    console.error(err); setSync('error', friendlyError(err));
  }
}
// live changes from other computers
let renderTimer = null;
function scheduleRender(){
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    if(document.querySelector('dialog[open]')) return scheduleRender();
    refreshLists(); renderers[currentPage]?.();
  }, 250);
}
function applyRemote(k, p){
  const {to, from} = TBL[k];
  if(p.eventType === 'DELETE'){
    const id = p.old && p.old.id; if(!id || !snap[k].has(id)) return;
    snap[k].delete(id); db[k] = db[k].filter(x => x.id !== id);
  }else{
    const x = from(p.new), j = JSON.stringify(to(x));
    if(snap[k].get(x.id) === j) return;                 // our own change coming back
    snap[k].set(x.id, j);
    const cur = db[k].find(y => y.id === x.id);
    if(cur) Object.assign(cur, x); else db[k].push(x);
  }
  scheduleRender();
}
function subscribeRealtime(){
  const ch = sb.channel('delivery-tracker');
  for(const k of ['drivers','customers','orders'])
    ch.on('postgres_changes', {event:'*', schema:'public', table:TBL[k].table}, p => applyRemote(k, p));
  ch.on('postgres_changes', {event:'*', schema:'public', table:'dt_settings'}, p => {
    const v = p.new && p.new.value; if(!v) return;
    db.areas = v.areas || db.areas; db.currency = v.currency || db.currency; snapSettings = settingsJSON(); scheduleRender();
  });
  ch.subscribe();
}
window.addEventListener('beforeunload', e => { if(appStarted && syncState !== 'saved'){ e.preventDefault(); e.returnValue = ''; } });

/* ---------- start-up (called by auth.js after sign-in) ---------- */
let pendingPage = null;
function showBootError(msg){
  $('#dtBoot').hidden = false;
  $('#dtBoot').innerHTML = `<p><b>Could not load deliveries.</b></p><p>${esc(msg)}</p><button type="button" class="btn" id="dtRetry">Try again</button>`;
  $('#dtRetry').onclick = start;
  setSync('error', msg);
}
async function start(){
  setSync('loading');
  $('#dtBoot').hidden = false; $('#dtBoot').textContent = 'Loading deliveries…';
  try{ await loadAll(); }
  catch(err){ return showBootError(friendlyError(err)); }
  $('#dtBoot').hidden = true;
  appStarted = true;
  subscribeRealtime();
  setSync('saved');
  refreshLists();
  applyRoleUi();
  if(pendingPage !== null || panel.classList.contains('active')) show(pendingPage);
  if(window.can('delivery.manage')) offerLocalUpload();
}
// Called by the router whenever the Delivery section is opened (sub = page name or undefined).
function show(sub){
  if(!appStarted){ pendingPage = sub || ''; return; }
  go(sub || currentPage || firstPage());
  // Jump straight into the quick-entry row on a computer; on a phone that would pop the keyboard up.
  if(currentPage === 'orders' && matchMedia('(pointer:fine)').matches) setTimeout(() => qCust.focus(), 0);
}
// data typed before the database was connected (saved only in this browser)
async function offerLocalUpload(){
  let local = null; try{ local = JSON.parse(localStorage.getItem(OLD_LOCAL_KEY)); }catch(e){}
  if(!local || !((local.orders||[]).length || (local.customers||[]).length || (local.drivers||[]).length)) return;
  if(db.orders.length || db.customers.length || db.drivers.length) return;
  const ok = await uiConfirm(`This computer has data saved before the database was connected:\n${(local.customers||[]).length} customers, ${(local.drivers||[]).length} drivers, ${(local.orders||[]).length} orders.\n\nUpload it to the database?`, {title:'Upload saved data', ok:'Upload'});
  if(!ok) return;
  db.customers = local.customers || []; db.drivers = local.drivers || []; db.orders = local.orders || [];
  if(local.areas) db.areas = local.areas; if(local.currency) db.currency = local.currency;
  clearTimeout(syncTimer); await sync();
  if(syncState === 'saved'){ localStorage.setItem(OLD_LOCAL_KEY + '_uploaded', localStorage.getItem(OLD_LOCAL_KEY)); localStorage.removeItem(OLD_LOCAL_KEY); toast('Data uploaded', 'check'); }
  renderers[currentPage]?.();
}

/* ---------- icons (inline SVG, work offline) ---------- */
const ICONS = {
  cart:'<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  keyboard:'<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>',
  download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  upload:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  left:'<path d="m15 18-6-6 6-6"/>',
  right:'<path d="m9 18 6-6-6-6"/>',
  plus:'<path d="M5 12h14M12 5v14"/>',
  enter:'<path d="M20 4v7a4 4 0 0 1-4 4H4"/><path d="m9 10-5 5 5 5"/>',
  print:'<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  search:'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  edit:'<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  trash:'<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
  pin:'<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  phone:'<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z"/>',
  check:'<path d="M20 6 9 17l-5-5"/>',
  checkc:'<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  truck:'<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62L18.3 9.38a1 1 0 0 0-.78-.38H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
  info:'<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  help:'<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  alert:'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  cash:'<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
};
const ic = n => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;
panel.querySelectorAll('i[data-ic]').forEach(el => el.outerHTML = ic(el.dataset.ic));

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => db.currency + (+n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const toISO = d => d.toLocaleDateString('en-CA');
const today = () => beirutToday();   // Beirut date, same as the database's beirut_today()
const addDays = (s,n) => { const d = new Date(s+'T00:00:00'); d.setDate(d.getDate()+n); return toISO(d); };
const monthStart = s => s.slice(0,7)+'-01';
const monthEnd = ym => { const [y,m] = ym.split('-').map(Number); return `${ym}-${String(new Date(y,m,0).getDate()).padStart(2,'0')}`; };
const fmtDate = s => s ? s.split('-').reverse().join('/') : '';
const normPhone = p => String(p ?? '').replace(/\D/g,'');
const custLabel = c => c.phone ? `${c.name} — ${c.phone}` : c.name;
const driverName = id => (db.drivers.find(d => d.id === id) || {}).name || '(no driver)';
const platClass = p => p === 'WhatsApp' ? 'wa' : 'app';

/* ---------- custom dialogs (replace browser alert / confirm / prompt) ---------- */
function uiDialog({title = '', message = '', ok = 'OK', cancel = 'Cancel', danger = false, icon = 'info', fields = null}){
  return new Promise(resolve => {
    const d = $('#uiDlg'), f = $('#uiForm');
    $('#uiTitle').textContent = title; $('#uiTitle').hidden = !title;
    $('#uiMsg').textContent = message; $('#uiMsg').hidden = !message;
    $('#uiIcon').innerHTML = ic(icon); $('#uiIcon').className = 'ui-icon ' + (danger ? 'danger' : icon === 'checkc' ? 'ok' : '');
    $('#uiOk').textContent = ok; $('#uiOk').className = 'btn ' + (danger ? 'danger-fill' : 'primary');
    $('#uiCancel').hidden = cancel === null; $('#uiCancel').textContent = cancel || '';
    $('#uiFields').innerHTML = (fields || []).map((x,i) => `<label>${esc(x.label || '')}<input data-i="${i}" value="${esc(x.value || '')}" placeholder="${esc(x.placeholder || '')}" autocomplete="off"></label>`).join('');
    $('#uiFields').hidden = !fields;
    const done = v => { f.onsubmit = null; d.oncancel = null; d.close(); resolve(v); };
    f.onsubmit = e => {
      e.preventDefault();
      if(!fields) return done(true);
      const vals = [...$('#uiFields').querySelectorAll('input')].map(i => i.value);
      if(fields.some((x,i) => x.required && !vals[i].trim())){ const i = fields.findIndex((x,i) => x.required && !vals[i].trim()); $('#uiFields').querySelectorAll('input')[i].focus(); return; }
      done(vals);
    };
    $('#uiCancel').onclick = () => done(fields ? null : false);
    d.oncancel = e => { e.preventDefault(); done(fields ? null : false); };
    d.showModal();
    const first = $('#uiFields').querySelector('input');
    if(first){ first.focus(); first.select(); } else $('#uiOk').focus();
  });
}
const uiConfirm = (message, o = {}) => uiDialog({title:o.title || 'Are you sure?', message, ok:o.ok || 'Confirm', danger:!!o.danger, icon:o.icon || (o.danger ? 'alert' : 'help')});
const uiAlert = (message, o = {}) => uiDialog({title:o.title || '', message, ok:'OK', cancel:null, icon:o.icon || 'info', danger:!!o.danger});
const uiForm = (title, fields, o = {}) => uiDialog({title, message:o.message || '', ok:o.ok || 'Save', icon:o.icon || 'edit', danger:!!o.danger, fields});

// Uses the app-wide toast (js/app.js); the icon argument is kept for call-site compatibility.
function toast(msg, icon){ showToast(msg); }
function options(list, sel, first){ return (first ? `<option value="">${first}</option>` : '') + list.map(v => { const [val,txt] = Array.isArray(v) ? v : [v,v]; return `<option value="${esc(val)}" ${val===sel?'selected':''}>${esc(txt)}</option>`; }).join(''); }

function allAreas(){
  const map = new Map();
  [...db.areas, ...db.customers.map(c => c.area)].forEach(a => { if(a && !map.has(a.toLowerCase())) map.set(a.toLowerCase(), a); });
  return [...map.values()].sort((a,b) => a.localeCompare(b));
}
const areaKey = a => String(a||'').toLowerCase().replace(/[^a-z\u0600-\u06ff]/g, '');
const titleCase = a => a.toLowerCase().replace(/(^|[\s-])\S/g, m => m.toUpperCase());
function canonArea(a){
  a = String(a||'').trim().replace(/[.\s]+$/, ''); if(!a) return '';
  let k = areaKey(a);
  if(AREA_ALIASES[k]) k = areaKey(AREA_ALIASES[k]);
  const hit = allAreas().find(x => areaKey(x) === k) || DEFAULT_AREAS.find(x => areaKey(x) === k);
  if(hit) return hit;
  return a === a.toUpperCase() ? titleCase(a) : a;      // "MRAH EL MIR" -> "Mrah El Mir"
}
// Lebanese numbers -> "76-482453"; unknown formats are kept as written
function fmtPhone(p){
  const raw = String(p ?? '').trim(); let d = raw.replace(/\D/g, '');
  if(!d) return '';
  if(d.startsWith('00961')) d = d.slice(5); else if(d.startsWith('961')) d = d.slice(3);
  if(d.length === 7 && d[0] === '3') d = '0' + d;
  return d.length === 8 ? d.slice(0,2) + '-' + d.slice(2) : raw;
}
function refreshLists(){
  $('#custList').innerHTML = db.customers.map(c => `<option value="${esc(custLabel(c))}">`).join('');
  $('#areaList').innerHTML = allAreas().map(a => `<option value="${esc(a)}">`).join('');
}

/* ---------- navigation ---------- */
const renderers = {orders:renderOrders, settle:renderSettle, reports:renderReports, customers:renderCustomers, drivers:renderDrivers, settings:renderSettings};
const ALL_PAGES = ['orders','settle','reports','customers','drivers','settings'];
let PAGES = ALL_PAGES;          // pages this role can open, in order (keys 1..n)
let currentPage = '';
const firstPage = () => PAGES[0] || 'orders';
function go(p){
  if(!renderers[p] || !PAGES.includes(p)) p = firstPage();
  currentPage = p;
  $('#dtNav').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.page === p));
  panel.querySelectorAll('.page').forEach(s => s.hidden = s.id !== 'page-'+p);
  if(location.hash !== '#delivery/'+p) history.replaceState(null,'','#delivery/'+p);
  renderers[p]();
}
$('#dtNav').addEventListener('click', e => { const b = e.target.closest('button'); if(b) go(b.dataset.page); });

/* ---------- permission rules (UI only; RLS + the dt_orders_guard trigger enforce them) ---------- */
// window.can = the app-wide permission check (js/core/permissions.js); this local \`can\` shadows it here.
const perm = (...p) => window.can(...p);
const can = {
  deleteOrder: () => perm('delivery.manage'),
  // delivery.manage: any order; delivery.orders: only orders dated today (Beirut); others: none.
  editOrder: o => perm('delivery.manage') || (perm('delivery.orders') && o.date === today()),
  createOrder: () => perm('delivery.orders', 'delivery.manage'),
  markPaid: () => perm('delivery.settle'),
  manageCustomers: () => perm('delivery.customers'),
};
function applyRoleUi(){
  PAGES = ALL_PAGES.filter(canSeeDeliveryPage);
  $('#dtNav').querySelectorAll('button').forEach(b => {
    const i = PAGES.indexOf(b.dataset.page);
    b.hidden = i < 0;
    b.querySelector('kbd').textContent = i + 1;
  });
  $('#dtNav').hidden = PAGES.length < 2;
  $('#helpNumKeys').textContent = PAGES.length > 1 ? `1 … ${PAGES.length}` : '';
}
panel.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());

/* ================= ORDERS ================= */
const OF = {day:today(), driver:'', status:'', pay:'', plat:'', q:''};
const fIds = {day:'#fDay', driver:'#fDriver', status:'#fStatus', pay:'#fPay', plat:'#fPlat', q:'#fSearch'};
Object.entries(fIds).forEach(([k,sel]) => $(sel).addEventListener('input', e => { OF[k] = e.target.value; renderOrders(); }));
let orderIds = [], selId = null, flashId = null;
const openIds = new Set();
function dayList(){ const s = new Set(db.orders.map(o => o.date)); s.add(today()); return [...s].sort().reverse(); }
function dayLabel(d){
  if(d === today()) return 'Today';
  if(d === addDays(today(), -1)) return 'Yesterday';
  return new Date(d+'T00:00:00').toLocaleDateString('en-GB', {weekday:'short', day:'2-digit', month:'2-digit', year:'numeric'});
}
function goDay(d){ OF.day = d; OF.q = ''; renderOrders(); }
function shiftDay(step){ // step +1 = newer, -1 = older (only days that have orders)
  const L = dayList(); let i = L.indexOf(OF.day); if(i < 0) i = 0;
  goDay(L[Math.max(0, Math.min(L.length-1, i - step))]);
}
$('#dayPrev').onclick = () => shiftDay(-1);
$('#dayNext').onclick = () => shiftDay(1);
$('#dayToday').onclick = () => goDay(today());

function filteredOrders(){
  const q = OF.q.trim().toLowerCase(), qd = normPhone(q);
  return db.orders.filter(o =>
    (OF.q.trim() ? true : o.date === OF.day) &&
    (!OF.driver || o.driverId === OF.driver) &&
    (!OF.status || (OF.status === 'paid') === !!o.paid) &&
    (!OF.pay || o.payment === OF.pay) && (!OF.plat || o.platform === OF.plat) &&
    (!q || [o.cName,o.cArea,o.cAddress,o.note,driverName(o.driverId)].join(' ').toLowerCase().includes(q) || (qd.length >= 3 && normPhone(o.cPhone).includes(qd)))
  ).sort((a,b) => b.date.localeCompare(a.date) || b.created - a.created);
}

function renderOrders(){
  $('#fSearch').value = OF.q; $('#fStatus').value = OF.status;
  const counts = {};
  db.orders.forEach(o => { const c = counts[o.date] || (counts[o.date] = {n:0, t:0}); c.n++; c.t += +o.amount||0; });
  $('#fDay').innerHTML = options(dayList().map(d => [d, `${dayLabel(d)} — ${counts[d]?.n || 0} orders · ${money(counts[d]?.t || 0)}`]), OF.day);
  $('#fDay').disabled = !!OF.q.trim();
  $('#fDriver').innerHTML = options(db.drivers.map(d => [d.id,d.name]), OF.driver, 'All drivers');
  $('#fPay').innerHTML = options(PAYMENTS, OF.pay, 'All');
  $('#fPlat').innerHTML = options(PLATFORMS, OF.plat, 'All');
  const qd = $('#qDriver'), keepDrv = qd.value || db.last.driverId;
  qd.innerHTML = options(db.drivers.map((d,i) => [d.id, `${i+1} · ${d.name}`]), keepDrv, 'Driver…');
  const list = filteredOrders();
  const total = list.reduce((s,o) => s + (+o.amount||0), 0);
  const unpaid = list.filter(o => !o.paid);
  $('#ordersSummary').innerHTML = `${OF.q.trim() ? `<span>${ic('search')} <b>Searching all days</b></span>` : `<span><b>${esc(dayLabel(OF.day))}</b></span>`}<span><b>${list.length}</b> orders</span><span>Total <b>${money(total)}</b></span><span>AOV <b>${money(list.length ? total/list.length : 0)}</b></span><span>Unpaid <b style="color:var(--red)">${unpaid.length} · ${money(unpaid.reduce((s,o)=>s+(+o.amount||0),0))}</b></span>`;
  $('#ordersBody').innerHTML = list.length ? list.map(o => `
    <tr class="row ${o.id===selId?'sel':''} ${openIds.has(o.id)?'open':''} ${o.id===flashId?'flash':''}" data-id="${o.id}">
      <td class="exp">${ic('right')}</td>
      <td><b>${esc(o.cName)}</b>${OF.q.trim() ? `<div class="muted" style="font-size:12px">${fmtDate(o.date)}</div>` : ''}</td>
      <td>${esc(driverName(o.driverId))}</td>
      <td>${esc(o.cArea)}</td>
      <td class="num">${money(o.amount)}</td>
      <td><span class="tag ${platClass(o.platform)}">${esc(o.platform)}</span></td>
      <td>${esc(o.payment)}</td>
      <td><button class="status ${o.paid?'paid':'unpaid'}" data-act="toggle" ${can.markPaid() ? 'title="Click to change"' : 'disabled'}>${o.paid?'Paid':'Unpaid'}</button></td>
      <td class="actions">${can.editOrder(o) ? `<button data-act="edit" title="Edit">${ic('edit')}</button>` : ''}${can.deleteOrder() ? `<button data-act="del" title="Delete">${ic('trash')}</button>` : ''}</td>
    </tr>
    <tr class="detail" data-for="${o.id}" ${openIds.has(o.id)?'':'hidden'}><td></td><td colspan="8"><div class="detail-grid">
      <div><span>Phone</span>${o.cPhone ? `<a href="tel:${esc(normPhone(o.cPhone))}">${esc(o.cPhone)}</a>` : '—'}</div>
      <div><span>Area</span>${esc(o.cArea) || '—'}</div>
      <div><span>Address</span>${esc(o.cAddress) || '—'}</div>
      ${o.note ? `<div><span>Note</span>${esc(o.note)}</div>` : ''}
      ${o.paid && o.paidAt ? `<div><span>Paid on</span>${fmtDate(o.paidAt)}</div>` : ''}
    </div></td></tr>`).join('')
    : `<tr><td colspan="9" class="empty">${OF.q.trim() ? 'No orders match your search.' : 'No orders on this day yet.'}${db.drivers.length ? '' : ' Start by adding a driver in the Drivers tab.'}</td></tr>`;
  orderIds = list.map(o => o.id);
  if(selId && !orderIds.includes(selId)) selId = null;
  flashId = null;
}

// One activity-log entry per order change (the database also stamps created_by / updated_by).
function logOrder(action, o, summary, details){
  logActivity('delivery', action, {type:'order', id:o.id}, summary,
    Object.assign({customer:o.cName, amount:+o.amount, date:o.date, driver:driverName(o.driverId)}, details || {}));
}
function togglePaid(o){
  if(!can.markPaid()) return;
  o.paid = !o.paid; o.paidAt = o.paid ? today() : ''; save(); renderOrders(); toast(`${o.cName}: ${o.paid ? 'Paid' : 'Unpaid'}`);
  logOrder(o.paid ? 'marked_paid' : 'marked_unpaid', o, `${o.cName} (${money(o.amount)}) marked ${o.paid ? 'paid' : 'unpaid'}`);
}
async function deleteOrder(o){
  if(!can.deleteOrder()) return;
  if(!(await uiConfirm(`Delete the order for ${o.cName} (${money(o.amount)})?`, {title:'Delete order', ok:'Delete', danger:true}))) return;
  const i = orderIds.indexOf(o.id);
  db.orders = db.orders.filter(x => x !== o); save();
  logOrder('delete', o, `Deleted order for ${o.cName} (${money(o.amount)}, ${fmtDate(o.date)})`);
  selId = orderIds[i+1] || orderIds[i-1] || null; renderOrders();
}
function toggleDetail(id){
  openIds.has(id) ? openIds.delete(id) : openIds.add(id);
  const tr = document.querySelector(`#ordersBody tr.row[data-id="${id}"]`); if(!tr) return;
  const open = openIds.has(id); tr.classList.toggle('open', open); tr.nextElementSibling.hidden = !open;
}
function markSel(){
  document.querySelectorAll('#ordersBody tr.row').forEach(tr => { const on = tr.dataset.id === selId; tr.classList.toggle('sel', on); if(on) tr.scrollIntoView({block:'nearest'}); });
}
$('#ordersBody').addEventListener('click', e => {
  const tr = e.target.closest('tr.row'); if(!tr) return;
  const o = db.orders.find(x => x.id === tr.dataset.id);
  selId = o.id; markSel();
  const act = e.target.closest('[data-act]')?.dataset.act;
  if(act === 'toggle') return togglePaid(o);
  if(act === 'edit') return can.editOrder(o) && openOrder(o);
  if(act === 'del') return deleteOrder(o);
  toggleDetail(o.id);
});

/* order dialog */
let editingOrder = null;
const oForm = $('#orderForm');
function noDrivers(){
  if(window.can('delivery.manage')){ uiAlert('Add at least one driver first in the Drivers page.', {title:'No drivers yet'}); go('drivers'); }
  else uiAlert('There are no drivers yet. Ask the admin to add them.', {title:'No drivers yet'});
}
function openOrder(o){
  if(o ? !can.editOrder(o) : !can.createOrder()) return;
  if(!db.drivers.length) return noDrivers();
  editingOrder = o || null;
  refreshLists();
  $('#orderTitle').textContent = o ? 'Edit order' : 'New order';
  oForm.driverId.innerHTML = options(db.drivers.map(d => [d.id,d.name]), o?.driverId, 'Choose driver…');
  oForm.platform.innerHTML = options(PLATFORMS, o?.platform || 'WhatsApp');
  oForm.payment.innerHTML = options(PAYMENTS, o?.payment || 'Cash');
  const c = o && db.customers.find(x => x.id === o.customerId);
  oForm.customer.value = o ? (c ? custLabel(c) : o.cName) : '';
  oForm.customer._cust = c || null;
  oForm.amount.value = o?.amount ?? '';
  oForm.paid.checked = !!o?.paid;
  oForm.note.value = o?.note || '';
  updateCustHint();
  $('#orderDlg').showModal();
  (o ? oForm.amount : oForm.customer).focus();
}
function findCustomer(str){
  str = String(str||'').trim(); if(!str) return null;
  let c = db.customers.find(x => custLabel(x) === str); if(c) return c;
  const d = normPhone(str);
  if(d.length >= 6){ c = db.customers.filter(x => normPhone(x.phone).endsWith(d) || d.endsWith(normPhone(x.phone)) && normPhone(x.phone).length >= 6); if(c.length === 1) return c[0]; }
  c = db.customers.filter(x => x.name.toLowerCase() === str.toLowerCase()); return c.length === 1 ? c[0] : null;
}
const resolveCust = inp => (inp._cust && inp.value === custLabel(inp._cust)) ? inp._cust : findCustomer(inp.value);
const prefillFrom = t => /^[\d\s+\-()\/]+$/.test(t) ? {phone:t} : {name:t};
function updateCustHint(){
  const c = resolveCust(oForm.customer);
  $('#custHint').innerHTML = c ? `${ic('pin')}${esc([c.area, c.address].filter(Boolean).join(' – ') || 'no address')} &nbsp; ${ic('phone')}${esc(c.phone || '—')}` : (oForm.customer.value ? 'Not found — pick from the list or click “New”' : '');
  $('#custHint').style.color = c || !oForm.customer.value ? '' : 'var(--red)';
}
oForm.customer.addEventListener('input', updateCustHint);
$('#newOrderBtn').onclick = () => focusQuick();
function dlgMemory(c){
  if(editingOrder || !c) return;
  const last = lastOrderOf(c); if(!last) return;
  if(PLATFORMS.includes(last.platform)) oForm.platform.value = last.platform;
  if(PAYMENTS.includes(last.payment)) oForm.payment.value = last.payment;
}
const dlgPicked = c => { oForm.customer._cust = c; oForm.customer.value = custLabel(c); updateCustHint(); dlgMemory(c); oForm.amount.focus(); };
$('#quickCust').onclick = () => openCustomer(null, dlgPicked, prefillFrom(oForm.customer.value.trim()));

oForm.addEventListener('submit', e => {
  e.preventDefault();
  const c = resolveCust(oForm.customer);
  const keepOld = editingOrder && !c && oForm.customer.value === editingOrder.cName;
  if(!c && !keepOld){ uiAlert('Choose a customer from the list, or add a new one with the New button.', {title:'Customer not found', icon:'alert'}); return; }
  const o = editingOrder || {id:uid(), created:Date.now()};
  const wasPaid = !!o.paid;
  const before = editingOrder ? {...editingOrder} : null;
  Object.assign(o, {
    date: editingOrder ? editingOrder.date : today(), driverId: oForm.driverId.value, amount: Math.round(parseFloat(oForm.amount.value)*100)/100,
    platform: oForm.platform.value, payment: oForm.payment.value, paid: oForm.paid.checked, note: oForm.note.value.trim()
  });
  if(c) Object.assign(o, {customerId:c.id, cName:c.name, cPhone:c.phone, cArea:c.area, cAddress:c.address});
  if(o.paid && !wasPaid) o.paidAt = today();
  if(!o.paid) o.paidAt = '';
  if(!editingOrder) db.orders.push(o);
  save(); $('#orderDlg').close(); toast(editingOrder ? 'Order updated' : 'Order added');
  if(before){
    const changed = {};
    ['cName','driverId','amount','platform','payment','paid','note'].forEach(k => { if(String(before[k] ?? '') !== String(o[k] ?? '')) changed[k] = {from:before[k] ?? null, to:o[k] ?? null}; });
    if(Object.keys(changed).length) logOrder('edit', o, `Edited order for ${o.cName} (${money(o.amount)})`, {changed});
  }else logOrder('create', o, `New order: ${o.cName} ${money(o.amount)} · ${driverName(o.driverId)}`);
  if(!editingOrder) OF.day = o.date;
  renderOrders();
});

$('#exportOrders').onclick = () => {
  if(!window.XLSX) return uiAlert('The Excel tool could not load. Check the internet connection and reload the page.', {title:'Excel not available', icon:'alert'});
  const rows = filteredOrders().map(o => ({Date:fmtDate(o.date), Customer:o.cName, Phone:o.cPhone, Area:o.cArea, Address:o.cAddress, Driver:driverName(o.driverId), Amount:+o.amount, Platform:o.platform, Payment:o.payment, Status:o.paid?'Paid':'Unpaid', 'Paid on':fmtDate(o.paidAt), Note:o.note}));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Orders');
  XLSX.writeFile(wb, `orders_${OF.q.trim() ? 'search' : OF.day}.xlsx`);
};

/* ================= DRIVER PAYMENTS ================= */
let settleDriver = '', settlePay = '', settleCursor = null, settleIds = [];
const settleSel = new Set();
function renderSettle(){
  const cards = db.drivers.map(d => {
    const un = db.orders.filter(o => o.driverId === d.id && !o.paid);
    const amt = un.reduce((s,o) => s + (+o.amount||0), 0);
    return `<button class="dcard ${d.id===settleDriver?'sel':''} ${un.length?'':'zero'}" data-id="${d.id}"><b>${esc(d.name)}</b><div class="due">${money(amt)}</div><div class="muted">${un.length} unpaid order${un.length===1?'':'s'}</div></button>`;
  });
  $('#settleCards').innerHTML = cards.join('') || '<div class="empty">No drivers yet — add them in the Drivers tab.</div>';
  const panel = $('#settlePanel');
  if(!settleDriver){ panel.innerHTML = db.drivers.length ? '<p class="keys-hint">Click a driver, or press <kbd>→</kbd> to start.</p>' : ''; return; }
  const list = db.orders.filter(o => o.driverId === settleDriver && !o.paid && (!settlePay || o.payment === settlePay)).sort((a,b) => a.date.localeCompare(b.date));
  settleIds = list.map(o => o.id);
  [...settleSel].forEach(id => { if(!settleIds.includes(id)) settleSel.delete(id); });
  if(!settleIds.includes(settleCursor)) settleCursor = settleIds[0] || null;
  const selTotal = list.filter(o => settleSel.has(o.id)).reduce((s,o) => s + (+o.amount||0), 0);
  panel.innerHTML = `<div class="keys-hint"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Space</kbd> tick · <kbd>A</kbd> select all · <kbd>Enter</kbd> mark as paid · <kbd>←</kbd><kbd>→</kbd> change driver</div>
  <div class="card table-wrap">
    <div class="toolbar" style="padding:14px 14px 0"><h3 style="margin:0">${esc(driverName(settleDriver))} — unpaid orders</h3><div class="spacer"></div>
      <label>Payment type<select id="settlePay">${options(PAYMENTS, settlePay, 'All')}</select></label></div>
    <table class="tbl"><thead><tr><th><input type="checkbox" id="selAll" ${list.length && settleSel.size===list.length?'checked':''}></th><th>Date</th><th>Customer</th><th>Area</th><th>Platform</th><th>Payment</th><th class="num">Amount</th></tr></thead>
    <tbody id="settleBody">${list.map(o => `<tr data-id="${o.id}" class="${o.id===settleCursor?'sel':''}" style="cursor:pointer"><td><input type="checkbox" tabindex="-1" ${settleSel.has(o.id)?'checked':''}></td><td>${fmtDate(o.date)}</td><td><b>${esc(o.cName)}</b><div class="muted">${esc(o.cPhone)}</div></td><td>${esc(o.cArea)}</td><td><span class="tag ${platClass(o.platform)}">${esc(o.platform)}</span></td><td>${esc(o.payment)}</td><td class="num">${money(o.amount)}</td></tr>`).join('') || `<tr><td colspan="7" class="empty">${ic('checkc')} Nothing to pay — all settled</td></tr>`}</tbody></table>
    ${list.length ? `<div class="settle-foot"><span>Selected: <b>${settleSel.size}</b> of ${list.length}</span><span class="total">${money(selTotal)}</span><div class="spacer"></div><button class="btn primary" id="markPaid" ${settleSel.size?'':'disabled'}>${ic('check')} Mark selected as paid <kbd>Enter</kbd></button></div>` : ''}
  </div>`;
  $('#settlePay').onchange = e => { settlePay = e.target.value; renderSettle(); };
  $('#selAll') && ($('#selAll').onchange = () => settleSelectAll());
  $('#settleBody').onclick = e => { const tr = e.target.closest('tr[data-id]'); if(!tr) return; const id = tr.dataset.id; settleCursor = id; settleSel.has(id) ? settleSel.delete(id) : settleSel.add(id); renderSettle(); };
  const mp = $('#markPaid'); if(mp) mp.onclick = settleMarkPaid;
  panel.querySelector('tr.sel')?.scrollIntoView({block:'nearest'});
}
function settleSelectAll(){
  const all = settleIds.length && settleIds.every(id => settleSel.has(id));
  settleIds.forEach(id => all ? settleSel.delete(id) : settleSel.add(id)); renderSettle();
}
async function settleMarkPaid(){
  if(!settleSel.size) return;
  const total = db.orders.filter(o => settleSel.has(o.id)).reduce((s,o) => s + (+o.amount||0), 0);
  if(!(await uiConfirm(`Mark ${settleSel.size} order${settleSel.size>1?'s':''} as paid for ${money(total)}?`, {title:`${driverName(settleDriver)} is paying`, ok:'Mark as paid', icon:'cash'}))) return;
  const t = today();
  const paidNow = db.orders.filter(o => settleSel.has(o.id));
  paidNow.forEach(o => { o.paid = true; o.paidAt = t; });
  logActivity('delivery', 'marked_paid', {type:'driver', id:settleDriver},
    `${driverName(settleDriver)} paid ${paidNow.length} order${paidNow.length>1?'s':''} (${money(total)})`,
    {orders: paidNow.map(o => o.id), total});
  save(); settleSel.clear(); toast('Orders marked as paid'); renderSettle();
}
$('#settleCards').addEventListener('click', e => { const b = e.target.closest('.dcard'); if(!b) return; settleDriver = b.dataset.id; settleSel.clear(); settleCursor = null; renderSettle(); });

/* ================= REPORTS ================= */
['#rPeriod','#rMonth','#rFrom','#rTo','#rDriver'].forEach(s => $(s).addEventListener('input', renderReports));
$('#rMonth').value = today().slice(0,7);
// Print only the report: body.printing-delivery hides the rest of the app (css/delivery.css).
$('#printReport').onclick = () => {
  document.body.classList.add('printing-delivery');
  window.addEventListener('afterprint', () => document.body.classList.remove('printing-delivery'), {once:true});
  window.print();
};
$('#rFrom').value = monthStart(today()); $('#rTo').value = today();
function reportRange(){
  const v = $('#rPeriod').value, t = today();
  $('#rMonth').hidden = v !== 'month'; $('#rFrom').hidden = $('#rTo').hidden = v !== 'custom';
  if(v === 'today') return [t, t, 'Today — ' + fmtDate(t)];
  if(v === 'yesterday'){ const y = addDays(t,-1); return [y, y, 'Yesterday — ' + fmtDate(y)]; }
  if(v === 'thismonth') return [monthStart(t), t, `This month — ${fmtDate(monthStart(t))} to ${fmtDate(t)}`];
  if(v === 'lastmonth'){ const lm = addDays(monthStart(t), -1).slice(0,7); return [lm+'-01', monthEnd(lm), 'End of month report — ' + monthName(lm)]; }
  if(v === 'month'){ const m = $('#rMonth').value || t.slice(0,7); return [m+'-01', monthEnd(m), 'End of month report — ' + monthName(m)]; }
  return [$('#rFrom').value, $('#rTo').value, `${fmtDate($('#rFrom').value)} to ${fmtDate($('#rTo').value)}`];
}
const monthName = ym => new Date(ym+'-01T00:00:00').toLocaleDateString('en-US',{month:'long',year:'numeric'});

function stats(list){
  const s = {count:list.length, total:0, paid:0, unpaid:0, pay:{}, plat:{}, drv:{}, area:{}, days:{}};
  PAYMENTS.forEach(p => s.pay[p] = {count:0, total:0, cust:new Set()});
  PLATFORMS.forEach(p => s.plat[p] = {count:0, total:0, cust:new Set()});
  for(const o of list){
    const a = +o.amount || 0, cust = o.customerId || o.cName, ar = o.cArea || '(no area)';
    s.total += a; o.paid ? s.paid += a : s.unpaid += a;
    for(const [bucket,key] of [[s.pay,o.payment],[s.plat,o.platform]]){ const b = bucket[key] || (bucket[key] = {count:0,total:0,cust:new Set()}); b.count++; b.total += a; b.cust.add(cust); }
    const d = s.drv[o.driverId] || (s.drv[o.driverId] = {count:0,total:0,unpaid:0,areas:{}}); d.count++; d.total += a; if(!o.paid) d.unpaid += a; d.areas[ar] = (d.areas[ar]||0) + 1;
    const A = s.area[ar] || (s.area[ar] = {count:0,total:0}); A.count++; A.total += a;
    const D = s.days[o.date] || (s.days[o.date] = {count:0,total:0}); D.count++; D.total += a;
  }
  s.aov = s.count ? s.total/s.count : 0;
  s.customers = new Set(list.map(o => o.customerId || o.cName)).size;
  return s;
}
const pct = (a,b) => b ? (a/b*100).toFixed(1)+'%' : '0%';

let reportMode = 'sales';     // 'sales' | 'customers'
$('#rMode').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if(!b) return; reportMode = b.dataset.mode; renderReports(); });
function renderReports(){
  $('#rMode').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.mode === reportMode));
  panel.querySelectorAll('.r-sales-only').forEach(x => x.hidden = reportMode !== 'sales');
  $('#reportBody').hidden = reportMode !== 'sales';
  $('#custReport').hidden = reportMode !== 'customers';
  if(reportMode === 'customers') return renderCustReport();
  $('#rDriver').innerHTML = options(db.drivers.map(d => [d.id,d.name]), $('#rDriver').value, 'All drivers');
  const [from,to,title] = reportRange(), drv = $('#rDriver').value;
  const list = db.orders.filter(o => (!from || o.date >= from) && (!to || o.date <= to) && (!drv || o.driverId === drv));
  const s = stats(list);
  const table = (head, rows) => `<table class="tbl"><thead><tr>${head.map((h,i) => `<th class="${i?'num':''}">${h}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${head.length}" class="empty">No data</td></tr>`}</tbody></table>`;
  const byTotal = obj => Object.entries(obj).sort((a,b) => b[1].total - a[1].total);

  const payRows = byTotal(s.pay).map(([k,v]) => `<tr><td>${esc(k)}</td><td class="num">${v.count}</td><td class="num">${v.cust.size}</td><td class="num">${money(v.total)}</td><td class="num">${pct(v.total,s.total)}</td></tr>`);
  const platRows = byTotal(s.plat).map(([k,v]) => `<tr><td><span class="tag ${platClass(k)}">${esc(k)}</span></td><td class="num">${v.count}</td><td class="num">${v.cust.size}</td><td class="num">${money(v.total)}</td><td class="num">${money(v.count ? v.total/v.count : 0)}</td></tr>`);
  const drvRows = byTotal(s.drv).map(([id,v]) => `<tr><td><b>${esc(driverName(id))}</b><div style="margin-top:4px">${Object.entries(v.areas).sort((a,b)=>b[1]-a[1]).map(([a,n]) => `<span class="tag area">${esc(a)} × ${n}</span>`).join('')}</div></td><td class="num">${v.count}</td><td class="num">${money(v.total)}</td><td class="num">${money(v.total/v.count)}</td><td class="num" style="color:${v.unpaid?'var(--red)':'inherit'}">${money(v.unpaid)}</td></tr>`);
  const areaRows = byTotal(s.area).map(([k,v]) => `<tr><td>${esc(k)}</td><td class="num">${v.count}</td><td class="num">${money(v.total)}</td><td class="num">${money(v.total/v.count)}</td></tr>`);
  const dayRows = Object.entries(s.days).sort().map(([d,v]) => `<tr><td>${fmtDate(d)}</td><td class="num">${v.count}</td><td class="num">${money(v.total)}</td><td class="num">${money(v.total/v.count)}</td></tr>`);

  $('#reportBody').innerHTML = `
    <h3 class="report-title">${esc(title)}${drv ? ' · Driver: ' + esc(driverName(drv)) : ''}</h3>
    <div class="kpis">
      <div class="kpi"><span>Orders</span><b>${s.count}</b></div>
      <div class="kpi"><span>Total sales</span><b>${money(s.total)}</b></div>
      <div class="kpi"><span>Average order value (AOV)</span><b>${money(s.aov)}</b></div>
      <div class="kpi"><span>Customers served</span><b>${s.customers}</b></div>
      <div class="kpi"><span>Collected (paid)</span><b style="color:var(--green)">${money(s.paid)}</b></div>
      <div class="kpi"><span>Outstanding (unpaid)</span><b style="color:var(--red)">${money(s.unpaid)}</b></div>
    </div>
    <div class="grid-2">
      <div class="card table-wrap"><h3 style="padding:14px 14px 0">By payment method</h3>${table(['Method','Orders','Customers','Total','% of sales'], payRows)}</div>
      <div class="card table-wrap"><h3 style="padding:14px 14px 0">By platform</h3>${table(['Platform','Orders','Customers','Total','AOV'], platRows)}</div>
    </div>
    <div class="card table-wrap"><h3 style="padding:14px 14px 0">By driver — orders delivered and areas</h3>${table(['Driver / areas','Orders','Total','AOV','Unpaid'], drvRows)}</div>
    <div class="grid-2">
      <div class="card table-wrap"><h3 style="padding:14px 14px 0">By area</h3>${table(['Area','Orders','Total','AOV'], areaRows)}</div>
      ${dayRows.length > 1 ? `<div class="card table-wrap"><h3 style="padding:14px 14px 0">Day by day</h3>${table(['Date','Orders','Total','AOV'], dayRows)}</div>` : ''}
    </div>`;
}

/* ================= REPORTS › CUSTOMERS =================
   How often each customer orders, who has not ordered for too long, and a statement of account.
   Owner, 2026-09-30: only On Account orders that are not marked paid are owed by the customer;
   cash / card / online orders are settled at delivery.
   Ordering pattern: "usually every N days" = time between the first and the last order / (orders − 1).
   Not ordering lately: more than max(lapse days, 3 × their usual gap) since the last order → lapsed;
   more than max(7, 2 × their usual gap) → late. One order only: lapsed after the lapse days. */
const CR_LAPSE_KEY = 'dt_lapse_days';
let crFilter = 'all';
const daysSince = d => Math.round((new Date(today()+'T00:00:00') - new Date(d+'T00:00:00')) / 86400000);
const isOwed = o => o.payment === 'On Account' && !o.paid;
function crLapse(){ const v = +($('#crLapse').value || localStorage.getItem(CR_LAPSE_KEY) || 30); return v >= 3 ? v : 30; }
function customerStats(){
  const byCust = new Map();
  db.orders.forEach(o => {
    const k = o.customerId || ('~' + (normPhone(o.cPhone) || o.cName.trim().toLowerCase()));
    if(!byCust.has(k)) byCust.set(k, []);
    byCust.get(k).push(o);
  });
  const lapse = crLapse();
  return [...byCust.entries()].map(([k, orders]) => {
    orders.sort((a,b) => a.date.localeCompare(b.date) || (a.created||0) - (b.created||0));
    const c = db.customers.find(x => x.id === k);
    const last = orders[orders.length-1], first = orders[0];
    const n = orders.length, days = new Set(orders.map(o => o.date)).size;
    const gap = days > 1 ? daysSince(first.date) - daysSince(last.date) : null;
    const every = gap !== null ? Math.max(1, Math.round(gap / (days - 1))) : null;
    const since = daysSince(last.date);
    let status;
    if(every === null) status = since > lapse ? 'lapsed' : 'new';
    else if(since > Math.max(lapse, every * 3)) status = 'lapsed';
    else if(since > Math.max(7, every * 2)) status = 'late';
    else status = 'regular';
    const total = orders.reduce((s,o) => s + (+o.amount||0), 0);
    const owed = orders.filter(isOwed).reduce((s,o) => s + (+o.amount||0), 0);
    return { key:k, c, name: c?.name || last.cName || 'Unknown', phone: c?.phone || last.cPhone, area: c?.area || last.cArea, address: c?.address || last.cAddress,
      orders, n, first:first.date, last:last.date, every, since, status, total, owed };
  });
}
const CR_STATUS = { regular:['Regular','paid'], late:['Late','warn'], lapsed:['Not ordering','unpaid'], new:['One order','muted'] };
function crFiltered(){
  const q = $('#crSearch').value.trim().toLowerCase(), qd = normPhone(q);
  return customerStats().filter(s =>
      (crFilter === 'all' || (crFilter === 'late' ? (s.status === 'late' || s.status === 'lapsed') : crFilter === 'owed' ? s.owed > 0 : s.status === crFilter))
      && (!q || [s.name, s.area, s.address].join(' ').toLowerCase().includes(q) || (qd.length >= 3 && normPhone(s.phone).includes(qd))))
    .sort((a,b) => crFilter === 'late' ? b.since - a.since : (b.owed - a.owed) || (a.since - b.since) || a.name.localeCompare(b.name));
}
function renderCustReport(){
  if(!$('#crLapse').value) $('#crLapse').value = localStorage.getItem(CR_LAPSE_KEY) || 30;
  $('#crFilter').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.f === crFilter));
  const all = customerStats(), list = crFiltered();
  const late = all.filter(s => s.status === 'late' || s.status === 'lapsed').length;
  const owed = all.reduce((t,s) => t + s.owed, 0);
  const active30 = all.filter(s => s.since <= 30).length;
  const tag = st => `<span class="status ${CR_STATUS[st][1]}">${CR_STATUS[st][0]}</span>`;
  $('#crBody').innerHTML = `
    <div class="kpis">
      <div class="kpi"><span>Customers who ordered</span><b>${all.length}</b></div>
      <div class="kpi"><span>Ordered in the last 30 days</span><b>${active30}</b></div>
      <div class="kpi"><span>Not ordering lately</span><b style="color:${late?'var(--red)':'inherit'}">${late}</b></div>
      <div class="kpi"><span>Owed on account</span><b style="color:${owed?'var(--red)':'inherit'}">${money(owed)}</b></div>
    </div>
    <div class="card table-wrap"><table class="tbl cr-table">
      <thead><tr><th>Customer</th><th class="num">Orders</th><th>First order</th><th>Last order</th><th>Usually orders</th><th class="num">Days since</th><th>Status</th><th class="num">Total spent</th><th class="num">Owes</th><th></th></tr></thead>
      <tbody>${list.slice(0, 500).map(s => `<tr data-key="${esc(s.key)}">
        <td><b>${esc(s.name)}</b><div class="muted">${esc([s.phone, s.area].filter(Boolean).join(' · '))}</div></td>
        <td class="num">${s.n}</td><td>${fmtDate(s.first)}</td><td>${fmtDate(s.last)}</td>
        <td>${s.every ? (s.every === 1 ? 'every day' : `every ${s.every} days`) : '<span class="muted">—</span>'}</td>
        <td class="num">${s.since}</td><td>${tag(s.status)}</td>
        <td class="num">${money(s.total)}</td>
        <td class="num" style="color:${s.owed?'var(--red)':'inherit'}">${s.owed ? money(s.owed) : '—'}</td>
        <td class="actions"><button class="btn sm" data-act="statement">Statement</button></td></tr>`).join('')
        || `<tr><td colspan="10" class="empty">${all.length ? 'No customer matches.' : 'No orders yet.'}</td></tr>`}
        ${list.length > 500 ? '<tr><td colspan="10" class="empty">Showing the first 500 — use search to narrow down.</td></tr>' : ''}</tbody>
    </table></div>
    <p class="muted">“Usually orders” is the average time between their orders. <b>Late</b>: more than twice that since the last order; <b>Not ordering</b>: more than three times that, or more than ${crLapse()} days (one-order customers after ${crLapse()} days). Only unpaid <b>On Account</b> orders count as owed.</p>`;
}
$('#crSearch').addEventListener('input', renderCustReport);
$('#crFilter').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if(b){ crFilter = b.dataset.f; renderCustReport(); } });
$('#crLapse').addEventListener('change', e => { const v = Math.max(3, Math.min(365, +e.target.value || 30)); e.target.value = v; try{ localStorage.setItem(CR_LAPSE_KEY, v); }catch(err){} renderCustReport(); });
$('#crBody').addEventListener('click', e => {
  const b = e.target.closest('[data-act="statement"]'); if(!b) return;
  const s = customerStats().find(x => x.key === b.closest('tr').dataset.key);
  if(s) openStatement([s]);
});
$('#crStatements').addEventListener('click', async () => {
  const list = crFiltered();
  if(!list.length) return toast('No customers in the list.', 'alert');
  if(list.length > 40 && !(await uiConfirm(`Print ${list.length} statements (one page each)?`, {title:'Statements', ok:'Print'}))) return;
  openStatement(list);
});
$('#crExport').addEventListener('click', () => {
  const list = crFiltered();
  const aoa = [['Customer','Phone','Area','Orders','First order','Last order','Usually every (days)','Days since last order','Status','Total spent','Owed on account']]
    .concat(list.map(s => [s.name, s.phone || '', s.area || '', s.n, s.first, s.last, s.every ?? '', s.since, CR_STATUS[s.status][0], +s.total.toFixed(2), +s.owed.toFixed(2)]));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Customers');
  XLSX.writeFile(wb, `customers-${today()}.xlsx`);
});

// Statement of account: every order of the customer, what was settled at delivery, what is owed
// (unpaid On Account) with a running balance. Printed from its own window, one page per customer.
function statementHtml(s){
  let bal = 0;
  const rows = s.orders.map(o => {
    const owedNow = isOwed(o);
    if(owedNow) bal += +o.amount || 0;
    const st = o.payment === 'On Account' ? (o.paid ? `On account · paid${o.paidAt ? ' ' + fmtDate(o.paidAt) : ''}` : 'On account · <b>due</b>') : `Paid at delivery (${esc(o.payment)})`;
    return `<tr><td>${fmtDate(o.date)}</td><td>${esc(String(o.id).slice(-6).toUpperCase())}</td><td>${esc(o.platform || '')}</td><td>${st}</td>
      <td class="n">${money(o.amount)}</td><td class="n">${owedNow ? money(o.amount) : '—'}</td><td class="n">${money(bal)}</td></tr>`;
  }).join('');
  const onAccount = s.orders.filter(o => o.payment === 'On Account').reduce((t,o) => t + (+o.amount||0), 0);
  return `<section class="st">
    <header><div><div class="brand">LA VALEUR <span>supermarché</span></div><div class="muted">Ajaltoun · Delivery</div></div>
      <div class="r"><h1>Statement of account</h1><div class="muted">Date: ${fmtDate(today())}</div></div></header>
    <div class="who"><b>${esc(s.name)}</b><br>${esc(s.phone || '')}${s.area ? ' · ' + esc(s.area) : ''}${s.address ? '<br>' + esc(s.address) : ''}</div>
    <div class="sum">
      <div><span>Orders</span><b>${s.n}</b></div><div><span>Period</span><b>${fmtDate(s.first)} → ${fmtDate(s.last)}</b></div>
      <div><span>Total purchases</span><b>${money(s.total)}</b></div><div><span>On account</span><b>${money(onAccount)}</b></div>
      <div class="due"><span>Balance due</span><b>${money(s.owed)}</b></div></div>
    <table><thead><tr><th>Date</th><th>Order</th><th>Platform</th><th>Payment</th><th class="n">Amount</th><th class="n">Due</th><th class="n">Balance</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="4">Total</td><td class="n">${money(s.total)}</td><td class="n">${money(s.owed)}</td><td class="n">${money(s.owed)}</td></tr></tfoot></table>
    <p class="foot">${s.owed ? `Amount to pay: <b>${money(s.owed)}</b>. Thank you.` : 'Nothing is due. Thank you for your orders.'}</p>
  </section>`;
}
function openStatement(list){
  const w = window.open('', '_blank');
  if(!w) return uiAlert('Allow pop-ups for this site to print statements.', {title:'Statement'});
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Statement${list.length === 1 ? ' — ' + esc(list[0].name) : 's'}</title><style>
    body{font:13px/1.45 Arial,Helvetica,sans-serif;color:#111;margin:0;background:#eef0f7}
    .bar{position:sticky;top:0;background:#1f3fd1;color:#fff;padding:10px 18px;display:flex;gap:10px;align-items:center}
    .bar button{font:inherit;padding:7px 14px;border-radius:7px;border:0;cursor:pointer;background:#fff;color:#1f3fd1;font-weight:700}
    .st{background:#fff;max-width:760px;margin:18px auto;padding:34px 38px;box-shadow:0 2px 12px rgba(0,0,0,.08);page-break-after:always}
    .st:last-child{page-break-after:auto}
    header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1f3fd1;padding-bottom:12px;margin-bottom:16px}
    .brand{font-weight:800;font-size:20px;color:#1f3fd1;letter-spacing:.04em}.brand span{font-weight:400;font-size:13px;letter-spacing:0;display:block}
    h1{margin:0;font-size:18px}.r{text-align:right}.muted{color:#666;font-size:12px}
    .who{margin-bottom:14px}.sum{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
    .sum div{border:1px solid #d9dcec;border-radius:8px;padding:7px 11px;min-width:110px}.sum span{display:block;font-size:11px;color:#666}
    .sum .due{border-color:#1f3fd1;background:#eef1ff}.sum .due b{color:#1f3fd1}
    table{width:100%;border-collapse:collapse}th,td{padding:6px 7px;border-bottom:1px solid #e3e5ef;text-align:left}th{font-size:11px;text-transform:uppercase;color:#555;border-bottom:2px solid #333}
    .n{text-align:right;white-space:nowrap}tfoot td{font-weight:700;border-top:2px solid #333;border-bottom:0}.foot{margin-top:18px}
    @media print{body{background:#fff}.bar{display:none}.st{box-shadow:none;margin:0;max-width:none;padding:10mm}}
  </style></head><body><div class="bar"><b>${list.length} statement${list.length === 1 ? '' : 's'}</b><span style="flex:1"></span><button onclick="print()">Print / Save as PDF</button></div>
  ${list.map(statementHtml).join('')}</body></html>`);
  w.document.close();
  logActivity('delivery', 'statement', null, list.length === 1 ? `Statement of account for ${list[0].name}` : `${list.length} statements of account`);
}

/* ================= CUSTOMERS ================= */
$('#cSearch').addEventListener('input', renderCustomers);
function renderCustomers(){
  refreshLists();
  const q = $('#cSearch').value.trim().toLowerCase(), qd = normPhone(q);
  const agg = {};
  db.orders.forEach(o => { const a = agg[o.customerId] || (agg[o.customerId] = {n:0,t:0}); a.n++; a.t += +o.amount||0; });
  const list = db.customers.filter(c => !q || [c.name,c.area,c.address].join(' ').toLowerCase().includes(q) || (qd.length >= 3 && normPhone(c.phone).includes(qd)))
    .sort((a,b) => a.name.localeCompare(b.name));
  $('#custSummary').innerHTML = `<span><b>${db.customers.length}</b> customers${q ? ` · <b>${list.length}</b> match` : ''}</span>`;
  const shown = list.slice(0, 500);
  $('#custBody').innerHTML = shown.map(c => `<tr data-id="${c.id}"><td><b>${esc(c.name)}</b></td><td>${c.phone ? `<a href="tel:${esc(normPhone(c.phone))}" style="color:var(--brand)">${esc(c.phone)}</a>` : '—'}</td><td>${esc(c.area)}</td><td>${esc(c.address)}</td><td class="num">${agg[c.id]?.n || 0}</td><td class="num">${money(agg[c.id]?.t || 0)}</td>
    <td class="actions"><button data-act="order" title="New order">${ic('truck')}</button><button data-act="edit" title="Edit">${ic('edit')}</button><button data-act="del" title="Delete">${ic('trash')}</button></td></tr>`).join('')
    + (list.length > 500 ? `<tr><td colspan="7" class="empty">Showing first 500 — use search to narrow down.</td></tr>` : '')
    || `<tr><td colspan="7" class="empty">No customers yet. Use “Import Excel” to load your list.</td></tr>`;
}
$('#custBody').addEventListener('click', async e => {
  const act = e.target.closest('[data-act]')?.dataset.act; if(!act) return;
  const c = db.customers.find(x => x.id === e.target.closest('tr').dataset.id);
  if(act === 'edit') openCustomer(c);
  if(act === 'order'){ focusQuick(); pickQuick(c); }
  if(act === 'del' && await uiConfirm(`Delete ${c.name}? Their past orders stay in the history.`, {title:'Delete customer', ok:'Delete', danger:true})){ db.customers = db.customers.filter(x => x !== c); save(); renderCustomers();
    logActivity('delivery', 'delete', {type:'customer', id:c.id}, `Deleted customer ${c.name}`, {phone:c.phone, area:c.area}); }
});

let editingCust = null, custCallback = null;
const cForm = $('#custForm');
function openCustomer(c, cb, prefill){
  editingCust = c || null; custCallback = cb || null;
  refreshLists();
  $('#custTitle').textContent = c ? 'Edit customer' : 'New customer';
  ['name','phone','area','address'].forEach(k => cForm[k].value = c?.[k] || prefill?.[k] || '');
  $('#custDlg').showModal();
  (prefill?.name ? cForm.phone : cForm.name).focus();
}
cForm.addEventListener('submit', async e => {
  e.preventDefault();
  const data = {name:cForm.name.value.trim(), phone:fmtPhone(cForm.phone.value), area:canonArea(cForm.area.value), address:cForm.address.value.trim()};
  const p = normPhone(data.phone);
  const dup = p && db.customers.find(x => x !== editingCust && normPhone(x.phone) === p);
  if(dup && !(await uiConfirm(`${dup.name} already has this phone number. Save anyway?`, {title:'Duplicate phone', ok:'Save anyway', icon:'alert'}))) return;
  const c = editingCust || {id:uid()};
  Object.assign(c, data);
  logActivity('delivery', editingCust ? 'edit' : 'create', {type:'customer', id:c.id}, `${editingCust ? 'Edited' : 'New'} customer ${c.name}`, data);
  if(!editingCust) db.customers.push(c);
  else db.orders.forEach(o => { if(o.customerId === c.id) Object.assign(o, {cName:c.name, cPhone:c.phone, cArea:c.area, cAddress:c.address}); });
  save(); $('#custDlg').close(); toast('Customer saved'); refreshLists();
  if(custCallback) custCallback(c); else renderCustomers();
});
$('#newCustBtn').onclick = () => openCustomer();

$('#exportCust').onclick = () => {
  if(!window.XLSX) return uiAlert('The Excel tool could not load. Check the internet connection and reload the page.', {title:'Excel not available', icon:'alert'});
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(db.customers.map(c => ({Name:c.name, Phone:c.phone, Area:c.area, Address:c.address}))), 'Customers');
  XLSX.writeFile(wb, 'customers.xlsx');
};

/* Excel import */
const FIELDS = [
  ['name','Name',   ['name','customer','client','اسم','الاسم','nom']],
  ['phone','Phone', ['phone','contact','mobile','tel','number','cell','whatsapp','هاتف','رقم','جوال','خليوي']],
  ['area','Area',   ['area','region','village','town','city','zone','منطقة','المنطقة','بلدة']],
  ['address','Address',['address','location','street','building','عنوان','العنوان','adresse']],
];
let impRows = [], impMap = {}, impHeader = true;
$('#importBtn').onclick = () => {
  if(!window.XLSX) return uiAlert('The Excel tool could not load. Check the internet connection and reload the page.', {title:'Excel not available', icon:'alert'});
  $('#impFile').value = ''; $('#impBody').innerHTML = '<p class="muted">Choose your Excel file (.xlsx, .xls or .csv). The first sheet is used. Columns are detected automatically — you can adjust them before importing.</p>';
  $('#impGo').disabled = true; $('#importDlg').showModal();
};
$('#impFile').onchange = async e => {
  const f = e.target.files[0]; if(!f) return;
  const wb = XLSX.read(await f.arrayBuffer(), {type:'array'});
  impRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header:1, defval:'', raw:false})
    .filter(r => r.some(v => String(v).trim() !== ''));
  if(!impRows.length){ $('#impBody').innerHTML = '<p>The sheet is empty.</p>'; return; }
  const head = impRows[0].map(h => String(h).toLowerCase().trim());
  impMap = {}; const used = new Set();
  FIELDS.forEach(([k,,keys]) => { const i = head.findIndex((h,i) => !used.has(i) && keys.some(w => h.includes(w))); if(i >= 0){ impMap[k] = i; used.add(i); } });
  impHeader = Object.keys(impMap).length > 0;
  if(!impHeader){ impMap = {name:0, phone:1, area:2, address:3}; }
  drawImport();
};
function drawImport(){
  const ncol = Math.max(...impRows.map(r => r.length));
  const colName = i => impHeader ? (String(impRows[0][i]).trim() || `Column ${XLSX.utils.encode_col(i)}`) : `Column ${XLSX.utils.encode_col(i)}`;
  const cols = [...Array(ncol).keys()].map(i => [String(i), colName(i)]);
  const data = impHeader ? impRows.slice(1) : impRows;
  const mapped = data.map(r => mapRow(r)).filter(x => x.name);
  $('#impBody').innerHTML = `
    <label class="chk" style="margin-top:12px"><input type="checkbox" id="impHead" ${impHeader?'checked':''}> First row contains column titles</label>
    <div class="map-grid">${FIELDS.map(([k,l]) => `<label>${l} column<select data-f="${k}">${options(cols, impMap[k] !== undefined ? String(impMap[k]) : '', '— none —')}</select></label>`).join('')}</div>
    <p class="muted" style="margin:6px 0">If there is no Area column, the area is taken from the address when it contains a known area name (Ajaltoun, Faraya…).</p>
    <div class="card table-wrap" style="max-height:240px;overflow:auto;margin:0"><table class="tbl"><thead><tr><th>Name</th><th>Phone</th><th>Area</th><th>Address</th></tr></thead>
      <tbody>${mapped.slice(0,8).map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td>${esc(c.area)}</td><td>${esc(c.address)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No names found — check the Name column.</td></tr>'}</tbody></table></div>
    <p><b>${mapped.length}</b> customers found in the file.</p>
    <label class="chk"><input type="checkbox" id="impSkip" checked> Skip exact duplicates (same name and phone already saved)</label>
    <p class="muted" style="margin:6px 0 0">Area spellings are cleaned up (AJALTOUNE → Ajaltoun) and phones formatted as 76-482453.</p>`;
  $('#impHead').onchange = e => { impHeader = e.target.checked; drawImport(); };
  document.querySelectorAll('#impBody [data-f]').forEach(s => s.onchange = () => { s.value === '' ? delete impMap[s.dataset.f] : impMap[s.dataset.f] = +s.value; drawImport(); });
  $('#impGo').disabled = !mapped.length;
}
function mapRow(r){
  const g = k => impMap[k] !== undefined ? String(r[impMap[k]] ?? '').trim() : '';
  const c = {name:g('name').replace(/\s+/g, ' '), phone:fmtPhone(g('phone')), area:g('area'), address:g('address')};
  if(!c.area && c.address){
    const known = canonArea(c.address);
    if(allAreas().includes(known) || DEFAULT_AREAS.includes(known)){ c.area = known; c.address = ''; }   // the "address" is just the area
    else {
      const hit = allAreas().find(a => c.address.toLowerCase().includes(a.toLowerCase()));
      c.area = hit || (c.address.length <= 25 ? c.address : '');
      if(c.address.length <= 25 && !hit) c.address = '';
    }
  }
  c.area = canonArea(c.area);
  return c;
}
$('#impGo').onclick = () => {
  const data = (impHeader ? impRows.slice(1) : impRows).map(mapRow).filter(c => c.name);
  const skip = $('#impSkip').checked;
  const dupKey = c => c.name.trim().toLowerCase() + '|' + normPhone(c.phone);
  const seen = new Set(db.customers.map(dupKey));
  let added = 0, skipped = 0;
  data.forEach(c => {
    const k = dupKey(c);
    if(skip && seen.has(k)){ skipped++; return; }
    db.customers.push({id:uid(), ...c}); seen.add(k); added++;
  });
  save(); $('#importDlg').close();
  logActivity('delivery', 'import', {type:'customer', id:null}, `Imported ${added} customers`, {added, skipped});
  uiAlert(`${added} customers imported.` + (skipped ? `\n${skipped} skipped because the same name and phone were already saved.` : ''), {title:'Import finished', icon:'checkc'});
  renderCustomers();
};

/* ================= DRIVERS ================= */
$('#driverForm').addEventListener('submit', e => {
  e.preventDefault(); const f = e.target, name = f.name.value.trim(); if(!name) return;
  if(db.drivers.some(d => d.name.toLowerCase() === name.toLowerCase())) return uiAlert(`${name} already exists.`, {title:'Duplicate driver', icon:'alert'});
  const d = {id:uid(), name, phone:f.phone.value.trim()};
  db.drivers.push(d); save(); f.reset(); renderDrivers(); toast('Driver added');
  logActivity('delivery', 'create', {type:'driver', id:d.id}, `New driver ${name}`);
});
function renderDrivers(){
  const m = today().slice(0,7);
  $('#driversBody').innerHTML = db.drivers.map(d => {
    const mine = db.orders.filter(o => o.driverId === d.id), un = mine.filter(o => !o.paid);
    return `<tr data-id="${d.id}"><td><b>${esc(d.name)}</b></td><td>${esc(d.phone)||'—'}</td><td class="num">${mine.length}</td><td class="num">${mine.filter(o => o.date.startsWith(m)).length}</td><td class="num">${un.length}</td><td class="num" style="color:${un.length?'var(--red)':'inherit'}">${money(un.reduce((s,o)=>s+(+o.amount||0),0))}</td>
      <td class="actions"><button data-act="pay" title="Payments">${ic('cash')}</button><button data-act="edit" title="Rename">${ic('edit')}</button><button data-act="del" title="Delete">${ic('trash')}</button></td></tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">No drivers yet.</td></tr>';
}
$('#driversBody').addEventListener('click', async e => {
  const act = e.target.closest('[data-act]')?.dataset.act; if(!act) return;
  const d = db.drivers.find(x => x.id === e.target.closest('tr').dataset.id);
  if(act === 'pay'){ settleDriver = d.id; go('settle'); }
  if(act === 'edit'){
    const v = await uiForm('Edit driver', [{label:'Name', value:d.name, required:true}, {label:'Phone (optional)', value:d.phone || ''}]);
    if(v){ const old = d.name; d.name = v[0].trim(); d.phone = v[1].trim(); save(); renderDrivers(); toast('Driver saved', 'check');
      logActivity('delivery', 'edit', {type:'driver', id:d.id}, old === d.name ? `Edited driver ${d.name}` : `Renamed driver ${old} to ${d.name}`); }
  }
  if(act === 'del'){
    if(db.orders.some(o => o.driverId === d.id)) return uiAlert(`${d.name} has orders in the history, so he can't be deleted. You can rename him instead.`, {title:'Driver has orders', icon:'alert'});
    if(await uiConfirm(`Delete driver ${d.name}?`, {title:'Delete driver', ok:'Delete', danger:true})){ db.drivers = db.drivers.filter(x => x !== d); save(); renderDrivers();
      logActivity('delivery', 'delete', {type:'driver', id:d.id}, `Deleted driver ${d.name}`); }
  }
});

/* ================= SETTINGS ================= */
function renderSettings(){
  $('#areaChips').innerHTML = db.areas.slice().sort((a,b)=>a.localeCompare(b)).map(a => `<span class="chip">${esc(a)}<button data-a="${esc(a)}" title="Remove">×</button></span>`).join('');
  $('#curForm').cur.value = db.currency;
}
$('#areaChips').addEventListener('click', e => { const a = e.target.dataset.a; if(a){ db.areas = db.areas.filter(x => x !== a); save(); renderSettings(); logActivity('delivery', 'settings', null, `Removed area ${a}`); } });
$('#areaForm').addEventListener('submit', e => { e.preventDefault(); const a = e.target.area.value.trim(); if(a && !db.areas.some(x => x.toLowerCase() === a.toLowerCase())){ db.areas.push(a); save(); logActivity('delivery', 'settings', null, `Added area ${a}`); } e.target.reset(); renderSettings(); });
$('#curForm').addEventListener('submit', e => { e.preventDefault(); db.currency = e.target.cur.value.trim() || '$'; save(); toast('Currency saved'); logActivity('delivery', 'settings', null, `Currency set to ${db.currency}`); });
$('#backupBtn').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(db,null,1)], {type:'application/json'}));
  a.download = `delivery-backup-${today()}.json`; a.click();
};
$('#restoreBtn').onclick = () => $('#restoreFile').click();
$('#restoreFile').onchange = async e => {
  const f = e.target.files[0]; if(!f) return;
  try{
    const d = JSON.parse(await f.text());
    if(!d.orders || !d.customers) throw 0;
    if(!(await uiConfirm(`This replaces ALL data in the database, for everyone, with the backup:\n${d.customers.length} customers, ${(d.drivers||[]).length} drivers, ${d.orders.length} orders.`, {title:'Restore backup', ok:'Replace data', danger:true}))) return;
    db.customers = d.customers; db.drivers = d.drivers || []; db.orders = d.orders; db.areas = d.areas || [...DEFAULT_AREAS]; db.currency = d.currency || '$';
    save(); toast('Backup restored', 'check'); go('orders');
    logActivity('delivery', 'restore', null, `Restored backup: ${d.customers.length} customers, ${(d.drivers||[]).length} drivers, ${d.orders.length} orders`);
  }catch(err){ uiAlert('This is not a valid backup file.', {title:'Cannot restore', icon:'alert'}); }
  e.target.value = '';
};
$('#wipeBtn').onclick = async () => {
  const v = await uiForm('Delete all data', [{label:'Type DELETE to confirm', placeholder:'DELETE'}], {message:'This deletes ALL customers, drivers and orders from the database, for everyone. It cannot be undone.', ok:'Delete everything', danger:true, icon:'alert'});
  if(v && v[0].trim() === 'DELETE'){
    logActivity('delivery', 'wipe', null, `Deleted all delivery data (${db.customers.length} customers, ${db.drivers.length} drivers, ${db.orders.length} orders)`);
    db.customers = []; db.drivers = []; db.orders = []; save(); go('orders'); toast('All data deleted');
  }
};

/* ================= CUSTOMER SEARCH DROPDOWN ================= */
function searchCustomers(q){
  q = q.trim().toLowerCase(); if(!q) return [];
  const toks = q.split(/\s+/), d = normPhone(q), res = [];
  for(const c of db.customers){
    const hay = `${c.name} ${c.area||''} ${c.address||''}`.toLowerCase(), ph = normPhone(c.phone);
    if(!toks.every(t => hay.includes(t) || (/^[\d+]+$/.test(t) && ph.includes(normPhone(t))))) continue;
    const n = c.name.toLowerCase();
    const s = n.startsWith(q) ? 0 : (d && ph.startsWith(d)) ? 1 : n.split(/\s+/).some(w => w.startsWith(toks[0])) ? 2 : 3;
    res.push([s, c]);
  }
  return res.sort((a,b) => a[0]-b[0] || a[1].name.localeCompare(b[1].name)).slice(0, 8).map(x => x[1]);
}
function attachAC(input, onPick, onCreate){
  const box = document.createElement('div'); box.className = 'ac'; box.hidden = true;
  (input.closest('dialog') || panel).appendChild(box);
  let items = [], idx = 0;
  const hide = () => { box.hidden = true; };
  function draw(){
    const q = input.value.trim(); if(!q){ hide(); return; }
    const r = input.getBoundingClientRect();
    Object.assign(box.style, {left: r.left+'px', top: (r.bottom+2)+'px', width: Math.max(r.width, 360)+'px'});
    box.innerHTML = items.map((c,i) => `<div data-i="${i}" class="${i===idx?'on':''}"><span><b>${esc(c.name)}</b> <span class="muted">${esc(c.phone)}</span></span><span class="muted">${esc(c.area)}</span></div>`).join('')
      + `<div data-i="${items.length}" class="new ${idx===items.length?'on':''}">+ New customer “${esc(q)}”</div>`;
    box.hidden = false;
    box.querySelector('.on')?.scrollIntoView({block:'nearest'});
  }
  function pick(i){
    hide();
    if(i >= items.length){ onCreate(input.value.trim()); return; }
    const c = items[i]; input._cust = c; input.value = custLabel(c); onPick(c);
  }
  input.addEventListener('input', () => { input._cust = null; items = searchCustomers(input.value); idx = 0; draw(); });
  input.addEventListener('keydown', e => {
    if(box.hidden) return;
    const n = items.length + 1;
    if(e.key === 'ArrowDown'){ idx = (idx+1) % n; draw(); e.preventDefault(); }
    else if(e.key === 'ArrowUp'){ idx = (idx-1+n) % n; draw(); e.preventDefault(); }
    else if(e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey && idx < items.length)){ e.preventDefault(); e.stopPropagation(); pick(idx); }
    else if(e.key === 'Escape'){ hide(); e.preventDefault(); e.stopPropagation(); }
  });
  box.addEventListener('mousedown', e => e.preventDefault());
  box.addEventListener('click', e => { const el = e.target.closest('[data-i]'); if(el) pick(+el.dataset.i); });
  input.addEventListener('blur', () => setTimeout(hide, 120));
  window.addEventListener('scroll', e => { if(e.target !== box) hide(); }, true);
  window.addEventListener('resize', hide);
}
attachAC(oForm.customer, c => { updateCustHint(); dlgMemory(c); oForm.amount.focus(); },
  t => openCustomer(null, dlgPicked, prefillFrom(t)));

/* ================= QUICK ORDER ROW ================= */
const qCust = $('#qCust'), qDriver = $('#qDriver'), qAmount = $('#qAmount'), qPaid = $('#qPaid');
let qIsPaid = false;
function focusQuick(){ if(!PAGES.includes('orders')) return; if(currentPage !== 'orders') go('orders'); qCust.focus(); qCust.select(); }
// ---- customer memory: their most recent order ----
function lastOrderOf(c){
  let best = null;
  for(const o of db.orders){
    if(o.customerId !== c.id) continue;
    if(!best || o.date > best.date || (o.date === best.date && (o.created||0) > (best.created||0))) best = o;
  }
  return best;
}
function daysAgo(d){
  const n = Math.round((new Date(today()+'T00:00:00') - new Date(d+'T00:00:00')) / 864e5);
  return n <= 0 ? 'today' : n === 1 ? 'yesterday' : n + ' days ago';
}
// most used payment / platform in the shop (for customers with no history)
function shopDefaults(){
  const cnt = (f, dflt) => { const m = {}; db.orders.forEach(o => m[o[f]] = (m[o[f]]||0) + 1); return Object.entries(m).sort((x,y) => y[1]-x[1])[0]?.[0] || dflt; };
  return {payment:cnt('payment', 'Cash'), platform:cnt('platform', 'WhatsApp')};
}
const shortPay = p => ({'Credit Card':'Card', 'On Account':'Account'}[p] || p);
const shortPlat = p => p === 'Application' ? 'App' : p;
function applyMemory(c){
  const last = lastOrderOf(c), area = $('#qArea');
  const pick = last || shopDefaults();
  if(PLATFORMS.includes(pick.platform)) db.last.platform = pick.platform;
  if(PAYMENTS.includes(pick.payment))  db.last.payment  = pick.payment;
  save(); drawPlat(); drawPay();
  if(!last){
    area.innerHTML = `${esc(c.area || '')}<span class="qmem new">New customer</span>`;
    return;
  }
  ['#qPlat','#qPay'].forEach(sel => { const el = $(sel); el.classList.remove('auto'); void el.offsetWidth; el.classList.add('auto'); });
  area.innerHTML = `${esc(c.area || '')}<span class="qmem" title="Last order: ${esc(fmtDate(last.date))} · ${esc(money(last.amount))} · ${esc(last.payment)} · ${esc(last.platform)}">Last: ${esc(shortPay(last.payment))} · ${esc(shortPlat(last.platform))} · ${daysAgo(last.date)}</span>`;
}
function pickQuick(c){
  qCust._cust = c; qCust.value = custLabel(c);
  applyMemory(c);
  qDriver.focus();
}
function drawPaid(){ qPaid.className = 'status ' + (qIsPaid ? 'paid' : 'unpaid'); qPaid.textContent = qIsPaid ? 'Paid' : 'Unpaid'; }
function refocusQuick(){ (!resolveCust(qCust) ? qCust : !qDriver.value ? qDriver : qAmount).focus(); }
qPaid.addEventListener('mousedown', e => e.preventDefault());
qPaid.onclick = () => { qIsPaid = !qIsPaid; drawPaid(); refocusQuick(); };
drawPaid();

function seg(el, vals, labels, field){
  const draw = () => el.innerHTML = vals.map((v,i) => `<button type="button" tabindex="-1" data-v="${esc(v)}" class="${db.last[field]===v?'on':''}">${labels[i]}</button>`).join('');
  el.addEventListener('mousedown', e => e.preventDefault());
  el.addEventListener('click', e => { const b = e.target.closest('button'); if(b){ db.last[field] = b.dataset.v; save(); draw(); refocusQuick(); } });
  draw();
  return draw;
}
const drawPlat = seg($('#qPlat'), PLATFORMS, ['App','WhatsApp'], 'platform');
const drawPay  = seg($('#qPay'), PAYMENTS, ['Cash','Online','Card','Account'], 'payment');

qDriver.addEventListener('keydown', e => {
  if(/^[1-9]$/.test(e.key)){ const d = db.drivers[+e.key-1]; if(d){ qDriver.value = d.id; db.last.driverId = d.id; save(); } e.preventDefault(); }
});
qDriver.addEventListener('change', () => { db.last.driverId = qDriver.value; save(); });
qCust.addEventListener('input', () => { $('#qArea').textContent = ''; });
attachAC(qCust, pickQuick, t => openCustomer(null, c => pickQuick(c), prefillFrom(t)));

function bad(el, msg){ el.classList.add('err'); setTimeout(() => el.classList.remove('err'), 1300); toast(msg); el.focus(); }
function clearQuick(){ qCust.value = ''; qCust._cust = null; qAmount.value = ''; $('#qArea').textContent = ''; qIsPaid = false; drawPaid(); }
function quickSave(){
  if(!can.createOrder()) return;
  if(!db.drivers.length) return noDrivers();
  const c = resolveCust(qCust);
  const amt = parseFloat(String(qAmount.value).replace(',', '.'));
  if(!c) return bad(qCust, qCust.value ? 'Customer not found — pick from the list' : 'Type a customer');
  if(!qDriver.value) return bad(qDriver, 'Choose a driver (keys 1–9)');
  if(!(amt > 0)) return bad(qAmount, 'Enter the amount');
  const o = {id:uid(), created:Date.now(), date:today(), driverId:qDriver.value, amount:Math.round(amt*100)/100,
    platform:db.last.platform, payment:db.last.payment, paid:qIsPaid, paidAt:qIsPaid ? today() : '', note:'',
    customerId:c.id, cName:c.name, cPhone:c.phone, cArea:c.area, cAddress:c.address};
  db.orders.push(o); db.last.driverId = o.driverId; save();
  logOrder('create', o, `New order: ${o.cName} ${money(o.amount)} · ${driverName(o.driverId)}`);
  OF.day = o.date; OF.q = ''; flashId = o.id;
  clearQuick(); renderOrders();
  toast(`${o.cName} — ${money(o.amount)} · ${driverName(o.driverId)}`, 'check');
  qCust.focus();
}
$('#qAdd').onclick = quickSave;
$('#quickRow').addEventListener('keydown', e => {
  if(e.key === 'Enter'){
    e.preventDefault();
    if(e.target === qCust && resolveCust(qCust)){ qDriver.focus(); return; }
    if(e.target === qDriver && qDriver.value){ qAmount.focus(); qAmount.select(); return; }
    quickSave(); return;
  }
  if(e.key === 'Escape'){
    e.preventDefault();
    if(qCust.value || qAmount.value){ clearQuick(); qCust.focus(); } else document.activeElement.blur();
    return;
  }
});

/* ================= GLOBAL SHORTCUTS ================= */
$('#helpBtn').onclick = () => $('#helpDlg').showModal();

const isField = el => el && el.matches && el.matches('input, select, textarea, [contenteditable="true"]');
// Shortcuts only while the Delivery section is showing, never on the login screen or over a main-app dialog.
const deliveryShowing = () => appStarted && panel.classList.contains('active') && !document.body.classList.contains('locked')
  && !document.querySelector('.modal-overlay.open');
document.addEventListener('keydown', e => {
  if(!deliveryShowing()) return;
  if(e.key === 'F2'){ e.preventDefault(); if(!document.querySelector('dialog[open]') && can.createOrder()) focusQuick(); return; }
  if(document.querySelector('dialog[open]')) return;
  if(e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if(t.closest && t.closest('.quick-row')) return;          // handled by the quick row
  if(isField(t)){ if(e.key === 'Escape') t.blur(); return; } // typing in a field
  const k = e.key;
  if(/^[1-9]$/.test(k) && PAGES[+k-1]){ e.preventDefault(); go(PAGES[+k-1]); return; }
  if(k === '?'){ e.preventDefault(); $('#helpDlg').showModal(); return; }
  if((k === 'n' || k === 'N') && can.createOrder()){ e.preventDefault(); focusQuick(); return; }
  if(k === '/'){ const s = {orders:'#fSearch', customers:'#cSearch'}[currentPage]; if(s){ e.preventDefault(); $(s).focus(); } return; }
  if(t.tagName === 'BUTTON' && (k === 'Enter' || k === ' ')) return; // let the focused button work
  if(currentPage === 'orders') ordersKeys(e);
  else if(currentPage === 'settle') settleKeys(e);
});
function ordersKeys(e){
  const k = e.key;
  if(k === 'ArrowLeft'){ e.preventDefault(); shiftDay(-1); return; }
  if(k === 'ArrowRight'){ e.preventDefault(); shiftDay(1); return; }
  if(k === 't' || k === 'T'){ goDay(today()); return; }
  if(k === 'ArrowDown' || k === 'ArrowUp' || k === 'j' || k === 'k'){
    e.preventDefault(); if(!orderIds.length) return;
    let i = orderIds.indexOf(selId);
    i = i < 0 ? 0 : Math.max(0, Math.min(orderIds.length-1, i + (k === 'ArrowDown' || k === 'j' ? 1 : -1)));
    selId = orderIds[i]; markSel(); return;
  }
  const o = db.orders.find(x => x.id === selId); if(!o) return;
  if(k === 'Enter' || k === ' '){ e.preventDefault(); toggleDetail(o.id); }
  else if((k === 'e' || k === 'E') && can.editOrder(o)){ e.preventDefault(); openOrder(o); }
  else if(k === 'Delete' || k === 'Backspace'){ e.preventDefault(); deleteOrder(o); }
}
function settleKeys(e){
  const k = e.key;
  if(k === 'ArrowRight' || k === 'ArrowLeft'){
    e.preventDefault(); const n = db.drivers.length; if(!n) return;
    const i = db.drivers.findIndex(d => d.id === settleDriver);
    settleDriver = db.drivers[i < 0 ? 0 : (i + (k === 'ArrowRight' ? 1 : -1) + n) % n].id;
    settleSel.clear(); settleCursor = null; renderSettle(); return;
  }
  if(!settleDriver) return;
  if(k === 'ArrowDown' || k === 'ArrowUp'){
    e.preventDefault(); if(!settleIds.length) return;
    let i = settleIds.indexOf(settleCursor);
    i = i < 0 ? 0 : Math.max(0, Math.min(settleIds.length-1, i + (k === 'ArrowDown' ? 1 : -1)));
    settleCursor = settleIds[i]; renderSettle(); return;
  }
  if(k === ' ' && settleCursor){ e.preventDefault(); settleSel.has(settleCursor) ? settleSel.delete(settleCursor) : settleSel.add(settleCursor); renderSettle(); return; }
  if(k === 'a' || k === 'A'){ e.preventDefault(); settleSelectAll(); return; }
  if(k === 'Enter'){ e.preventDefault(); settleMarkPaid(); }
}

/* ---------- start ---------- */

window.Delivery = { start, show };
})();
