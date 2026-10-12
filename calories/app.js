/* ═══════════════════════════════════════════════════════════════
   SnapCal — photo-first calorie tracker.
   No build step, no dependencies, no server. Meals live in
   localStorage, photos in IndexedDB, and the only network call is
   the optional photo analysis the user triggers themselves.
   ═══════════════════════════════════════════════════════════════ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const KEY_SETTINGS = 'snapcal.settings.v1';
const KEY_ENTRIES = 'snapcal.entries.v1';
const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];
const MEAL_LABEL = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };
const PLATE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6">' +
  '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="4.6"/></svg>';

const DEFAULTS = {
  goal: 2000,
  split: { p: 25, c: 45, f: 30 },
  apiKey: '',
  model: 'claude-sonnet-5-5',
  theme: 'system',
  lastMeal: null,
  autoLog: false,     // save straight after a scan, skipping the review step
};

/* ─────────────────────────── state ─────────────────────────── */

let settings = loadSettings();
let entries = loadEntries();
let foods = [];
let viewDate = dateKey(new Date());
let range = 7;
let draft = null;          // the meal being built in the review sheet
let stream = null;         // live camera stream
let facing = 'environment';

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY_SETTINGS) || '{}');
    return { ...DEFAULTS, ...raw, split: { ...DEFAULTS.split, ...(raw.split || {}) } };
  } catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings)); }
  catch { toast('Could not save settings — storage is full or blocked.'); }
}
function loadEntries() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY_ENTRIES) || '[]');
    return Array.isArray(list) ? list.filter(e => e && e.date && Array.isArray(e.items)) : [];
  } catch { return []; }
}
function saveEntries() {
  try { localStorage.setItem(KEY_ENTRIES, JSON.stringify(entries)); return true; }
  catch { toast('Could not save — this browser’s storage is full.'); return false; }
}

/* ─────────────────────────── helpers ─────────────────────────── */

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function shiftKey(k, days) { const d = parseKey(k); d.setDate(d.getDate() + days); return dateKey(d); }
function dayLabel(k) {
  const today = dateKey(new Date());
  if (k === today) return 'Today';
  if (k === shiftKey(today, -1)) return 'Yesterday';
  if (k === shiftKey(today, 1)) return 'Tomorrow';
  return parseKey(k).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
const round = (n, p = 0) => { const f = 10 ** p; return Math.round((Number(n) || 0) * f) / f; };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = n => Math.round(n).toLocaleString();

function itemTotals(it) {
  const k = it.grams / 100;
  return { kcal: it.per100.kcal * k, p: it.per100.p * k, c: it.per100.c * k, f: it.per100.f * k };
}
function sumItems(items) {
  return (items || []).reduce((a, it) => {
    const t = itemTotals(it);
    a.kcal += t.kcal; a.p += t.p; a.c += t.c; a.f += t.f; return a;
  }, { kcal: 0, p: 0, c: 0, f: 0 });
}
function dayTotals(key) { return sumItems(entries.filter(e => e.date === key).flatMap(e => e.items)); }
function macroTargets() {
  const { goal, split } = settings;
  return { p: (goal * split.p / 100) / 4, c: (goal * split.c / 100) / 4, f: (goal * split.f / 100) / 9 };
}
function guessMeal() {
  const h = new Date().getHours();
  if (h < 10.5) return 'breakfast';
  if (h < 15) return 'lunch';
  if (h < 21) return 'dinner';
  return 'snack';
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3600);
}

/* ─────────────────────── photo store (IndexedDB) ─────────────────────── */

const photoStore = (() => {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const req = indexedDB.open('snapcal', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('photos')) req.result.createObjectStore('photos');
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    }).catch(() => null);
    return dbp;
  }
  async function tx(mode, fn) {
    const db = await open();
    if (!db) return null;
    return new Promise(res => {
      let out = null;
      const t = db.transaction('photos', mode);
      const store = t.objectStore('photos');
      const r = fn(store);
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = t.onabort = () => res(null);
    });
  }
  return {
    put: (id, blob) => tx('readwrite', s => s.put(blob, id)),
    get: id => tx('readonly', s => s.get(id)),
    del: id => tx('readwrite', s => s.delete(id)),
    clear: () => tx('readwrite', s => s.clear()),
  };
})();

const thumbUrls = new Map();
async function thumbUrl(id) {
  if (!id) return null;
  if (thumbUrls.has(id)) return thumbUrls.get(id);
  const blob = await photoStore.get(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  thumbUrls.set(id, url);
  return url;
}

/* ───────────────────────── food database ───────────────────────── */

async function loadFoods() {
  try {
    const res = await fetch('foods.json');
    const data = await res.json();
    foods = data.foods || [];
    const search = $('#in-search');
    if (search) search.placeholder = `Search ${foods.length} foods — rice, roti canai, salmon…`;
  } catch { foods = []; }
}

function searchFoods(q, limit = 12) {
  const term = q.trim().toLowerCase();
  if (!term) return [];
  const words = term.split(/\s+/);
  return foods
    .map(f => {
      const hay = `${f.name} ${f.group}`.toLowerCase();
      let score = 0;
      for (const w of words) {
        const i = hay.indexOf(w);
        if (i < 0) return null;
        score += i === 0 ? 3 : hay.includes(` ${w}`) ? 2 : 1;
      }
      return { f, score: score - f.name.length / 200 };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(r => r.f);
}

function itemFromFood(food, serving) {
  const s = serving || (food.servings && food.servings[0]) || ['100 g', 100];
  return {
    uid: uid(), name: food.name, grams: s[1], portion: s[0], source: 'db', foodId: food.id,
    per100: { kcal: food.kcal, p: food.p, c: food.c, f: food.f },
  };
}

/* ─────────────────────────── navigation ─────────────────────────── */

function showScreen(tab) {
  $$('.screen').forEach(s => { s.hidden = s.id !== `screen-${tab}`; });
  $$('.tab').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('is-on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  window.scrollTo({ top: 0 });
  if (tab === 'history') renderHistory();
  if (tab === 'settings') fillSettings();
}

/* ─────────────────────────── TODAY screen ─────────────────────────── */

function renderToday() {
  $('#today-h').textContent = dayLabel(viewDate);
  $('#day-next').disabled = viewDate >= dateKey(new Date());

  const t = dayTotals(viewDate);
  const goal = settings.goal;
  const left = goal - t.kcal;
  const pct = goal > 0 ? clamp(t.kcal / goal, 0, 1) : 0;

  const CIRC = 2 * Math.PI * 82;
  const arc = $('.ring-value');
  arc.style.strokeDashoffset = String(CIRC * (1 - pct));
  arc.classList.toggle('is-over', t.kcal > goal);

  $('#kcal-left').textContent = nf(Math.abs(left));
  $('#kcal-left-label').textContent = left >= 0 ? 'kcal left' : 'kcal over';
  $('#kcal-of').textContent = `${nf(t.kcal)} of ${nf(goal)} kcal`;
  $('.ring-desc').textContent = `${nf(t.kcal)} of ${nf(goal)} kcal logged — ${left >= 0 ? `${nf(left)} left` : `${nf(-left)} over goal`}.`;

  // Status gets an icon (the dot) plus words — never colour alone.
  const status = $('#goal-status');
  if (t.kcal === 0) {
    status.hidden = true;
  } else {
    status.hidden = false;
    const over = t.kcal > goal;
    const near = !over && t.kcal >= goal * 0.9;
    status.dataset.state = over ? 'critical' : near ? 'warning' : 'good';
    status.innerHTML = `<span class="dot" aria-hidden="true"></span>${
      over ? `Over goal by ${nf(t.kcal - goal)} kcal`
      : near ? `Close to goal — ${nf(left)} kcal left`
      : `On track — ${nf(left)} kcal left`}`;
  }

  const targets = macroTargets();
  for (const m of ['p', 'c', 'f']) {
    const row = $(`.macro[data-macro="${m}"]`);
    const val = t[m], target = targets[m];
    row.querySelector('.macro-val').textContent = `${nf(val)} / ${nf(target)} g`;
    row.querySelector('.macro-fill').style.width = `${clamp(target ? val / target : 0, 0, 1) * 100}%`;
  }

  renderMeals();
}

async function renderMeals() {
  const wrap = $('#meal-groups');
  const list = entries.filter(e => e.date === viewDate);

  if (!list.length) {
    wrap.innerHTML = `<div class="empty">
      <strong>Nothing logged ${viewDate === dateKey(new Date()) ? 'yet today' : 'for this day'}</strong>
      <p>Tap <b>Snap</b> to photograph a meal, or add food by name.</p>
    </div>`;
    return;
  }

  const byMeal = {};
  for (const e of list) (byMeal[e.meal] ||= []).push(e);

  wrap.innerHTML = MEALS.filter(m => byMeal[m]).map(m => {
    const group = byMeal[m].sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    const gt = sumItems(group.flatMap(e => e.items));
    return `<section class="meal-group">
      <div class="meal-group-head">
        <h3>${MEAL_LABEL[m]}</h3>
        <span class="meal-group-kcal">${nf(gt.kcal)} kcal</span>
      </div>
      ${group.map(e => entryRow(e)).join('')}
    </section>`;
  }).join('');

  // thumbnails load asynchronously from IndexedDB
  for (const e of list) {
    if (!e.photoId) continue;
    const url = await thumbUrl(e.photoId);
    const slot = wrap.querySelector(`[data-thumb="${e.id}"]`);
    if (url && slot) slot.innerHTML = `<img src="${url}" alt="">`;
  }
}

function entryRow(e) {
  const t = sumItems(e.items);
  const names = e.items.map(i => i.name).join(', ') || 'Meal';
  const time = e.ts ? new Date(e.ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
  const sub = [time, `${nf(t.p)}p · ${nf(t.c)}c · ${nf(t.f)}f`, e.source === 'ai' ? 'photo estimate' : null]
    .filter(Boolean).join(' · ');
  return `<article class="entry" data-entry="${e.id}">
    <span data-thumb="${e.id}" class="entry-thumb">${PLATE_SVG}</span>
    <div class="entry-main">
      <div class="entry-name">${esc(names)}</div>
      <div class="entry-sub">${esc(sub)}</div>
    </div>
    <div class="entry-kcal">${nf(t.kcal)}<small>kcal</small></div>
    <div class="entry-actions">
      <button type="button" class="icon-btn" data-edit="${e.id}" aria-label="Edit ${esc(names)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16v4Zm12.7-12.7 2.6-2.6a1 1 0 0 0 0-1.4l-1.6-1.6a1 1 0 0 0-1.4 0l-2.6 2.6 3 3Z"/></svg>
      </button>
      <button type="button" class="icon-btn" data-del="${e.id}" aria-label="Delete ${esc(names)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 21a2 2 0 0 1-2-2V7h14v12a2 2 0 0 1-2 2H7ZM9 4h6l1 2h4v2H4V6h4l1-2Z"/></svg>
      </button>
    </div>
  </article>`;
}

/* ─────────────────────────── HISTORY screen ─────────────────────────── */

function daySeries(n) {
  const today = dateKey(new Date());
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const key = shiftKey(today, -i);
    out.push({ key, ...dayTotals(key) });
  }
  return out;
}

function renderHistory() {
  const days = daySeries(range);
  const logged = days.filter(d => d.kcal > 0);
  const avg = logged.length ? logged.reduce((a, d) => a + d.kcal, 0) / logged.length : 0;
  const onTarget = logged.filter(d => d.kcal <= settings.goal).length;

  $('#stat-avg').textContent = logged.length ? nf(avg) : '—';
  $('#stat-avg-foot').textContent = `last ${range} days`;
  $('#stat-ontarget').textContent = logged.length ? `${onTarget}/${logged.length}` : '—';
  $('#stat-meals').textContent = nf(entries.length);

  const goal = settings.goal;
  const peak = Math.max(goal * 1.15, ...days.map(d => d.kcal));
  const chart = $('#chart-days');

  // One series, magnitude over time → single sequential hue, no legend.
  chart.innerHTML = days.map(d => {
    const h = peak ? (d.kcal / peak) * 100 : 0;
    return `<button type="button" class="bar-col" data-key="${d.key}" data-empty="${d.kcal ? 0 : 1}"
      aria-label="${dayLabel(d.key)}: ${nf(d.kcal)} kcal">
      <span class="bar" style="height:${Math.max(h, d.kcal ? 2 : 1)}%"></span>
    </button>`;
  }).join('') + `<div class="goal-line" style="bottom:${(goal / peak) * 100}%"><span>goal ${nf(goal)}</span></div>`;

  const step = range > 14 ? 5 : range > 7 ? 2 : 1;
  const axis = document.createElement('div');
  axis.className = 'chart-axis';
  axis.innerHTML = days.map((d, i) => {
    const show = i === days.length - 1 || i % step === 0;
    const dd = parseKey(d.key);
    return `<span>${show ? dd.toLocaleDateString(undefined, { day: 'numeric', month: range > 14 ? 'numeric' : 'short' }) : ''}</span>`;
  }).join('');
  chart.parentElement.querySelector('.chart-axis')?.remove();
  chart.after(axis);

  $('#chart-days-desc').textContent =
    `Calories per day for the last ${range} days. Daily goal ${nf(goal)} kcal. ` +
    days.map(d => `${d.key}: ${nf(d.kcal)}`).join('; ');

  renderDayTable(days);
}

function renderDayTable(days) {
  $('#table-days').innerHTML = `<table class="data">
    <caption class="sr-only">Daily totals</caption>
    <thead><tr><th scope="col">Day</th><th scope="col">kcal</th><th scope="col">P</th><th scope="col">C</th><th scope="col">F</th></tr></thead>
    <tbody>${days.slice().reverse().map(d => `<tr>
      <td>${esc(dayLabel(d.key))}</td><td>${nf(d.kcal)}</td><td>${nf(d.p)}</td><td>${nf(d.c)}</td><td>${nf(d.f)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function wireChartHover() {
  const chart = $('#chart-days');
  const tip = $('#chart-tip');
  const show = col => {
    const d = { key: col.dataset.key, ...dayTotals(col.dataset.key) };
    tip.innerHTML = `<strong>${esc(dayLabel(d.key))}</strong>${nf(d.kcal)} kcal · ${nf(d.p)}p ${nf(d.c)}c ${nf(d.f)}f`;
    tip.hidden = false;
    const wrap = chart.parentElement.getBoundingClientRect();
    const r = col.getBoundingClientRect();
    tip.style.left = `${clamp(r.left - wrap.left + r.width / 2, 70, Math.max(70, wrap.width - 70))}px`;
    const above = r.top - wrap.top - 6;
    const h = tip.offsetHeight;
    // Flip below the bar top when the tooltip would escape the card.
    tip.style.top = above - h < 0 ? `${r.top - wrap.top + h + 10}px` : `${above}px`;
  };
  const hide = () => { tip.hidden = true; };
  chart.addEventListener('pointerover', e => { const c = e.target.closest('.bar-col'); if (c) show(c); });
  chart.addEventListener('focusin', e => { const c = e.target.closest('.bar-col'); if (c) show(c); });
  chart.addEventListener('pointerleave', hide);
  chart.addEventListener('focusout', hide);
  chart.addEventListener('click', e => {
    const c = e.target.closest('.bar-col');
    if (!c) return;
    viewDate = c.dataset.key;
    renderToday();
    showScreen('today');
  });
}

/* ─────────────────────────── camera ─────────────────────────── */

async function openCamera() {
  const dlg = $('#dlg-capture');
  dlg.showModal();
  await startStream();
}

async function startStream() {
  stopStream();
  const msg = $('#cam-msg');
  const video = $('#cam-video');
  if (!navigator.mediaDevices?.getUserMedia) {
    msg.textContent = 'This browser can’t open the camera — use “Choose photo” instead.';
    setCameraReady(false);
    return;
  }
  try {
    msg.textContent = 'Starting camera…';
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 } }, audio: false,
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
    msg.textContent = 'Fill the frame with your plate, then tap the shutter.';
    setCameraReady(true);
  } catch (err) {
    msg.textContent = err && err.name === 'NotAllowedError'
      ? 'Camera permission was blocked. Use “Choose photo”, or allow the camera in your browser settings.'
      : 'No camera available — use “Choose photo” instead.';
    setCameraReady(false);
  }
}

function setCameraReady(ready) {
  $('#btn-shutter').disabled = !ready;
  $('.cam-bar').classList.toggle('no-cam', !ready);
}

function stopStream() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  const v = $('#cam-video');
  if (v) v.srcObject = null;
}

/** Draw a source image/video onto the work canvas, longest side `max`. */
function toJpeg(src, max, quality) {
  const sw = src.videoWidth || src.naturalWidth || src.width;
  const sh = src.videoHeight || src.naturalHeight || src.height;
  const scale = Math.min(1, max / Math.max(sw, sh));
  const canvas = $('#work-canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return new Promise(res => canvas.toBlob(b => res(b), 'image/jpeg', quality));
}

async function captureFromVideo() {
  const video = $('#cam-video');
  if (!video.videoWidth) { toast('Camera is not ready yet.'); return; }
  // toJpeg reuses a single canvas, so the two sizes are drawn one after the other.
  const full = await toJpeg(video, 1120, 0.82);
  const small = await toJpeg(video, 480, 0.75);
  await beginDraft(full, small);
}

async function captureFromFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('That file is not an image.'); return; }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const full = await toJpeg(img, 1120, 0.82);
    const small = await toJpeg(img, 480, 0.75);
    await beginDraft(full, small);
  } catch {
    toast('Could not read that photo.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ─────────────────────── review sheet / draft meal ─────────────────────── */

async function beginDraft(fullBlob, smallBlob) {
  draft = {
    id: uid(), date: viewDate, meal: settings.lastMeal || guessMeal(),
    items: [], fullBlob: fullBlob || null, smallBlob: smallBlob || null,
    photoId: null, source: null, editing: null,
  };
  if ($('#dlg-capture').open) $('#dlg-capture').close();
  stopStream();
  openReview();
  if (!fullBlob) { $('#in-search').focus(); return; }
  // A photo is the whole instruction — read it without waiting for another tap.
  if (settings.apiKey) analysePhoto();
}

function openReview() {
  const dlg = $('#dlg-review');
  const img = $('#review-photo');
  if (img.dataset.url) { URL.revokeObjectURL(img.dataset.url); delete img.dataset.url; }

  if (draft.smallBlob) {
    const url = URL.createObjectURL(draft.smallBlob);
    img.src = url; img.dataset.url = url; img.hidden = false;
  } else if (draft.photoId) {
    thumbUrl(draft.photoId).then(u => { if (u) { img.src = u; img.hidden = false; } });
  } else {
    img.hidden = true;
  }

  $('#review-h').textContent = draft.editing ? 'Edit meal' : 'New meal';
  $('#ai-box').hidden = !draft.fullBlob;
  $('#no-key-box').hidden = !draft.fullBlob || !!settings.apiKey;
  $('#ai-status').textContent = '';
  $('#btn-analyze').disabled = !settings.apiKey;
  $('#btn-analyze').textContent = draft.items.length ? 'Scan the photo again' : 'Scan this photo';
  $('#in-hint').value = draft.hint || '';
  $('#in-search').value = '';
  $('#search-results').hidden = true;

  syncMealButtons();
  renderDraftItems();
  if (!dlg.open) dlg.showModal();
}

function syncMealButtons() {
  $$('[data-meal]').forEach(b => b.classList.toggle('is-on', b.dataset.meal === draft.meal));
}

function renderDraftItems() {
  const wrap = $('#review-items');
  wrap.innerHTML = draft.items.map(it => {
    const t = itemTotals(it);
    return `<div class="item" data-uid="${it.uid}">
      <div class="item-top">
        <input class="item-name" type="text" value="${esc(it.name)}" data-f="name" aria-label="Food name" placeholder="Food name">
        ${it.conf ? `<span class="badge" data-conf="${esc(it.conf)}" title="Claude's confidence in this estimate">${esc(it.conf)} confidence</span>` : ''}
        <button type="button" class="icon-btn" data-remove="${it.uid}" aria-label="Remove ${esc(it.name || 'item')}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6 6.4 5Z"/></svg>
        </button>
      </div>
      ${it.portion ? `<p class="item-portion">${esc(it.portion)}</p>` : ''}
      <div class="item-grid">
        <label class="field"><span>Amount (g)</span><input type="number" min="1" max="5000" step="1" value="${round(it.grams)}" data-f="grams" inputmode="numeric"></label>
        <label class="field"><span>Calories</span><input type="number" min="0" max="5000" step="1" value="${round(t.kcal)}" data-f="kcal" inputmode="numeric"></label>
      </div>
      <div class="item-grid macros-grid">
        <label class="field"><span>Protein g</span><input type="number" min="0" max="500" step="0.1" value="${round(t.p, 1)}" data-f="p" inputmode="decimal"></label>
        <label class="field"><span>Carbs g</span><input type="number" min="0" max="500" step="0.1" value="${round(t.c, 1)}" data-f="c" inputmode="decimal"></label>
        <label class="field"><span>Fat g</span><input type="number" min="0" max="500" step="0.1" value="${round(t.f, 1)}" data-f="f" inputmode="decimal"></label>
      </div>
    </div>`;
  }).join('');
  renderDraftTotals();
}

function renderDraftTotals() {
  const t = sumItems(draft.items);
  const logged = dayTotals(draft.date).kcal;
  const replacing = draft.editing ? sumItems(entries.find(e => e.id === draft.editing)?.items || []).kcal : 0;
  const after = logged - replacing + t.kcal;
  $('#review-totals').innerHTML = draft.items.length
    ? `<strong>${nf(t.kcal)}</strong> kcal
       <span class="t-macros">${nf(t.p)}p · ${nf(t.c)}c · ${nf(t.f)}f · day total ${nf(after)} / ${nf(settings.goal)}</span>`
    : `<span>Nothing added yet — analyse the photo or search for the food.</span>`;
  $('#btn-save-meal').disabled = !draft.items.length || !!draft.scanning;
}

function updateItemField(uidStr, field, raw) {
  const it = draft.items.find(i => i.uid === uidStr);
  if (!it) return;
  if (field === 'name') { it.name = raw; return; }
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) return;
  if (field === 'grams') {
    it.grams = clamp(num || 1, 1, 5000);            // per-100g values hold, totals scale
    const host = document.querySelector(`#review-items [data-uid="${uidStr}"]`);
    if (host) {
      const t = itemTotals(it);
      for (const [f, v, dp] of [['kcal', t.kcal, 0], ['p', t.p, 1], ['c', t.c, 1], ['f', t.f, 1]]) {
        const input = host.querySelector(`[data-f="${f}"]`);
        if (input && document.activeElement !== input) input.value = round(v, dp);
      }
    }
  } else {
    const k = it.grams / 100 || 1;
    it.per100[field === 'kcal' ? 'kcal' : field] = num / k;
  }
  renderDraftTotals();
}

/* ─────────────────────── Claude photo analysis ─────────────────────── */

const ANALYSIS_TOOL = {
  name: 'log_meal',
  description: 'Report the foods visible in the photo with an estimated portion and nutrition for each.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'One entry per distinct food or drink on the plate. Split composite dishes only when the parts are clearly separate (e.g. rice, curry, egg).',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short dish or food name as a person would write it.' },
            portion: { type: 'string', description: 'The portion you judged, in plain words, e.g. "1 cupped handful" or "half a plate".' },
            grams: { type: 'number', description: 'Estimated edible weight in grams.' },
            kcal: { type: 'number', description: 'Estimated calories for that portion.' },
            protein_g: { type: 'number' },
            carbs_g: { type: 'number' },
            fat_g: { type: 'number' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['name', 'grams', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'confidence'],
        },
      },
      meal: { type: 'string', enum: MEALS, description: 'Which meal this most likely is.' },
      note: { type: 'string', description: 'One short caveat if the photo makes the estimate uncertain.' },
    },
    required: ['items'],
  },
};

const SYSTEM_PROMPT = [
  'You read photos of food and estimate what is on the plate for a calorie diary.',
  'Judge portion size from visual cues: plate and bowl diameter, cutlery, hands, cans and cups.',
  'Account for cooking fat in fried and stir-fried food, and for sauces and dressings you can see.',
  'Give realistic everyday-portion figures. Prefer a sensible central estimate over a flattering low one.',
  'Return one item per distinct food. Always call the log_meal tool. If the photo shows no food, return an empty items list and say so in note.',
].join(' ');

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

async function analysePhoto() {
  if (!settings.apiKey) { toast('Add an API key in Settings first.'); return; }
  if (!draft.fullBlob) { toast('No photo to analyse.'); return; }

  const btn = $('#btn-analyze');
  const status = $('#ai-status');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin" aria-hidden="true"></span> Reading your photo…';
  status.textContent = '';
  draft.hint = $('#in-hint').value.trim();
  draft.scanning = true;
  showScanning(true);

  try {
    const data = await blobToBase64(draft.fullBlob);
    const text = draft.hint
      ? `What is in this meal, and roughly how many calories? Extra context from me: ${draft.hint}`
      : 'What is in this meal, and roughly how many calories?';

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: 1200,
        system: SYSTEM_PROMPT,
        tools: [ANALYSIS_TOOL],
        tool_choice: { type: 'tool', name: 'log_meal' },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
            { type: 'text', text },
          ],
        }],
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error?.message || `${res.status} ${res.statusText}`);
    }

    const payload = await res.json();
    const call = (payload.content || []).find(b => b.type === 'tool_use');
    const out = call?.input;
    if (!out || !Array.isArray(out.items)) throw new Error('The model did not return a meal.');

    if (!out.items.length) {
      status.textContent = out.note || 'No food found in that photo. Add it by name below.';
    } else {
      draft.items = out.items.map(raw => {
        const grams = clamp(Number(raw.grams) || 100, 1, 5000);
        const k = grams / 100;
        return {
          uid: uid(), name: String(raw.name || 'Food').slice(0, 80), grams,
          portion: raw.portion ? String(raw.portion).slice(0, 60) : '',
          conf: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'medium',
          source: 'ai',
          per100: {
            kcal: (Number(raw.kcal) || 0) / k,
            p: (Number(raw.protein_g) || 0) / k,
            c: (Number(raw.carbs_g) || 0) / k,
            f: (Number(raw.fat_g) || 0) / k,
          },
        };
      });
      draft.source = 'ai';
      if (MEALS.includes(out.meal) && !draft.editing) { draft.meal = out.meal; syncMealButtons(); }
      status.textContent = out.note
        ? `${out.note} Check the numbers before saving.`
        : 'Estimates only — tweak anything that looks off before saving.';
      renderDraftItems();

      // "Snap and it's logged": save without the review step when asked to.
      if (settings.autoLog && !draft.editing) {
        draft.scanning = false;
        showScanning(false);
        await saveDraft({ auto: true });
        return;
      }
    }
  } catch (err) {
    const m = String(err && err.message || err);
    status.textContent = /Failed to fetch|NetworkError|load failed/i.test(m)
      ? 'Could not reach api.anthropic.com. Check your connection, then try again.'
      : `Analysis failed: ${m}`;
  } finally {
    if (draft) { draft.scanning = false; }
    showScanning(false);
    btn.disabled = !settings.apiKey;
    btn.textContent = draft && draft.items.length ? 'Scan the photo again' : 'Scan this photo';
  }
}

/** Show the review sheet as busy while the photo is being read. */
function showScanning(on) {
  const sheet = $('#dlg-review');
  sheet.classList.toggle('is-scanning', on);
  $('#scan-note').hidden = !on;
  $('#btn-save-meal').disabled = on || !(draft && draft.items.length);
}

/* ─────────────────────────── save / edit / delete ─────────────────────────── */

async function saveDraft({ auto = false } = {}) {
  if (!draft.items.length) return;

  let photoId = draft.photoId;
  if (draft.smallBlob) {
    photoId = photoId || `p_${draft.id}`;
    await photoStore.put(photoId, draft.smallBlob);
  }

  const entry = {
    id: draft.editing || draft.id,
    date: draft.date,
    ts: draft.ts || new Date().toISOString(),
    meal: draft.meal,
    items: draft.items.map(({ uid: u, name, grams, portion, per100, source, conf, foodId }) =>
      ({ uid: u, name, grams: round(grams), portion, per100, source, conf, foodId })),
    photoId: photoId || null,
    source: draft.source,
    model: draft.source === 'ai' ? settings.model : undefined,
  };

  const i = entries.findIndex(e => e.id === entry.id);
  const previous = i >= 0 ? entries[i] : null;
  if (i >= 0) entries[i] = entry; else entries.push(entry);

  if (!saveEntries()) {
    if (previous) entries[i] = previous; else entries.pop();
    return;
  }

  settings.lastMeal = draft.meal;
  saveSettings();

  const total = sumItems(entry.items).kcal;
  closeReview();
  viewDate = entry.date;
  renderToday();
  showScreen('today');
  toast(auto
    ? `Logged ${nf(total)} kcal — tap the meal to adjust`
    : `${draft?.editing ? 'Updated' : 'Logged'} ${nf(total)} kcal`);
  draft = null;
}

function editEntry(id) {
  const e = entries.find(x => x.id === id);
  if (!e) return;
  draft = {
    id: e.id, editing: e.id, date: e.date, ts: e.ts, meal: e.meal,
    items: e.items.map(it => ({ ...it, uid: it.uid || uid(), per100: { ...it.per100 } })),
    fullBlob: null, smallBlob: null, photoId: e.photoId || null, source: e.source || null,
  };
  openReview();
}

async function deleteEntry(id) {
  const e = entries.find(x => x.id === id);
  if (!e) return;
  const names = e.items.map(i => i.name).join(', ');
  if (!confirm(`Delete “${names}” (${nf(sumItems(e.items).kcal)} kcal)?`)) return;
  entries = entries.filter(x => x.id !== id);
  saveEntries();
  if (e.photoId) {
    await photoStore.del(e.photoId);
    const url = thumbUrls.get(e.photoId);
    if (url) { URL.revokeObjectURL(url); thumbUrls.delete(e.photoId); }
  }
  renderToday();
  toast('Meal deleted');
}

function closeReview() {
  const img = $('#review-photo');
  if (img.dataset.url) { URL.revokeObjectURL(img.dataset.url); delete img.dataset.url; }
  img.removeAttribute('src');
  $('#dlg-review').close();
}

/* ─────────────────────────── settings ─────────────────────────── */

function fillSettings() {
  $('#in-goal').value = settings.goal;
  $('#in-sp').value = settings.split.p;
  $('#in-sc').value = settings.split.c;
  $('#in-sf').value = settings.split.f;
  $('#in-key').value = settings.apiKey;
  $('#in-model').value = settings.model;
  $('#in-autolog').checked = !!settings.autoLog;
  $$('[data-theme-opt]').forEach(b => b.classList.toggle('is-on', b.dataset.themeOpt === settings.theme));
  updateSplitHint();
  $('#key-status').textContent = settings.apiKey ? 'A key is saved in this browser.' : 'No key saved — meals are added by hand.';
}

function updateSplitHint() {
  const p = Number($('#in-sp').value) || 0, c = Number($('#in-sc').value) || 0, f = Number($('#in-sf').value) || 0;
  const sum = p + c + f;
  const goal = Number($('#in-goal').value) || settings.goal;
  $('#split-hint').textContent = sum === 100
    ? `${round(goal * p / 400)} g protein · ${round(goal * c / 400)} g carbs · ${round(goal * f / 900)} g fat per day`
    : `The three percentages add up to ${sum}% — they need to make 100%.`;
}

function applyTheme() {
  if (settings.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', settings.theme);
}

function estimateGoal() {
  const sex = $('#in-sex').value;
  const age = Number($('#in-age').value), h = Number($('#in-height').value), w = Number($('#in-weight').value);
  const act = Number($('#in-activity').value), aim = Number($('#in-aim').value);
  if (!age || !h || !w) { $('#calc-out').textContent = 'Fill in age, height and weight first.'; return; }
  const bmr = 10 * w + 6.25 * h - 5 * age + (sex === 'm' ? 5 : -161);
  const goal = clamp(Math.round((bmr * act + aim) / 10) * 10, 1200, 5000);
  $('#in-goal').value = goal;
  updateSplitHint();
  $('#calc-out').textContent = `Maintenance is about ${nf(bmr * act)} kcal, so your goal is ${nf(goal)} kcal. Press “Save targets” to keep it.`;
}

async function testKey() {
  const key = $('#in-key').value.trim();
  const status = $('#key-status');
  if (!key) { status.textContent = 'Paste a key first.'; return; }
  status.innerHTML = '<span class="spin" aria-hidden="true"></span> Checking…';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-api-key': key,
        'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: $('#in-model').value, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with OK.' }] }),
    });
    if (res.ok) status.textContent = 'Key works. Photo analysis is ready.';
    else {
      const b = await res.json().catch(() => ({}));
      status.textContent = `Key rejected (${res.status}): ${b?.error?.message || res.statusText}`;
    }
  } catch {
    status.textContent = 'Could not reach api.anthropic.com — check your connection.';
  }
}

/* ─────────────────────────── import / export ─────────────────────────── */

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportJson() {
  download(`snapcal-${dateKey(new Date())}.json`,
    JSON.stringify({ app: 'snapcal', version: 1, exported: new Date().toISOString(), settings: { ...settings, apiKey: '' }, entries }, null, 2),
    'application/json');
  $('#data-status').textContent = 'Exported your meals as JSON (the API key is left out).';
}

function exportCsv() {
  const rows = [['date', 'time', 'meal', 'food', 'grams', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'source']];
  for (const e of entries.slice().sort((a, b) => (a.ts || '').localeCompare(b.ts || ''))) {
    for (const it of e.items) {
      const t = itemTotals(it);
      rows.push([e.date, e.ts ? new Date(e.ts).toLocaleTimeString() : '', e.meal, it.name,
        round(it.grams), round(t.kcal), round(t.p, 1), round(t.c, 1), round(t.f, 1), it.source || '']);
    }
  }
  const csv = rows.map(r => r.map(v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\n');
  download(`snapcal-${dateKey(new Date())}.csv`, csv, 'text/csv');
  $('#data-status').textContent = `Exported ${rows.length - 1} rows as CSV.`;
}

function importJson() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = Array.isArray(data) ? data : data.entries;
      if (!Array.isArray(incoming)) throw new Error('no entries');
      const known = new Set(entries.map(e => e.id));
      let added = 0;
      for (const e of incoming) {
        if (!e || !e.date || !Array.isArray(e.items) || known.has(e.id)) continue;
        entries.push({ ...e, id: e.id || uid(), photoId: null });
        known.add(e.id); added++;
      }
      saveEntries();
      renderToday();
      $('#data-status').textContent = `Imported ${added} meal${added === 1 ? '' : 's'} (photos are not part of an export).`;
    } catch {
      $('#data-status').textContent = 'That file is not a SnapCal export.';
    }
  };
  input.click();
}

async function wipeAll() {
  if (!confirm(`Delete all ${entries.length} logged meals, their photos and your settings? This cannot be undone.`)) return;
  entries = [];
  localStorage.removeItem(KEY_ENTRIES);
  localStorage.removeItem(KEY_SETTINGS);
  await photoStore.clear();
  for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
  thumbUrls.clear();
  settings = { ...DEFAULTS };
  applyTheme();
  fillSettings();
  renderToday();
  $('#data-status').textContent = 'Everything deleted.';
}

/* ─────────────────────────── wiring ─────────────────────────── */

function wire() {
  // tabs & screens
  $$('.tab').forEach(b => b.addEventListener('click', () => showScreen(b.dataset.tab)));
  $('#btn-settings').addEventListener('click', () => showScreen('settings'));

  // day navigation
  $('#day-prev').addEventListener('click', () => { viewDate = shiftKey(viewDate, -1); renderToday(); });
  $('#day-next').addEventListener('click', () => {
    if (viewDate >= dateKey(new Date())) return;
    viewDate = shiftKey(viewDate, 1); renderToday();
  });

  // entry actions
  $('#meal-groups').addEventListener('click', e => {
    const ed = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-del]');
    if (ed) editEntry(ed.dataset.edit);
    else if (del) deleteEntry(del.dataset.del);
  });

  // capture
  $('#btn-snap').addEventListener('click', openCamera);
  $('#btn-add-manual').addEventListener('click', () => beginDraft(null, null));
  $('#btn-shutter').addEventListener('click', captureFromVideo);
  $('#btn-flip').addEventListener('click', () => {
    facing = facing === 'environment' ? 'user' : 'environment';
    startStream();
  });
  $('#in-file').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    captureFromFile(f);
  });
  $('#dlg-capture').addEventListener('close', stopStream);

  // review sheet
  $$('[data-meal]').forEach(b => b.addEventListener('click', () => {
    if (!draft) return;
    draft.meal = b.dataset.meal;
    syncMealButtons();
  }));
  $('#btn-analyze').addEventListener('click', analysePhoto);
  $('#review-items').addEventListener('input', e => {
    const f = e.target.dataset.f;
    const host = e.target.closest('[data-uid]');
    if (f && host) updateItemField(host.dataset.uid, f, e.target.value);
  });
  $('#review-items').addEventListener('click', e => {
    const rm = e.target.closest('[data-remove]');
    if (!rm || !draft) return;
    draft.items = draft.items.filter(i => i.uid !== rm.dataset.remove);
    renderDraftItems();
  });
  $('#btn-save-meal').addEventListener('click', saveDraft);
  $('#btn-cancel-meal').addEventListener('click', () => { closeReview(); draft = null; });
  $('#dlg-review').addEventListener('close', () => {
    const img = $('#review-photo');
    if (img.dataset.url) { URL.revokeObjectURL(img.dataset.url); delete img.dataset.url; }
  });

  // food search
  const search = $('#in-search');
  const results = $('#search-results');
  const closeResults = () => { results.hidden = true; search.setAttribute('aria-expanded', 'false'); };
  search.addEventListener('input', () => {
    const hits = searchFoods(search.value);
    if (!hits.length) { closeResults(); return; }
    results.innerHTML = hits.map(f => {
      const s = (f.servings && f.servings[0]) || ['100 g', 100];
      return `<li role="option"><button type="button" data-food="${esc(f.id)}">
        <span class="r-name">${esc(f.name)}</span>
        <span class="r-kcal">${nf(f.kcal * s[1] / 100)} kcal · ${esc(s[0])}</span>
      </button></li>`;
    }).join('');
    results.hidden = false;
    search.setAttribute('aria-expanded', 'true');
  });
  results.addEventListener('click', e => {
    const btn = e.target.closest('[data-food]');
    if (!btn || !draft) return;
    const food = foods.find(f => f.id === btn.dataset.food);
    if (!food) return;
    draft.items.push(itemFromFood(food));
    search.value = '';
    closeResults();
    renderDraftItems();
  });
  search.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeResults(); e.stopPropagation(); }
    if (e.key === 'ArrowDown') { results.querySelector('button')?.focus(); e.preventDefault(); }
  });
  $('#btn-custom').addEventListener('click', () => {
    if (!draft) return;
    draft.items.push({ uid: uid(), name: '', grams: 100, portion: '', source: 'manual', per100: { kcal: 0, p: 0, c: 0, f: 0 } });
    renderDraftItems();
    const inputs = $$('#review-items .item-name');
    inputs[inputs.length - 1]?.focus();
  });

  // history
  $$('[data-range]').forEach(b => b.addEventListener('click', () => {
    range = Number(b.dataset.range);
    $$('[data-range]').forEach(x => x.classList.toggle('is-on', x === b));
    renderHistory();
  }));
  $('#btn-table').addEventListener('click', () => {
    const t = $('#table-days');
    t.hidden = !t.hidden;
    $('#btn-table').setAttribute('aria-expanded', String(!t.hidden));
    $('#btn-table').textContent = t.hidden ? 'Table view' : 'Hide table';
  });
  wireChartHover();

  // settings
  $('#form-goals').addEventListener('submit', e => {
    e.preventDefault();
    const goal = clamp(Number($('#in-goal').value) || DEFAULTS.goal, 800, 6000);
    const p = Number($('#in-sp').value) || 0, c = Number($('#in-sc').value) || 0, f = Number($('#in-sf').value) || 0;
    if (p + c + f !== 100) { toast('Macro percentages must add up to 100%.'); return; }
    settings.goal = goal;
    settings.split = { p, c, f };
    saveSettings();
    renderToday();
    toast('Targets saved');
  });
  ['#in-goal', '#in-sp', '#in-sc', '#in-sf'].forEach(s => $(s).addEventListener('input', updateSplitHint));
  $('#btn-calc').addEventListener('click', estimateGoal);

  $('#form-ai').addEventListener('submit', e => {
    e.preventDefault();
    settings.apiKey = $('#in-key').value.trim();
    settings.model = $('#in-model').value;
    saveSettings();
    $('#key-status').textContent = settings.apiKey
      ? 'Saved in this browser. Snap a meal and tap “Analyse photo”.'
      : 'Key cleared — meals are added by hand.';
    toast('Saved');
  });
  $('#btn-test-key').addEventListener('click', testKey);
  $('#in-autolog').addEventListener('change', e => {
    settings.autoLog = e.target.checked;
    saveSettings();
    toast(settings.autoLog ? 'Scans will be logged straight away' : 'Scans will wait for your review');
  });
  $('#btn-setup-key').addEventListener('click', () => {
    closeReview();
    draft = null;
    showScreen('settings');
    $('#in-key').focus();
    $('#in-key').scrollIntoView({ block: 'center', behavior: 'smooth' });
  });

  $$('[data-theme-opt]').forEach(b => b.addEventListener('click', () => {
    settings.theme = b.dataset.themeOpt;
    saveSettings();
    applyTheme();
    $$('[data-theme-opt]').forEach(x => x.classList.toggle('is-on', x === b));
  }));

  $('#btn-export-json').addEventListener('click', exportJson);
  $('#btn-export-csv').addEventListener('click', exportCsv);
  $('#btn-import').addEventListener('click', importJson);
  $('#btn-wipe').addEventListener('click', wipeAll);

  // keep the day in step when the app is left open past midnight
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    renderToday();
    if (!$('#screen-history').hidden) renderHistory();
  });
}

/* ─────────────────────────── boot ─────────────────────────── */

applyTheme();
wire();
renderToday();
fillSettings();
loadFoods();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
