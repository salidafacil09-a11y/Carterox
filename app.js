/* El Carterox — app de reparto para carteros.
   Todo corre en el navegador; los datos quedan en el teléfono (localStorage + IndexedDB). */
'use strict';

/* =========================================================
   ESTADO Y GUARDADO
   ========================================================= */
const STORE_KEY = 'carterox_v1';
const DEFAULT_STATE = {
  profile: null,          // {name, vehicle, hand, city, apiKey, goal}
  mode: 'simples',        // 'simples' | 'certi'
  streets: [],
  certi: [],
  registros: {},          // 'YYYY-MM-DD' -> {...}
  travel: { simples: null, certi: null },
};
let state = load();
let lastPos = null;       // {lat, lng}
let weekOffset = 0;

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return Object.assign(structuredClone(DEFAULT_STATE), JSON.parse(raw));
  } catch (e) { console.warn(e); }
  return structuredClone(DEFAULT_STATE);
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('No se pudo guardar: memoria llena'); }
}

/* =========================================================
   UTILIDADES
   ========================================================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const todayISO = () => isoDate(new Date());
function isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function fmtDur(secs) {
  secs = Math.max(0, Math.round(secs || 0));
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  if (h) return `${h} h ${pad(m)} min`;
  if (m) return `${m} min`;
  return `${secs} s`;
}
function fmtClock(date) { return `${pad(date.getHours())}:${pad(date.getMinutes())}`; }
function fmtKm(m) { return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`; }

let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function haversine(a, b) {
  const R = 6371000, toR = x => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Proyección local en metros (x = este, y = norte) respecto de un origen
function toXY(p, o) {
  return { x: (p.lng - o.lng) * 111320 * Math.cos(o.lat * Math.PI / 180), y: (p.lat - o.lat) * 110540 };
}
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('No se pudo cargar ' + src));
    document.head.appendChild(s);
  });
}

const VEHICLES = {
  pie:       { label: 'A pie',          icon: '🚶', speed: 1.3, gmaps: 'walking',   routes: 'WALK' },
  bici:      { label: 'Bici',           icon: '🚲', speed: 4.2, gmaps: 'bicycling', routes: 'BICYCLE' },
  ebici:     { label: 'Bici eléctrica', icon: '⚡', speed: 5.6, gmaps: 'bicycling', routes: 'BICYCLE', factor: 0.75 },
  camioneta: { label: 'Camioneta',      icon: '🚐', speed: 6.5, gmaps: 'driving',   routes: 'DRIVE' },
};

/* =========================================================
   FOTOS (IndexedDB)
   ========================================================= */
const photoDB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('carterox_fotos', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('fotos');
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('fotos', mode), st = t.objectStore('fotos');
      const req = fn(st);
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  },
  put(k, blob) { return this.tx('readwrite', s => s.put(blob, k)); },
  get(k) { return this.tx('readonly', s => s.get(k)); },
  del(k) { return this.tx('readwrite', s => s.delete(k)); },
  keys() { return this.tx('readonly', s => s.getAllKeys()); },
  clear() { return this.tx('readwrite', s => s.clear()); },
};
const thumbCache = new Map();
async function photoURL(key) {
  if (thumbCache.has(key)) return thumbCache.get(key);
  const blob = await photoDB.get(key).catch(() => null);
  const url = blob ? URL.createObjectURL(blob) : null;
  thumbCache.set(key, url);
  return url;
}
function dropThumb(key) {
  const u = thumbCache.get(key);
  if (u) URL.revokeObjectURL(u);
  thumbCache.delete(key);
}
// Reduce la foto para no llenar el teléfono
async function shrinkImage(file, maxSide = 1280, quality = 0.72, enhance = false) {
  const bmp = await createImageBitmap(file).catch(() => null);
  let img = bmp;
  if (!img) {
    img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i); i.onerror = rej;
      i.src = URL.createObjectURL(file);
    });
  }
  const w = img.width, h = img.height, k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  const ctx = c.getContext('2d');
  if (enhance) ctx.filter = 'grayscale(1) contrast(1.6) brightness(1.08)';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', quality));
}

/* =========================================================
   GOOGLE MAPS
   ========================================================= */
let mapsPromise = null;
function hasKey() { return !!(state.profile && state.profile.apiKey); }
function loadMaps() {
  if (window.google && google.maps && google.maps.Geocoder) return Promise.resolve(google.maps);
  if (!hasKey()) return Promise.reject(new Error('sin-clave'));
  if (mapsPromise) return mapsPromise;
  mapsPromise = new Promise((resolve, reject) => {
    window.__carteroxMapsReady = async () => {
      try {
        await Promise.all(['maps', 'geocoding', 'geometry', 'marker'].map(l => google.maps.importLibrary(l)));
      } catch (e) { /* las librerías ya vienen por parámetro */ }
      resolve(google.maps);
    };
    window.gm_authFailure = () => toast('Google rechazó la clave. Revisá que esté bien y que tenga las APIs habilitadas.', 5000);
    const key = encodeURIComponent(state.profile.apiKey.trim());
    loadScript(`https://maps.googleapis.com/maps/api/js?key=${key}&libraries=geometry,marker&language=es&region=AR&loading=async&callback=__carteroxMapsReady`)
      .catch(err => { mapsPromise = null; reject(err); });
  });
  return mapsPromise;
}

const geoCache = new Map();
async function geocode(address) {
  const city = state.profile.city || '';
  const q = city ? `${address}, ${city}, Argentina` : `${address}, Argentina`;
  if (geoCache.has(q)) return geoCache.get(q);
  await loadMaps();
  const g = new google.maps.Geocoder();
  let out = null;
  try {
    const req = { address: q, region: 'ar' };
    if (lastPos) req.bounds = new google.maps.Circle({ center: lastPos, radius: 30000 }).getBounds();
    const { results } = await g.geocode(req);
    if (results && results.length) {
      const r = results[0];
      out = {
        lat: r.geometry.location.lat(),
        lng: r.geometry.location.lng(),
        precise: r.types.some(t => ['street_address', 'premise', 'subpremise'].includes(t)),
        rooftop: r.geometry.location_type === 'ROOFTOP',
        formatted: r.formatted_address,
      };
    }
  } catch (e) { out = null; }
  geoCache.set(q, out);
  return out;
}

// Decodificador de polilíneas de Google
function decodePolyline(str) {
  let i = 0, lat = 0, lng = 0; const pts = [];
  while (i < str.length) {
    for (const which of [0, 1]) {
      let b, shift = 0, result = 0;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (which === 0) lat += d; else lng += d;
    }
    pts.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return pts;
}

// Tiempo de traslado entre puntos: Google Routes API y, si falla, distancia en línea recta
async function computeTravel(points) {
  points = points.filter(Boolean);
  const v = VEHICLES[state.profile.vehicle] || VEHICLES.pie;
  if (points.length < 2) return { secs: 0, meters: 0, source: 'none', path: [] };

  if (hasKey()) {
    try {
      let total = { secs: 0, meters: 0, path: [] };
      // Routes API admite hasta 25 paradas intermedias: se arma por tramos
      for (let i = 0; i < points.length - 1; i += 26) {
        const chunk = points.slice(i, i + 27);
        if (chunk.length < 2) break;
        let r = await routesRequest(chunk, v.routes);
        let factor = v.factor || 1;
        if (!r && v.routes === 'BICYCLE') { r = await routesRequest(chunk, 'WALK'); factor *= 0.33; /* bici ≈ 3x caminar */ }
        if (!r) throw new Error('sin ruta');
        total.secs += r.secs * factor;
        total.meters += r.meters;
        total.path.push(...r.path);
      }
      return { ...total, source: 'google' };
    } catch (e) { console.warn('Routes API:', e); }
  }
  let meters = 0;
  for (let i = 1; i < points.length; i++) meters += haversine(points[i - 1], points[i]) * 1.3;
  return { secs: meters / v.speed, meters, source: 'aprox', path: points };
}
async function routesRequest(pts, travelMode) {
  const ll = p => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  const body = {
    origin: ll(pts[0]),
    destination: ll(pts[pts.length - 1]),
    intermediates: pts.slice(1, -1).map(ll),
    travelMode,
    languageCode: 'es-419',
  };
  if (travelMode === 'DRIVE') body.routingPreference = 'TRAFFIC_UNAWARE';
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': state.profile.apiKey.trim(),
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const r = data.routes && data.routes[0];
  if (!r) return null;
  return {
    secs: parseFloat(String(r.duration || '0').replace('s', '')) || 0,
    meters: r.distanceMeters || 0,
    path: r.polyline && r.polyline.encodedPolyline ? decodePolyline(r.polyline.encodedPolyline) : [],
  };
}

function gmapsLink(dest) {
  const v = VEHICLES[state.profile.vehicle] || VEHICLES.pie;
  const d = typeof dest === 'string' ? dest : `${dest.lat},${dest.lng}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(d)}&travelmode=${v.gmaps}`;
}

/* =========================================================
   UBICACIÓN EN VIVO
   ========================================================= */
let watchId = null;
function startWatch() {
  if (!('geolocation' in navigator) || watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(p => {
    lastPos = { lat: p.coords.latitude, lng: p.coords.longitude };
    updateUserMarker();
  }, () => {}, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
}
function getPosition() {
  if (lastPos) return Promise.resolve(lastPos);
  return new Promise(res => {
    if (!('geolocation' in navigator)) return res(null);
    navigator.geolocation.getCurrentPosition(
      p => { lastPos = { lat: p.coords.latitude, lng: p.coords.longitude }; res(lastPos); },
      () => res(null), { enableHighAccuracy: true, timeout: 12000 });
  });
}

/* =========================================================
   BIENVENIDA
   ========================================================= */
const draft = {};
function showOnboarding() {
  $('#onboarding').hidden = false;
  $('#app').hidden = true;
  goStep(0);
}
function goStep(n) {
  $$('.ob-step').forEach(s => s.hidden = +s.dataset.step !== n);
  const input = $(`.ob-step[data-step="${n}"] input`);
  if (input) setTimeout(() => input.focus(), 50);
}
function initOnboarding() {
  $('[data-step="0"] [data-next]').onclick = () => {
    const v = $('#obName').value.trim();
    if (!v) return toast('Escribí tu nombre');
    draft.name = v; goStep(1);
  };
  $('#obName').onkeydown = e => { if (e.key === 'Enter') $('[data-step="0"] [data-next]').click(); };
  $$('#obVehicle .choice').forEach(b => b.onclick = () => { draft.vehicle = b.dataset.val; goStep(2); });
  $$('#obHand .choice').forEach(b => b.onclick = () => { draft.hand = b.dataset.val; goStep(3); });
  $('[data-step="3"] [data-next]').onclick = () => {
    const v = $('#obCity').value.trim();
    if (!v) return toast('Escribí tu localidad');
    draft.city = v; goStep(4);
  };
  $$('[data-finish]').forEach(b => b.onclick = () => {
    draft.apiKey = b.hasAttribute('data-skip') ? '' : $('#obKey').value.trim();
    state.profile = { ...draft, goal: 5000 };
    save();
    startApp();
  });
}

/* =========================================================
   NAVEGACIÓN ENTRE PESTAÑAS
   ========================================================= */
function showTab(name) {
  $$('.tab').forEach(t => t.hidden = t.id !== 'tab-' + name);
  $$('.bottomnav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  window.scrollTo(0, 0);
  if (name === 'mapa') renderMap();
  if (name === 'registro') renderRegistro();
  if (name === 'informe') renderInforme();
  if (name === 'ajustes') fillSettings();
}
function renderWho() {
  const p = state.profile, v = VEHICLES[p.vehicle] || VEHICLES.pie;
  $('#who').innerHTML = `Hola, <b>${esc(p.name)}</b><br>${v.icon} ${v.label} · ${p.hand === 'zurdo' ? 'Zurdo' : 'Derecho'}`;
}
function setMode(mode) {
  state.mode = mode; save();
  $$('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('#modeSimples').hidden = mode !== 'simples';
  $('#modeCerti').hidden = mode !== 'certi';
  if (mode === 'simples') renderStreets(); else renderCerti();
}

/* =========================================================
   CARTAS SIMPLES: CALLES Y LADOS
   ========================================================= */
function sideRange(st, side) {
  let a = Math.min(st.desde, st.hasta), b = Math.max(st.desde, st.hasta);
  const want = side === 'par' ? 0 : 1;
  const s = a % 2 === want ? a : a + 1;
  const e = b % 2 === want ? b : b - 1;
  if (s > e) return null;
  return { start: s, end: e, count: (e - s) / 2 + 1 };
}
const other = side => side === 'par' ? 'impar' : 'par';
// 2 a 3 segundos al azar por cada dirección del tramo
function randomStopSecs(count) {
  let t = 0;
  for (let i = 0; i < count; i++) t += 2 + Math.random();
  return Math.round(t);
}

// Detecta de qué lado quedan los pares al subir la numeración
function detectEvenSide(p) {
  const ok = x => x && x.precise;
  const mid = (a, b) => (ok(a) && ok(b)) ? { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 } : (ok(a) ? a : ok(b) ? b : null);
  const start = mid(p.parIni, p.imparIni), end = mid(p.parFin, p.imparFin);
  if (!start || !end) return { side: null, note: 'El mapa no encontró las alturas exactas de esta calle.' };
  const d = toXY(end, start), len = Math.hypot(d.x, d.y);
  if (len < 25) return { side: null, note: 'El tramo es muy corto para detectar el lado.' };
  let vote = 0;
  for (const [e, o] of [[p.parIni, p.imparIni], [p.parFin, p.imparFin]]) {
    if (!ok(e) || !ok(o)) continue;
    const ev = toXY(e, start), ov = toXY(o, start);
    const lateral = (d.x * (ev.y - ov.y) - d.y * (ev.x - ov.x)) / len; // >0: pares a la izquierda
    if (Math.abs(lateral) > 3) vote += Math.sign(lateral);
  }
  if (!vote) return { side: null, note: 'El mapa no distingue los lados en esta calle.' };
  return { side: vote > 0 ? 'izquierda' : 'derecha', note: `Según el mapa, subiendo la numeración los pares quedan a la ${vote > 0 ? 'izquierda' : 'derecha'}.` };
}
function suggestUpSide(evenSide) {
  const hand = state.profile.hand;
  const wantSide = hand === 'zurdo' ? 'izquierda' : 'derecha';
  if (!evenSide) return hand === 'zurdo' ? 'par' : 'impar';
  return evenSide === wantSide ? 'par' : 'impar';
}

function askSide(st, suggested) {
  const dlg = $('#dlgSide');
  const par = sideRange(st, 'par'), imp = sideRange(st, 'impar');
  const txt = (up) => {
    const u = sideRange(st, up), d = sideRange(st, other(up));
    const a = u ? `Subís por ${up} (${u.start} → ${u.end})` : `No hay ${up}es`;
    const b = d ? `bajás por ${other(up)} (${d.end} → ${d.start})` : `sin vuelta`;
    return `${a}, ${b}`;
  };
  $('#sideTitle').textContent = `¿Cómo subís ${st.calle}?`;
  $('#sideInfo').textContent = `${st.detectNote || ''} Como sos ${state.profile.hand}, te sugerimos subir por ${suggested}.`.trim();
  $('#optPar').textContent = (suggested === 'par' ? '⭐ ' : '') + txt('par');
  $('#optImpar').textContent = (suggested === 'impar' ? '⭐ ' : '') + txt('impar');
  $('#optPar').disabled = !par; $('#optImpar').disabled = !imp;
  return new Promise(res => {
    dlg.onclose = () => res(dlg.returnValue === 'par' || dlg.returnValue === 'impar' ? dlg.returnValue : null);
    dlg.returnValue = '';
    dlg.showModal();
  });
}

async function addStreet(calle, desde, hasta) {
  const st = { id: uid(), calle, desde, hasta, upSide: null, evenSide: null, detectNote: '', pts: {}, stopSecs: {}, done: false };
  ['par', 'impar'].forEach(s => { const r = sideRange(st, s); st.stopSecs[s] = r ? randomStopSecs(r.count) : 0; });

  if (hasKey()) {
    toast('Buscando la calle en el mapa…');
    try {
      const P = sideRange(st, 'par'), I = sideRange(st, 'impar');
      const [parIni, parFin, imparIni, imparFin] = await Promise.all([
        P ? geocode(`${calle} ${P.start}`) : null,
        P ? geocode(`${calle} ${P.end}`) : null,
        I ? geocode(`${calle} ${I.start}`) : null,
        I ? geocode(`${calle} ${I.end}`) : null,
      ]);
      st.pts = { parIni, parFin, imparIni, imparFin };
      const det = detectEvenSide(st.pts);
      st.evenSide = det.side; st.detectNote = det.note;
      if (!parIni && !imparIni) st.detectNote = 'No encontré esta calle en el mapa. Revisá el nombre o la localidad.';
    } catch (e) {
      st.detectNote = 'No se pudo consultar el mapa (sin conexión o clave inválida).';
    }
  } else {
    st.detectNote = 'Sin clave de Google Maps no se puede detectar el lado.';
  }

  const suggested = suggestUpSide(st.evenSide);
  const chosen = await askSide(st, suggested);
  if (!chosen) return;
  st.upSide = chosen;
  state.streets.push(st);
  save();
  renderStreets();
  recalcSimples();
}

function streetPoint(st, side, which) { // which: 'Ini' | 'Fin'
  return st.pts && st.pts[side + which] ? { lat: st.pts[side + which].lat, lng: st.pts[side + which].lng } : null;
}
function streetSequence(st) {
  const up = st.upSide, down = other(up);
  return [streetPoint(st, up, 'Ini'), streetPoint(st, up, 'Fin'), streetPoint(st, down, 'Fin'), streetPoint(st, down, 'Ini')].filter(Boolean);
}
function streetStartPoint(st) { return streetSequence(st)[0] || null; }
function streetStopSecs(st) { return (st.stopSecs.par || 0) + (st.stopSecs.impar || 0); }
function streetAddrCount(st) {
  return ['par', 'impar'].reduce((n, s) => n + ((sideRange(st, s) || {}).count || 0), 0);
}
// Largo aproximado de la cuadra si no hay mapa: ~110 m cada 100 números
function streetApproxMeters(st) { return Math.abs(st.hasta - st.desde) / 100 * 110 * 2; }

let recalcSeq = 0;
async function recalcSimples() {
  const seq = ++recalcSeq;
  const pending = state.streets.filter(s => !s.done);
  const pos = await getPosition();
  const pts = [];
  if (pos) pts.push(pos);
  pending.forEach(st => pts.push(...streetSequence(st)));
  let t = { secs: 0, meters: 0, source: 'none', path: [] };
  const anyPts = pending.some(st => streetSequence(st).length);
  if (anyPts) t = await computeTravel(pts);
  // Calles sin ubicar en el mapa: se estima por altura
  const v = VEHICLES[state.profile.vehicle] || VEHICLES.pie;
  pending.filter(st => !streetSequence(st).length).forEach(st => {
    const m = streetApproxMeters(st);
    t.meters += m; t.secs += m / v.speed;
    if (t.source === 'none') t.source = 'aprox';
  });
  if (seq !== recalcSeq) return;
  state.travel.simples = { secs: t.secs, meters: t.meters, source: t.source, path: compressPath(t.path) };
  save();
  renderSimplesSummary();
}
function compressPath(path) {
  if (!path || path.length < 400) return path || [];
  const step = Math.ceil(path.length / 400);
  return path.filter((_, i) => i % step === 0 || i === path.length - 1);
}

function renderSimplesSummary() {
  const pending = state.streets.filter(s => !s.done);
  const stops = pending.reduce((n, st) => n + streetStopSecs(st), 0);
  const addrs = pending.reduce((n, st) => n + streetAddrCount(st), 0);
  const tr = state.travel.simples || { secs: 0, meters: 0, source: 'none' };
  const total = stops + (tr.secs || 0);
  const end = new Date(Date.now() + total * 1000);
  const src = tr.source === 'google' ? 'Traslado calculado con Google Maps.' :
    tr.source === 'aprox' ? 'Traslado aproximado (sin mapa o sin conexión).' : '';
  $('#routeSummary').innerHTML = state.streets.length ? `
    <div class="muted" style="color:#d7def0">Tiempo estimado restante</div>
    <div class="big-time">${fmtDur(total)}</div>
    <div>Si salís ahora, terminás cerca de las <b>${fmtClock(end)}</b></div>
    <div class="grid">
      <div><b>${pending.length}/${state.streets.length}</b>calles</div>
      <div><b>${addrs.toLocaleString('es-AR')}</b>direcciones</div>
      <div><b>${fmtKm(tr.meters || 0)}</b>recorrido</div>
      <div><b>${fmtDur(stops)}</b>en paradas</div>
      <div><b>${fmtDur(tr.secs)}</b>traslado</div>
    </div>
    <p class="note">${src} Cada dirección suma 2 a 3 segundos.</p>` :
    `<div class="big-time" style="font-size:1.3rem">Agregá tu primera calle</div>
     <p class="note">Ej: Pueyrredón del 51 al 720. La app arma la ruta a medida que sumás calles.</p>`;
}

function renderStreets() {
  renderSimplesSummary();
  const ul = $('#streetList');
  ul.innerHTML = state.streets.map((st, i) => {
    const up = st.upSide, down = other(up);
    const U = sideRange(st, up), D = sideRange(st, down);
    const slot = (side, which, label) => `<button class="photo-slot" data-photo="${st.id}:${side}:${which}" data-label="${esc(st.calle)} · ${label}">📷<span>${label}</span></button>`;
    const leg = (dirIcon, verb, side, R, desc) => R ? `
      <div class="leg">
        <div class="leg-title"><span>${dirIcon} ${verb} por ${side}</span><span>${desc} · ${R.count} dir.</span></div>
        <div class="photos">
          ${slot(side, 'primera', `Primera carta (${side})`)}
          ${slot(side, 'ultima', `Última carta (${side})`)}
        </div>
      </div>` : '';
    const start = streetStartPoint(st);
    return `<li class="street" data-id="${st.id}" style="${st.done ? 'opacity:.6' : ''}">
      <div class="street-head">
        <div>
          <h3>${i + 1}. ${esc(st.calle)}</h3>
          <span class="badge">${st.desde} → ${st.hasta}</span>
          <span class="badge blue">~${fmtDur(streetStopSecs(st))} de paradas</span>
        </div>
        <button class="btn small" data-act="done">${st.done ? '↩️' : '✅'}</button>
      </div>
      <p class="detect">${esc(st.detectNote || '')}</p>
      <div class="legs">
        ${leg('⬆️', 'Subís', up, U, U ? `${U.start} → ${U.end}` : '')}
        ${leg('⬇️', 'Bajás', down, D, D ? `${D.end} → ${D.start}` : '')}
      </div>
      <div class="street-actions">
        <a class="btn" href="${gmapsLink(start || `${st.calle} ${U ? U.start : st.desde}, ${state.profile.city}`)}" target="_blank" rel="noopener">🧭 Ir</a>
        <button class="btn" data-act="flip">⇅ Lado</button>
        <button class="btn" data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn" data-act="down" ${i === state.streets.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn danger" data-act="del">🗑</button>
      </div>
    </li>`;
  }).join('');
  hydratePhotoSlots();
}
async function hydratePhotoSlots() {
  for (const b of $$('.photo-slot')) {
    const url = await photoURL(b.dataset.photo);
    if (url) {
      b.classList.add('done');
      b.innerHTML = `<img src="${url}" alt=""><span class="lbl">${esc(b.dataset.label.split(' · ')[1])}</span>`;
    }
  }
}

let pendingPhotoKey = null;
function onStreetListClick(e) {
  const slot = e.target.closest('.photo-slot');
  if (slot) {
    pendingPhotoKey = slot.dataset.photo;
    if (slot.classList.contains('done')) return openPhoto(slot.dataset.photo, slot.dataset.label);
    $('#simpleCam').value = '';
    return $('#simpleCam').click();
  }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const li = btn.closest('.street'), idx = state.streets.findIndex(s => s.id === li.dataset.id);
  const st = state.streets[idx];
  switch (btn.dataset.act) {
    case 'done': st.done = !st.done; break;
    case 'flip': st.upSide = other(st.upSide); break;
    case 'up': if (idx > 0) [state.streets[idx - 1], state.streets[idx]] = [state.streets[idx], state.streets[idx - 1]]; break;
    case 'down': if (idx < state.streets.length - 1) [state.streets[idx + 1], state.streets[idx]] = [state.streets[idx], state.streets[idx + 1]]; break;
    case 'del':
      if (!confirm(`¿Sacar ${st.calle} de la ruta?`)) return;
      state.streets.splice(idx, 1);
      ['par', 'impar'].forEach(s => ['primera', 'ultima'].forEach(w => { const k = `${st.id}:${s}:${w}`; photoDB.del(k).catch(() => {}); dropThumb(k); }));
      break;
  }
  save(); renderStreets(); recalcSimples();
}
async function onSimplePhoto(e) {
  const f = e.target.files && e.target.files[0];
  if (!f || !pendingPhotoKey) return;
  try {
    const blob = await shrinkImage(f);
    await photoDB.put(pendingPhotoKey, blob);
    dropThumb(pendingPhotoKey);
    toast('Foto guardada');
    renderStreets();
  } catch (err) { toast('No se pudo guardar la foto'); }
}
async function openPhoto(key, label) {
  const url = await photoURL(key);
  if (!url) return;
  $('#photoBig').src = url;
  $('#photoCaption').textContent = label;
  const dlg = $('#dlgPhoto');
  dlg.onclose = async () => {
    if (dlg.returnValue === 'del') {
      await photoDB.del(key).catch(() => {});
      dropThumb(key);
      renderStreets();
    }
  };
  dlg.returnValue = '';
  dlg.showModal();
}

// Vecino más cercano: arranca desde donde estás
function nearestOrder(items, getPt, from) {
  const withPt = items.filter(x => getPt(x)), without = items.filter(x => !getPt(x));
  const out = []; let cur = from;
  const left = [...withPt];
  if (!cur && left.length) cur = getPt(left[0]);
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((x, i) => { const d = haversine(cur, getPt(x)); if (d < bd) { bd = d; bi = i; } });
    const [x] = left.splice(bi, 1);
    out.push(x); cur = getPt(x);
  }
  return [...out, ...without];
}
async function sortStreets() {
  const pos = await getPosition();
  if (!pos) toast('Sin ubicación: ordeno entre calles nomás');
  const pending = state.streets.filter(s => !s.done), done = state.streets.filter(s => s.done);
  state.streets = [...nearestOrder(pending, streetStartPoint, pos), ...done];
  save(); renderStreets(); recalcSimples();
  toast('Ruta ordenada por cercanía');
}

/* =========================================================
   CERTIFICADAS / DOCUMENTOS / TELEGRAMAS
   ========================================================= */
const CERTI_SECS = 180;
let ocrWorker = null;
async function getOCR(onProgress) {
  if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
  if (!ocrWorker) {
    ocrWorker = await Tesseract.createWorker('spa', 1, {
      logger: m => { if (m.status === 'recognizing text' && onProgress) onProgress(m.progress); },
    });
  }
  return ocrWorker;
}
function titleCase(s) {
  return s.toLowerCase().replace(/(^|\s|\.)([a-záéíóúüñ])/g, (m, a, b) => a + b.toUpperCase());
}
function parseAddress(text) {
  let t = text.replace(/\r/g, '');
  const anchor = t.search(/destinatario|destino\s*:|para\s*:/i);
  if (anchor > -1) t = t.slice(anchor);
  const lines = t.split('\n')
    .map(l => l.replace(/[|_~«»"“”{}\[\]]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(l => l.length > 3);
  const bad = /\b(c\.?\s?p\.?|cod(igo)?\.?\s*postal|tel(efono)?|cel(ular)?|dni|cuit|cuil|remitente|kg|peso|fecha)\b/i;
  const kw = /\b(calle|av(da|enida)?\.?|bv\.?|boulevard|bulevar|pje\.?|pasaje|diag(onal)?\.?|ruta|domicilio|direcci[oó]n)\b/i;
  // Calle = todo lo que va antes del último número (así funciona «9 de Julio 881»)
  const re = /([A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9][A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9.'\s]{2,40}?)\s*(?:N[°ºo]?\.?\s*)?(\d{1,5})\s*$/;
  const cands = [];
  lines.forEach((l, i) => {
    if (bad.test(l)) return;
    const core = l.replace(/[,\s]*\b(piso|p\.|dpto|depto|dto|pb|of(ic(ina)?)?|torre|lote|mz|casa)\b.*$/i, '').replace(/[,\s]+\d{1,2}\s*[°º]\s*\w?\s*$/, '').replace(/[,.;:\s]+$/, '');
    if (!/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{3,}/.test(core)) return;
    const m = core.match(re);
    if (!m) return;
    const num = +m[2];
    if (!num || num > 20000) return;
    let score = 0;
    if (kw.test(l)) score += 3;
    if (/piso|dpto|depto|dto|º\s*[a-z]\b/i.test(l)) score += 1;
    if (m[1].trim().length >= 4) score += 1;
    if (i < 6) score += 1;
    cands.push({ street: m[1], num, score });
  });
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  const c = cands[0];
  const street = c.street.replace(/^(calle|domicilio|direcci[oó]n)\s*:?\s*/i, '').replace(/\s+n$/i, '').trim();
  if (street.length < 3) return null;
  return { dir: `${titleCase(street)} ${c.num}`, confident: c.score >= 3 };
}

async function onCertiPhoto(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const status = $('#ocrStatus');
  status.hidden = false;
  status.textContent = 'Leyendo la dirección… (la primera vez tarda un poco más)';
  try {
    const img = await shrinkImage(f, 1800, 0.9, true);
    const worker = await getOCR(p => { status.textContent = `Leyendo la dirección… ${Math.round(p * 100)}%`; });
    const { data } = await worker.recognize(img);
    const parsed = parseAddress(data.text || '');
    status.hidden = true;
    if (parsed) {
      await addCerti(parsed.dir, (data.text || '').slice(0, 160));
      toast(`Registrada: ${parsed.dir}${parsed.confident ? '' : ' (revisala)'}`, 3500);
    } else {
      openCertiDialog('', 'No pude leer una dirección clara. Escribila:');
    }
  } catch (err) {
    console.warn(err);
    status.textContent = 'No se pudo leer la foto. Probá con más luz o escribí la dirección.';
  }
}
function openCertiDialog(value, rawMsg, editId = null) {
  const dlg = $('#dlgCerti');
  $('#certiDir').value = value;
  $('#certiRaw').textContent = rawMsg || '';
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    const v = $('#certiDir').value.trim();
    if (!v) return;
    if (editId) {
      const c = state.certi.find(x => x.id === editId);
      if (c) { c.dir = v; const g = hasKey() ? await geocode(v).catch(() => null) : null; c.lat = g?.lat ?? null; c.lng = g?.lng ?? null; c.found = !!g; }
      save(); await sortCerti(true);
    } else {
      await addCerti(v, '');
    }
  };
  dlg.returnValue = '';
  dlg.showModal();
}
async function addCerti(dir, raw) {
  const c = { id: uid(), dir, raw, lat: null, lng: null, found: false, delivered: false, added: Date.now() };
  if (hasKey()) {
    const g = await geocode(dir).catch(() => null);
    if (g) { c.lat = g.lat; c.lng = g.lng; c.found = true; }
  }
  state.certi.push(c);
  save();
  await sortCerti(true);
}
const certiPt = c => (c.lat != null ? { lat: c.lat, lng: c.lng } : null);
async function sortCerti(silent) {
  const pos = await getPosition();
  const pending = state.certi.filter(c => !c.delivered), done = state.certi.filter(c => c.delivered);
  state.certi = [...nearestOrder(pending, certiPt, pos), ...done];
  save();
  renderCerti();
  recalcCerti();
  if (!silent) toast(pos ? 'Ordenadas desde tu ubicación' : 'Sin ubicación: ordené entre ellas');
}
async function recalcCerti() {
  const pending = state.certi.filter(c => !c.delivered);
  const pos = await getPosition();
  const pts = [pos, ...pending.map(certiPt)].filter(Boolean);
  const t = pts.length > 1 ? await computeTravel(pts) : { secs: 0, meters: 0, source: 'none', path: [] };
  state.travel.certi = { secs: t.secs, meters: t.meters, source: t.source, path: compressPath(t.path) };
  save();
  renderCertiSummary();
}
function renderCertiSummary() {
  const pending = state.certi.filter(c => !c.delivered);
  const tr = state.travel.certi || { secs: 0, meters: 0, source: 'none' };
  const stops = pending.length * CERTI_SECS, total = stops + (tr.secs || 0);
  const end = new Date(Date.now() + total * 1000);
  $('#certiSummary').innerHTML = state.certi.length ? `
    <div class="muted" style="color:#d7def0">Tiempo estimado restante</div>
    <div class="big-time">${fmtDur(total)}</div>
    <div>Si salís ahora, terminás cerca de las <b>${fmtClock(end)}</b></div>
    <div class="grid">
      <div><b>${pending.length}</b>por entregar</div>
      <div><b>${state.certi.length - pending.length}</b>entregadas</div>
      <div><b>${fmtKm(tr.meters || 0)}</b>recorrido</div>
    </div>
    <p class="note">Cada dirección suma 3 minutos. ${tr.source === 'google' ? 'Traslado calculado con Google Maps.' : tr.source === 'aprox' ? 'Traslado aproximado.' : ''}</p>` :
    `<div class="big-time" style="font-size:1.3rem">Escaneá tu primera carta</div>`;
}
function renderCerti() {
  renderCertiSummary();
  let n = 0;
  $('#certiList').innerHTML = state.certi.map(c => {
    const pos = lastPos && c.lat != null ? fmtKm(haversine(lastPos, certiPt(c))) + ' de vos' : '';
    return `<li class="certi ${c.delivered ? 'delivered' : ''}" data-id="${c.id}">
      <div class="num">${c.delivered ? '✓' : ++n}</div>
      <div>
        <div class="addr">${esc(c.dir)}</div>
        <div class="meta">${c.found ? pos : (hasKey() ? '⚠️ No ubicada en el mapa' : 'Sin mapa')}</div>
      </div>
      <div class="ops">
        <a class="btn" href="${gmapsLink(c.found ? certiPt(c) : `${c.dir}, ${state.profile.city}`)}" target="_blank" rel="noopener">🧭 Ir</a>
        <button class="btn" data-act="ok">${c.delivered ? '↩️' : '✅'}</button>
        <button class="btn" data-act="edit">✏️</button>
        <button class="btn danger" data-act="del">🗑</button>
      </div>
    </li>`;
  }).join('');
}
function onCertiListClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.certi').dataset.id;
  const idx = state.certi.findIndex(c => c.id === id), c = state.certi[idx];
  if (btn.dataset.act === 'ok') { c.delivered = !c.delivered; save(); sortCerti(true); }
  if (btn.dataset.act === 'edit') openCertiDialog(c.dir, 'Corregí la dirección:', c.id);
  if (btn.dataset.act === 'del' && confirm(`¿Borrar ${c.dir}?`)) { state.certi.splice(idx, 1); save(); renderCerti(); recalcCerti(); }
}

async function newDay() {
  if (!confirm('¿Vaciar la ruta de hoy (calles, fotos y certificadas)? El registro y los informes no se borran.')) return;
  state.streets = []; state.certi = []; state.travel = { simples: null, certi: null };
  save();
  await photoDB.clear().catch(() => {});
  thumbCache.forEach(u => u && URL.revokeObjectURL(u)); thumbCache.clear();
  renderStreets(); renderCerti();
  toast('Ruta vacía. ¡Buena jornada!');
}

/* =========================================================
   MAPA
   ========================================================= */
let map = null, mapOverlays = [], userMarker = null, follow = false;
async function renderMap() {
  renderNextStop();
  if (!hasKey()) { $('#mapEmpty').hidden = false; return; }
  $('#mapEmpty').hidden = true;
  try { await loadMaps(); } catch (e) { $('#mapEmpty').hidden = false; $('#mapEmpty').innerHTML = '<p>No se pudo cargar Google Maps. Revisá la conexión y la clave.</p>'; return; }
  if (!map) {
    map = new google.maps.Map($('#map'), {
      center: lastPos || { lat: -34.6037, lng: -58.3816 }, zoom: 15,
      mapTypeControl: false, streetViewControl: false, fullscreenControl: false, clickableIcons: false,
    });
    map.addListener('dragstart', () => { follow = false; $('#btnFollow').classList.remove('primary'); });
  }
  drawRoute();
  updateUserMarker();
}
function drawRoute() {
  if (!map) return;
  mapOverlays.forEach(o => o.setMap(null)); mapOverlays = [];
  const bounds = new google.maps.LatLngBounds();
  const addMarker = (pos, label, color, title) => {
    const m = new google.maps.Marker({
      position: pos, map, title,
      label: { text: String(label), color: '#fff', fontWeight: '700', fontSize: '12px' },
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 13, fillColor: color, fillOpacity: 1, strokeColor: '#FFC72C', strokeWeight: 3 },
    });
    mapOverlays.push(m); bounds.extend(pos);
  };
  let path = [];
  if (state.mode === 'simples') {
    let n = 0;
    state.streets.filter(s => !s.done).forEach(st => {
      n++;
      const s = streetStartPoint(st);
      if (s) addMarker(s, n, '#102A5C', `${n}. ${st.calle}`);
      streetSequence(st).slice(1).forEach(p => bounds.extend(p));
    });
    path = (state.travel.simples && state.travel.simples.path) || [];
  } else {
    let n = 0;
    state.certi.filter(c => !c.delivered).forEach(c => { n++; if (c.found) addMarker(certiPt(c), n, '#1F4C9A', c.dir); });
    path = (state.travel.certi && state.travel.certi.path) || [];
  }
  if (path.length > 1) {
    const line = new google.maps.Polyline({ path, map, strokeColor: '#102A5C', strokeOpacity: 0.85, strokeWeight: 5 });
    mapOverlays.push(line);
    path.forEach(p => bounds.extend(p));
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, 40);
  map.__bounds = bounds;
}
function updateUserMarker() {
  if (!map || !lastPos || !window.google) return;
  if (!userMarker) {
    userMarker = new google.maps.Marker({
      map, position: lastPos, title: 'Vos', zIndex: 999,
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: '#2D7FF9', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 },
    });
  } else userMarker.setPosition(lastPos);
  if (follow) map.panTo(lastPos);
}
function renderNextStop() {
  const box = $('#nextStop');
  if (state.mode === 'simples') {
    const st = state.streets.find(s => !s.done);
    if (!st) { box.innerHTML = '<h3>Sin calles pendientes</h3><p class="muted">Agregá calles en la pestaña Ruta.</p>'; return; }
    const U = sideRange(st, st.upSide);
    box.innerHTML = `<h3>Próxima: ${esc(st.calle)}</h3>
      <p>Subís por ${st.upSide}${U ? ` desde el ${U.start}` : ''}, bajás por ${other(st.upSide)}.</p>
      <a class="btn primary" style="width:100%" target="_blank" rel="noopener" href="${gmapsLink(streetStartPoint(st) || `${st.calle} ${U ? U.start : st.desde}, ${state.profile.city}`)}">🧭 Abrir en Google Maps</a>`;
  } else {
    const c = state.certi.find(x => !x.delivered);
    if (!c) { box.innerHTML = '<h3>Sin certificadas pendientes</h3>'; return; }
    box.innerHTML = `<h3>Próxima: ${esc(c.dir)}</h3>
      <a class="btn primary" style="width:100%" target="_blank" rel="noopener" href="${gmapsLink(c.found ? certiPt(c) : `${c.dir}, ${state.profile.city}`)}">🧭 Abrir en Google Maps</a>`;
  }
}

/* =========================================================
   REGISTRO MANUAL
   ========================================================= */
const TIME_FIELDS = [
  ['entrada', 'Entrada al correo'],
  ['refriIni', 'Refrigerio (inicio)'],
  ['refriFin', 'Refrigerio (fin)'],
  ['salidaReparto', 'Salida a repartir'],
  ['vueltaReparto', 'Vuelta del reparto'],
  ['salidaCorreo', 'Salida del correo'],
];
function regFor(date) { return state.registros[date] || (state.registros[date] = {}); }
function minutesOf(hhmm) { if (!hhmm) return null; const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function spanMin(a, b) { const x = minutesOf(a), y = minutesOf(b); if (x == null || y == null) return null; return y >= x ? y - x : y + 1440 - x; }
function dayStats(r) {
  const n = k => Math.max(0, +r[k] || 0);
  const refri = spanMin(r.refriIni, r.refriFin) || 0;
  const jornada = spanMin(r.entrada, r.salidaCorreo);
  return {
    simplesSacadas: n('simplesSacadas'), simplesRepartidas: n('simplesRepartidas'),
    simplesNo: Math.max(0, n('simplesSacadas') - n('simplesRepartidas')),
    certiSacadas: n('certiSacadas'), certiRepartidas: n('certiRepartidas'),
    certiNo: Math.max(0, n('certiSacadas') - n('certiRepartidas')),
    jornadaMin: jornada == null ? null : Math.max(0, jornada - refri),
    calleMin: spanMin(r.salidaReparto, r.vueltaReparto),
  };
}
const fmtMin = m => m == null ? '—' : `${Math.floor(m / 60)} h ${pad(m % 60)}`;
function renderRegistro() {
  const dateInput = $('#regDate');
  if (!dateInput.value) dateInput.value = todayISO();
  const r = regFor(dateInput.value);
  $('#regTimes').innerHTML = TIME_FIELDS.map(([k, label]) => `
    <div class="time-row">
      <span>${label}</span>
      <input type="time" data-time="${k}" value="${esc(r[k] || '')}">
      <button class="btn" data-now="${k}">Ahora</button>
    </div>`).join('');
  $$('[data-reg]').forEach(i => i.value = r[i.dataset.reg] ?? '');
  updateRegCalcs();
}
function updateRegCalcs() {
  const r = regFor($('#regDate').value), s = dayStats(r);
  $('[data-calc="simplesNo"]').textContent = s.simplesNo;
  $('[data-calc="certiNo"]').textContent = s.certiNo;
  $('#regTimeKpis').innerHTML = `
    <div class="kpi"><b>${fmtMin(s.jornadaMin)}</b><span>Jornada (sin refrigerio)</span></div>
    <div class="kpi"><b>${fmtMin(s.calleMin)}</b><span>En la calle repartiendo</span></div>`;
}
function onRegInput(e) {
  const date = $('#regDate').value || todayISO();
  const r = regFor(date);
  if (e.target.dataset.time) r[e.target.dataset.time] = e.target.value;
  if (e.target.dataset.reg) r[e.target.dataset.reg] = e.target.value === '' ? '' : Math.max(0, parseInt(e.target.value, 10) || 0);
  save(); updateRegCalcs();
}
function onRegClick(e) {
  const k = e.target.dataset.now;
  if (!k) return;
  const r = regFor($('#regDate').value || todayISO());
  r[k] = fmtClock(new Date());
  save(); renderRegistro();
}

/* =========================================================
   INFORME SEMANAL
   ========================================================= */
const DAY_NAMES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
function weekDays(offset) {
  const d = new Date(); d.setHours(12, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // lunes = 0
  d.setDate(d.getDate() - dow + offset * 7);
  return Array.from({ length: 7 }, (_, i) => { const x = new Date(d); x.setDate(d.getDate() + i); return x; });
}
function weekData(offset) {
  const days = weekDays(offset);
  const rows = days.map(d => ({ date: d, iso: isoDate(d), has: Object.values(state.registros[isoDate(d)] || {}).some(v => v !== '' && v != null), ...dayStats(state.registros[isoDate(d)] || {}) }));
  const sum = k => rows.reduce((n, r) => n + (r[k] || 0), 0);
  const goal = +state.profile.goal || 5000;
  const worked = rows.filter(r => r.simplesRepartidas > 0 || r.simplesSacadas > 0 || r.certiSacadas > 0);
  return {
    days, rows, goal, worked,
    simplesSacadas: sum('simplesSacadas'), simplesRepartidas: sum('simplesRepartidas'), simplesNo: sum('simplesNo'),
    certiSacadas: sum('certiSacadas'), certiRepartidas: sum('certiRepartidas'), certiNo: sum('certiNo'),
    jornadaMin: sum('jornadaMin'), calleMin: sum('calleMin'),
  };
}
function renderInforme() {
  const w = weekData(weekOffset);
  const f = d => `${d.getDate()}/${d.getMonth() + 1}`;
  $('#wkLabel').innerHTML = `Semana ${f(w.days[0])} al ${f(w.days[6])}${weekOffset === 0 ? '<br><span class="muted small">esta semana</span>' : ''}`;
  $('#wkNext').disabled = weekOffset >= 0;

  const pct = Math.min(100, Math.round(w.simplesRepartidas / w.goal * 100));
  const falta = Math.max(0, w.goal - w.simplesRepartidas);
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const daysLeft = weekOffset === 0 ? w.days.filter(d => d >= today && d.getDay() !== 0).length : 0;
  const perDay = daysLeft ? Math.ceil(falta / daysLeft) : 0;
  const avg = w.worked.length ? Math.round(w.simplesRepartidas / w.worked.length) : 0;
  $('#weekGoal').innerHTML = `
    <h3>Meta semanal de simples</h3>
    <div class="goal-num">${w.simplesRepartidas.toLocaleString('es-AR')} <small>/ ${w.goal.toLocaleString('es-AR')} repartidas</small></div>
    <div class="bar ${pct >= 100 ? 'done' : ''}"><div style="width:${pct}%"></div></div>
    <p>${pct >= 100 ? '🎉 ¡Meta cumplida!' : `Faltan <b>${falta.toLocaleString('es-AR')}</b> cartas (${pct}%).`}
    ${pct < 100 && daysLeft ? ` Necesitás unas <b>${perDay.toLocaleString('es-AR')}</b> por día en los ${daysLeft} días que quedan.` : ''}</p>
    <p class="muted small">Promedio por día trabajado: ${avg.toLocaleString('es-AR')} · Sacadas: ${w.simplesSacadas.toLocaleString('es-AR')} · Sin repartir: ${w.simplesNo.toLocaleString('es-AR')}</p>`;

  $('#weekTable').innerHTML = `
    <h3>Día por día</h3>
    <table>
      <thead><tr><th>Día</th><th>Simples</th><th>Sin rep.</th><th>Certi</th><th>Jornada</th></tr></thead>
      <tbody>${w.rows.map(r => `<tr>
        <td>${DAY_NAMES[(r.date.getDay() + 6) % 7]} ${f(r.date)}</td>
        <td>${r.has ? r.simplesRepartidas : '—'}</td>
        <td>${r.has ? r.simplesNo : '—'}</td>
        <td>${r.has ? `${r.certiRepartidas}/${r.certiSacadas}` : '—'}</td>
        <td>${r.has ? fmtMin(r.jornadaMin) : '—'}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Total</td><td>${w.simplesRepartidas}</td><td>${w.simplesNo}</td><td>${w.certiRepartidas}/${w.certiSacadas}</td><td>${fmtMin(w.jornadaMin)}</td></tr></tfoot>
    </table>`;

  $('#weekCerti').innerHTML = `
    <h3>Certi / Documento / Telegrama</h3>
    <div class="kpis">
      <div class="kpi"><b>${w.certiSacadas}</b><span>Sacadas</span></div>
      <div class="kpi"><b>${w.certiRepartidas}</b><span>Repartidas</span></div>
      <div class="kpi"><b>${w.certiNo}</b><span>Sin repartir</span></div>
      <div class="kpi"><b>${fmtMin(w.calleMin)}</b><span>Horas en la calle</span></div>
    </div>`;
}
async function shareWeek() {
  const w = weekData(weekOffset), f = d => `${d.getDate()}/${d.getMonth() + 1}`;
  const text = [
    `El Carterox — Informe de ${state.profile.name}`,
    `Semana ${f(w.days[0])} al ${f(w.days[6])}`,
    ``,
    `Simples repartidas: ${w.simplesRepartidas} de ${w.goal} (${Math.round(w.simplesRepartidas / w.goal * 100)}%)`,
    `Simples sacadas: ${w.simplesSacadas} · Sin repartir: ${w.simplesNo}`,
    `Certi/Doc/Telegrama: ${w.certiRepartidas} repartidas de ${w.certiSacadas} · Sin repartir: ${w.certiNo}`,
    `Jornada total: ${fmtMin(w.jornadaMin)} · En la calle: ${fmtMin(w.calleMin)}`,
  ].join('\n');
  try {
    if (navigator.share) await navigator.share({ title: 'Informe semanal', text });
    else { await navigator.clipboard.writeText(text); toast('Informe copiado'); }
  } catch (e) { /* cancelado */ }
}

/* =========================================================
   AJUSTES Y COPIA DE SEGURIDAD
   ========================================================= */
function fillSettings() {
  const f = $('#settingsForm'), p = state.profile;
  f.name.value = p.name || ''; f.vehicle.value = p.vehicle || 'pie'; f.hand.value = p.hand || 'derecho';
  f.city.value = p.city || ''; f.goal.value = p.goal || 5000; f.apiKey.value = p.apiKey || '';
}
function saveSettings(e) {
  e.preventDefault();
  const f = e.target, p = state.profile;
  const keyChanged = (p.apiKey || '') !== f.apiKey.value.trim();
  Object.assign(p, {
    name: f.name.value.trim() || p.name, vehicle: f.vehicle.value, hand: f.hand.value,
    city: f.city.value.trim(), goal: Math.max(1, parseInt(f.goal.value, 10) || 5000), apiKey: f.apiKey.value.trim(),
  });
  save(); renderWho();
  if (keyChanged) { toast('Clave guardada. Recargando…'); setTimeout(() => location.reload(), 800); }
  else { toast('Guardado'); recalcSimples(); recalcCerti(); }
}
function exportData() {
  const blob = new Blob([JSON.stringify({ app: 'carterox', v: 1, exported: new Date().toISOString(), state }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `carterox-${todayISO()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function importData(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'carterox' || !data.state) throw new Error();
    if (!confirm('¿Reemplazar los datos de este teléfono con la copia?')) return;
    state = Object.assign(structuredClone(DEFAULT_STATE), data.state);
    save(); location.reload();
  } catch (err) { toast('Ese archivo no es una copia de El Carterox'); }
}

/* =========================================================
   ARRANQUE
   ========================================================= */
function startApp() {
  $('#onboarding').hidden = true;
  $('#app').hidden = false;
  renderWho();
  setMode(state.mode || 'simples');
  startWatch();
  if (hasKey()) loadMaps().catch(() => {});
}

function bind() {
  $$('.bottomnav button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  $$('.seg-btn').forEach(b => b.onclick = () => setMode(b.dataset.mode));

  $('#streetForm').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, calle = f.calle.value.trim();
    const desde = parseInt(f.desde.value, 10), hasta = parseInt(f.hasta.value, 10);
    if (!calle || !desde || !hasta) return toast('Completá calle, desde y hasta');
    const btn = f.querySelector('button'); btn.disabled = true;
    try { await addStreet(calle, desde, hasta); f.reset(); f.calle.focus(); }
    finally { btn.disabled = false; }
  };
  $('#streetList').onclick = onStreetListClick;
  $('#simpleCam').onchange = onSimplePhoto;
  $('#btnSortStreets').onclick = sortStreets;
  $('#btnRecalc').onclick = () => { state.mode === 'simples' ? recalcSimples() : recalcCerti(); toast('Recalculando…'); };

  $('#certiCam').onchange = onCertiPhoto;
  $('#certiManual').onsubmit = async e => {
    e.preventDefault();
    const v = e.target.dir.value.trim();
    if (!v) return;
    e.target.reset();
    await addCerti(v, '');
    toast(`Registrada: ${v}`);
  };
  $('#certiList').onclick = onCertiListClick;
  $('#btnSortCerti').onclick = () => sortCerti(false);
  $('#btnNewDay').onclick = newDay;

  $('#btnFollow').onclick = () => {
    follow = !follow; $('#btnFollow').classList.toggle('primary', follow);
    if (follow && lastPos && map) { map.panTo(lastPos); map.setZoom(17); }
    if (follow && !lastPos) toast('Esperando tu ubicación…');
  };
  $('#btnFit').onclick = () => { follow = false; $('#btnFollow').classList.remove('primary'); if (map && map.__bounds && !map.__bounds.isEmpty()) map.fitBounds(map.__bounds, 40); };

  $('#regDate').onchange = renderRegistro;
  $('#tab-registro').addEventListener('input', onRegInput);
  $('#tab-registro').addEventListener('click', onRegClick);

  $('#wkPrev').onclick = () => { weekOffset--; renderInforme(); };
  $('#wkNext').onclick = () => { if (weekOffset < 0) { weekOffset++; renderInforme(); } };
  $('#btnShareWeek').onclick = shareWeek;

  $('#settingsForm').onsubmit = saveSettings;
  $('#btnExport').onclick = exportData;
  $('#importFile').onchange = importData;
}

document.addEventListener('DOMContentLoaded', () => {
  bind();
  initOnboarding();
  if (state.profile && state.profile.name) startApp(); else showOnboarding();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
