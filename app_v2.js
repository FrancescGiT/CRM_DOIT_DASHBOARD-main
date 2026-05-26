//
'use strict';
const STORAGE_KEY = 'doit_crm_jira_2022_2026_patches_v3';
let seedData = null;
let data = null;
let patches = {
  clients: {}, centers: {}, epics: {}, activities: {},
  added_clients: {}, added_centers: {},
  deleted_centers: {}, deleted_clients: {}, deleted_epics: {}
};
let idx = {};
let selectedClientId = '';
let selectedCenterId = '';
let selectedEpicKey = '';
let selectedProductId = '';
let currentMetric = 'epics';
let currentPage = 'overview';
let lastNonSearchPage = 'overview';
let storageAvailable = true;
let epicsSortKey = 'key';
let epicsSortAsc = true;
let productDetailSortKey = 'client';
let productDetailSortAsc = true;
let topClientsMetric = 'epics';
let clientComsSortKey = 'fecha';
let clientComsSortAsc = true;

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
function esc(s) { return String(s ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
function norm(s) { return String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function downloadText(filename, text, mime) { const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 700); }
function getStorage() { try { localStorage.setItem('__test', '1'); localStorage.removeItem('__test'); return localStorage; } catch (e) { storageAvailable = false; return null; } }
const storage = getStorage();

let noticeTimeout = null;
function showNotice(msg, ok) {
  const n = document.getElementById('storageNotice');
  n.textContent = msg;
  n.className = 'notice ' + (ok ? 'ok' : '');
  n.style.display = 'block';
  if (noticeTimeout) clearTimeout(noticeTimeout);
  if (ok) {
    noticeTimeout = setTimeout(() => {
      n.style.display = 'none';
    }, 3000);
  }
}

function loadPatches() {
  if (!storage) return;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw) {
      patches = JSON.parse(raw);
      patches.activities = patches.activities || {};
      patches.deleted_epics = patches.deleted_epics || {};
    }
  } catch (e) {
    console.warn('No se pudieron leer cambios locales', e);
  }
}

function persistPatches() {
  if (!storage) {
    showNotice('El navegador no permite localStorage. Exporta JSON antes de cerrar.', false);
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(patches));
    showNotice('Cambios guardados automáticamente en el navegador.', true);
  } catch (e) {
    showNotice('Límite del navegador superado. Exporta JSON ya.', false);
    console.error(e);
  }
}

function mergeObj(target, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      target[k] = target[k] || {};
      mergeObj(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

function applyPatches() {
  data = deepClone(seedData);
  data.clients = data.clients || [];
  data.centers = data.centers || [];
  data.epics = data.epics || [];
  data.activities = data.activities || [];

  // Delete clients
  if (patches.deleted_clients) {
    data.clients = data.clients.filter(x => !patches.deleted_clients[x.id]);
  }
  // Delete centers
  if (patches.deleted_centers) {
    data.centers = data.centers.filter(x => !patches.deleted_centers[x.id]);
  }
  // Delete epics
  if (patches.deleted_epics) {
    data.epics = data.epics.filter(x => !patches.deleted_epics[x.key]);
  }

  // Add clients
  for (const c of Object.values(patches.added_clients || {})) {
    if (!data.clients.some(x => x.id === c.id)) data.clients.push(c);
  }
  // Add centers
  for (const c of Object.values(patches.added_centers || {})) {
    if (!data.centers.some(x => x.id === c.id)) data.centers.push(c);
  }

  // Apply edits
  for (const c of data.clients) { if (patches.clients && patches.clients[c.id]) mergeObj(c, patches.clients[c.id]); }
  for (const c of data.centers) { if (patches.centers && patches.centers[c.id]) mergeObj(c, patches.centers[c.id]); }
  for (const e of data.epics) { if (patches.epics && patches.epics[e.key]) mergeObj(e, patches.epics[e.key]); }

  // Apply activity patches
  if (patches.activities) {
    for (const a of data.activities) {
      if (patches.activities[a.key]) mergeObj(a, patches.activities[a.key]);
    }
  }

  // Map 'Distribuidor / canal comercial' to 'Distribuidor'
  for (const c of data.clients) {
    if (c.type === 'Distribuidor / canal comercial') c.type = 'Distribuidor';
  }
  for (const c of Object.values(patches.added_clients || {})) {
    if (c.type === 'Distribuidor / canal comercial') c.type = 'Distribuidor';
  }
}

function buildIndexes() {
  idx.clientsById = Object.fromEntries((data.clients || []).map(c => [c.id, c]));
  idx.centersById = Object.fromEntries((data.centers || []).map(c => [c.id, c]));
  idx.epicsByKey = Object.fromEntries((data.epics || []).map(e => [e.key, e]));

  // Recompute client stats based on current data and edits
  for (const c of data.clients || []) {
    c.stats = { epics: 0, epics_finalizados: 0, epics_activos: 0, productos: 0, servicios: 0 };
  }
  for (const e of data.epics || []) {
    const cl = idx.clientsById[e.client_id];
    if (cl) {
      cl.stats.epics++;
      if (e.status_group === 'Activa') cl.stats.epics_activos++;
      else if (e.status_group === 'Finalizada') cl.stats.epics_finalizados++;
    }
  }

  idx.activitiesByEpic = {};

  // Initialize product sales from our new products database grouped by reference
  idx.productSales = {};
  let productsDb = [];
  const prodEl = document.getElementById('products-data');
  if (prodEl) {
    try {
      productsDb = JSON.parse(prodEl.textContent);
    } catch (e) {
      console.error('Error parsing products-data', e);
    }
  }

  // Gather known references and mapping from productsDb
  const nameToRef = new Map();
  const refToNames = new Map(); // reference -> Array of { name, occurrences }
  const knownRefs = new Set();
  
  for (const p of productsDb) {
    const name = (p.name || '').trim();
    const ref = (p.reference || '').trim().toUpperCase();
    if (ref) {
      knownRefs.add(ref);
      if (name) {
        nameToRef.set(name.toLowerCase(), ref);
        if (!refToNames.has(ref)) refToNames.set(ref, []);
        refToNames.get(ref).push({ name, occurrences: p.occurrences || 0 });
      }
    }
  }

  // Helper to detect reference code from name, summary or explicit reference
  function detectReference(name, summary, explicitRef) {
    let r = (explicitRef || '').trim().toUpperCase();
    if (r) return r;
    
    const n = (name || '').trim();
    const s = (summary || '').trim();
    
    if (n && nameToRef.has(n.toLowerCase())) return nameToRef.get(n.toLowerCase());
    if (s && nameToRef.has(s.toLowerCase())) return nameToRef.get(s.toLowerCase());
    
    const combined = (n + ' ' + s).toUpperCase();
    const tokens = combined.split(/[^A-Z0-9-]/);
    for (const t of tokens) {
      if (t && knownRefs.has(t)) {
        return t;
      }
    }
    
    const sortedRefs = Array.from(knownRefs).sort((a, b) => b.length - a.length);
    for (const kr of sortedRefs) {
      if (kr.length >= 3 && combined.includes(kr)) {
        return kr;
      }
    }
    return '';
  }

  // Pre-initialize idx.productSales for references, picking the name with most occurrences
  for (const [ref, nameList] of refToNames.entries()) {
    nameList.sort((a, b) => b.occurrences - a.occurrences || b.name.length - a.name.length);
    idx.productSales[ref] = {
      reference: ref,
      name: nameList[0].name,
      years: {},
      details: []
    };
  }

  // Also pre-initialize for products in productsDb that have no reference
  for (const p of productsDb) {
    const name = (p.name || '').trim();
    const ref = (p.reference || '').trim().toUpperCase();
    if (!ref && name) {
      if (!idx.productSales[name]) {
        idx.productSales[name] = {
          reference: '',
          name: name,
          years: {},
          details: []
        };
      }
    }
  }

  for (const a of data.activities || []) {
    const k = a.root_epic_key || a.parent_key || '';
    if (!idx.activitiesByEpic[k]) idx.activitiesByEpic[k] = [];
    idx.activitiesByEpic[k].push(a);

    // Index product stats
    if (a.line_kind === 'Producto' && (a.product_name || a.reference)) {
      const prodName = (a.product_name || '').trim();
      const refCode = detectReference(prodName, a.summary, a.reference);
      const ref = refCode || prodName;
      
      if (!ref) continue;
      
      if (!idx.productSales[ref]) {
        idx.productSales[ref] = {
          reference: refCode || '',
          name: prodName,
          years: {},
          details: []
        };
      } else {
        if (!idx.productSales[ref].name && prodName) {
          idx.productSales[ref].name = prodName;
        }
      }

      const epic = idx.epicsByKey[k] || {};
      const year = epic.created_year || a.created_year || (a.created_date || a.created ? new Date(a.created_date || a.created).getFullYear() : 'Desconocido');
      const qty = parseInt(a.quantity || 1) || 1;

      idx.productSales[ref].years[year] = (idx.productSales[ref].years[year] || 0) + qty;
      idx.productSales[ref].details.push({
        epic_key: k,
        com: epic.com || '',
        client_id: a.client_id,
        center_id: a.center_id,
        quantity: qty,
        date: a.created_date || a.created || '',
        status: a.status || '',
        line_description: prodName
      });

      // Update client stats
      const cl = idx.clientsById[a.client_id];
      if (cl) {
        cl.stats.productos += qty;
      }
    } else if (a.line_kind === 'Servicio') {
      const qty = parseInt(a.quantity || 1) || 1;
      const cl = idx.clientsById[a.client_id];
      if (cl) {
        cl.stats.servicios += qty;
      }
    }
  }

  idx.types = [...new Set((data.clients || []).map(c => c.type).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  idx.years = [...new Set((data.epics || []).map(e => e.created_year).filter(Boolean))].sort();
}

function prepareExportData() {
  const out = deepClone(data);
  const clients = Object.fromEntries(out.clients.map(c => [c.id, c]));
  const centers = Object.fromEntries(out.centers.map(c => [c.id, c]));
  for (const ctr of out.centers) { const cl = clients[ctr.client_id]; if (cl) ctr.client_name = cl.name; }
  for (const e of out.epics) { const cl = clients[e.client_id]; const ctr = centers[e.center_id]; if (cl) e.client_name = cl.name; if (ctr) e.center_name = ctr.name; }
  for (const a of out.activities || []) { const cl = clients[a.client_id]; const ctr = centers[a.center_id]; if (cl) a.client_name = cl.name; if (ctr) a.center_name = ctr.name; }
  out.metadata = out.metadata || {};
  out.metadata.exported_at = new Date().toISOString();
  out.metadata.export_note = 'Exportado desde dashboard autónomo Pro con parches aplicados.';
  return out;
}

function switchPage(pageId) {
  if (pageId !== 'search-results') {
    lastNonSearchPage = pageId;
  }
  currentPage = pageId;
  document.querySelectorAll('.page-section').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  const targetPage = document.getElementById(`page-${pageId}`);
  if (targetPage) targetPage.classList.add('active');
  const btn = document.querySelector(`.nav-btn[data-page="${pageId}"]`);
  if (btn) btn.classList.add('active');

  let titleText = 'Dashboard';
  if (pageId === 'overview') titleText = 'Cuadro de mando';
  else if (pageId === 'search-results') titleText = 'Resultados de búsqueda';
  else if (btn) titleText = btn.textContent.replace(/[^\w\s\/\-áéíóúÁÉÍÓÚ]/g, '').trim();
  document.getElementById('topbarTitle').textContent = titleText;
}

function refreshAll() {
  buildIndexes();
  fillFiltersOnce();

  // Update filter banner
  updateFilterBanner();
  
  // Update topbar filter indicators
  updateFilterIndicator();

  // Navigation badges
  document.getElementById('navClientsCount').textContent = (data.clients || []).length;
  document.getElementById('navEpicsCount').textContent = (data.epics || []).length;
  document.getElementById('navProductsCount').textContent = Object.keys(idx.productSales).length;

  renderStats();
  renderEvolution();
  renderTopClients();
  renderTypeDistribution();
  renderClients();
  renderClientPanel();
  renderCenters();
  renderEpics();
  renderEpicDetail();
  renderAllEpics();
  renderProductAnalytics();
  renderSearchResults();
}

function updateFilterBanner() {
  const f = filterContext();
  const banner = document.getElementById('activeFiltersBanner');
  const isFiltered = f.q || f.type || f.status || f.year || f.center;
  if (isFiltered) {
    banner.style.display = 'flex';
    const resetBtn = document.getElementById('showAllBtn');
    resetBtn.style.background = 'var(--amber-bg)';
    resetBtn.style.color = 'var(--amber)';
    resetBtn.style.borderColor = 'rgba(245, 158, 11, 0.4)';
  } else {
    banner.style.display = 'none';
    const resetBtn = document.getElementById('showAllBtn');
    resetBtn.style.background = '';
    resetBtn.style.color = '';
    resetBtn.style.borderColor = '';
  }
}

function updateFilterIndicator() {
  const container = document.getElementById('topbarFilterIndicator');
  if (!container) return;
  
  container.innerHTML = '';
  const activePills = [];
  
  // 1. Search Query
  const searchInput = document.getElementById('searchInput');
  if (searchInput && searchInput.value.trim()) {
    const q = searchInput.value.trim();
    activePills.push(`<div class="filter-pill">
      <span>🔍 Búsqueda: "${esc(q)}"</span>
      <span class="filter-pill-close" onclick="clearSearchFilter()">&times;</span>
    </div>`);
  }

  // 2. Client
  if (selectedClientId) {
    const c = idx.clientsById[selectedClientId];
    if (c) {
      activePills.push(`<div class="filter-pill">
        <span>👥 Cliente: ${esc(c.name)}</span>
        <span class="filter-pill-close" onclick="clearClientFilter()">&times;</span>
      </div>`);
    }
  }
  
  // 3. Center
  if (selectedCenterId) {
    const ct = idx.centersById[selectedCenterId];
    if (ct) {
      activePills.push(`<div class="filter-pill">
        <span>📍 Sede: ${esc(ct.name)}</span>
        <span class="filter-pill-close" onclick="clearCenterFilter()">&times;</span>
      </div>`);
    }
  }
  
  // 4. Epic
  if (selectedEpicKey) {
    activePills.push(`<div class="filter-pill">
      <span>📋 Pedido: ${esc(selectedEpicKey)}</span>
      <span class="filter-pill-close" onclick="clearEpicFilter()">&times;</span>
    </div>`);
  }
  
  // 5. Product
  if (selectedProductId) {
    const p = idx.productSales[selectedProductId];
    const display = p ? p.name : selectedProductId;
    activePills.push(`<div class="filter-pill">
      <span>📦 Prod: ${esc(display)}</span>
      <span class="filter-pill-close" onclick="clearProductFilter()">&times;</span>
    </div>`);
  }

  // 6. Type Filter
  const typeF = document.getElementById('typeFilter')?.value;
  if (typeF) {
    activePills.push(`<div class="filter-pill">
      <span>🏷️ Tipo: ${esc(typeF)}</span>
      <span class="filter-pill-close" onclick="clearFilterDropdown('typeFilter')">&times;</span>
    </div>`);
  }

  // 7. Status Filter
  const statusF = document.getElementById('statusFilter')?.value;
  if (statusF) {
    activePills.push(`<div class="filter-pill">
      <span>⚡ Estado: ${esc(statusF)}</span>
      <span class="filter-pill-close" onclick="clearFilterDropdown('statusFilter')">&times;</span>
    </div>`);
  }

  // 8. Year Filter
  const yearF = document.getElementById('yearFilter')?.value;
  if (yearF) {
    activePills.push(`<div class="filter-pill">
      <span>📅 Año: ${esc(yearF)}</span>
      <span class="filter-pill-close" onclick="clearFilterDropdown('yearFilter')">&times;</span>
    </div>`);
  }

  // 9. Center Filter
  const centerF = document.getElementById('centerFilter')?.value;
  if (centerF) {
    const ct = idx.centersById[centerF];
    const name = ct ? ct.name : centerF;
    activePills.push(`<div class="filter-pill">
      <span>🏢 Sede: ${esc(name)}</span>
      <span class="filter-pill-close" onclick="clearFilterDropdown('centerFilter')">&times;</span>
    </div>`);
  }
  
  if (activePills.length > 0) {
    container.innerHTML = activePills.join('');
    container.style.display = 'flex';
  } else {
    container.style.display = 'none';
  }
}

function clearSearchFilter() {
  const searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.value = '';
  if (currentPage === 'search-results') {
    switchPage(lastNonSearchPage || 'overview');
  }
  refreshAll();
}

function clearClientFilter() {
  selectedClientId = '';
  selectedCenterId = '';
  selectedEpicKey = '';
  refreshAll();
}

function clearCenterFilter() {
  selectedCenterId = '';
  refreshAll();
}

function clearEpicFilter() {
  selectedEpicKey = '';
  refreshAll();
}

function clearProductFilter() {
  selectedProductId = '';
  const prodSearchInput = document.getElementById('productSearchInput');
  if (prodSearchInput) prodSearchInput.value = '';
  refreshAll();
}

function clearFilterDropdown(id) {
  const el = document.getElementById(id);
  if (el) el.value = '';
  refreshAll();
}

// Bind to window to ensure global click availability
window.clearSearchFilter = clearSearchFilter;
window.clearClientFilter = clearClientFilter;
window.clearCenterFilter = clearCenterFilter;
window.clearEpicFilter = clearEpicFilter;
window.clearProductFilter = clearProductFilter;
window.clearFilterDropdown = clearFilterDropdown;

function fillFiltersOnce() {
  const typeSel = document.getElementById('typeFilter'); if (typeSel.dataset.done !== '1') { for (const t of idx.types) { const o = document.createElement('option'); o.value = t; o.textContent = t; typeSel.appendChild(o); } typeSel.dataset.done = '1'; }
  const yearSel = document.getElementById('yearFilter'); if (yearSel.dataset.done !== '1') { for (const y of idx.years) { const o = document.createElement('option'); o.value = y; o.textContent = y; yearSel.appendChild(o); } yearSel.dataset.done = '1'; }
  const centerSel = document.getElementById('centerFilter'); const old = centerSel.value; centerSel.innerHTML = '<option value="">Todos</option>'; const centers = (data.centers || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'es')); for (const c of centers) { const o = document.createElement('option'); o.value = c.id; o.textContent = (idx.clientsById[c.client_id]?.name || c.client_name || '') + ' · ' + c.name; centerSel.appendChild(o); } centerSel.value = old;
}

function filterContext() { return { q: norm(document.getElementById('searchInput').value), type: document.getElementById('typeFilter').value, status: document.getElementById('statusFilter').value, year: document.getElementById('yearFilter').value, center: document.getElementById('centerFilter').value }; }

function highlight(text, q) {
  text = String(text ?? '');
  if (!q) return esc(text);
  const escapedText = esc(text);
  const escapedQ = esc(q);
  const regex = new RegExp(`(${escapedQ.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')})`, 'gi');
  return escapedText.replace(regex, '<mark class="search-match">$1</mark>');
}

function epicMatches(e, f) {
  const client = idx.clientsById[e.client_id] || {};
  const center = idx.centersById[e.center_id] || {};
  if (selectedClientId && e.client_id !== selectedClientId) return false;
  if (selectedCenterId && e.center_id !== selectedCenterId) return false;
  if (f.center && e.center_id !== f.center) return false;
  if (f.type && client.type !== f.type) return false;
  if (f.status && e.status_group !== f.status) return false;
  if (f.year && String(e.created_year) !== String(f.year)) return false;
  if (f.q) {
    const acts = idx.activitiesByEpic[e.key] || [];
    const text = [client.name, client.type, center.name, e.key, e.com, e.summary, e.status, e.created, e.description, ...(acts.slice(0, 80).map(a => [a.key, a.summary, a.product_name, a.reference, a.category].join(' ')))].join(' ');
    if (!norm(text).includes(f.q)) return false;
  }
  return true;
}

function getFilteredEpics() {
  const f = filterContext();
  return (data.epics || []).filter(e => epicMatches(e, f)).sort((a, b) => {
    const ca = (idx.clientsById[a.client_id]?.name || a.client_name || '');
    const cb = (idx.clientsById[b.client_id]?.name || b.client_name || '');
    return ca.localeCompare(cb, 'es') || String(a.created || '').localeCompare(String(b.created || '')) || String(a.key).localeCompare(String(b.key));
  });
}

function renderStats() {
  const epics = getFilteredEpics();
  const clientIds = new Set(epics.map(e => e.client_id));
  const centerIds = new Set(epics.map(e => e.center_id).filter(Boolean));
  let products = 0, services = 0, active = 0;
  for (const e of epics) {
    if (e.status_group === 'Activa') active++;
    const acts = idx.activitiesByEpic[e.key] || [];
    for (const a of acts) {
      if (a.line_kind === 'Producto') products += parseInt(a.quantity || 1) || 1;
      else if (a.line_kind === 'Servicio') services += parseInt(a.quantity || 1) || 1;
    }
  }

  // Count active clients only (where active !== false)
  const activeClientCount = Array.from(clientIds).filter(cid => idx.clientsById[cid]?.active !== false).length;

  document.getElementById('stats').innerHTML = [
    ['Clientes Activos', activeClientCount, 'clients'],
    ['Centros/Sedes', centerIds.size, 'centers'],
    ['Pedidos / COM', epics.length, 'epics'],
    ['En Curso', active, 'en-curso'],
    ['Productos', products, 'products'],
    ['Servicios', services, 'services']
  ].map(([l, n, go]) => `<div class="stat-card clickable" data-stat-go="${go}"><div class="stat-value">${n}</div><div class="stat-label">${l}</div></div>`).join('');

  document.querySelectorAll('[data-stat-go]').forEach(el => {
    el.onclick = () => {
      const go = el.dataset.statGo;
      if (go === 'clients' || go === 'centers') {
        switchPage('clients');
      } else if (go === 'epics') {
        switchPage('epics');
      } else if (go === 'en-curso') {
        document.getElementById('statusFilter').value = 'Activa';
        switchPage('epics');
      } else if (go === 'products') {
        switchPage('products');
      } else if (go === 'services') {
        switchPage('epics');
      }
      refreshAll();
    };
  });
}

function clientMatches(c, f) {
  if (f.type && c.type !== f.type) return false;
  if (selectedClientId && c.id !== selectedClientId) return true;
  const epics = (data.epics || []).filter(e => e.client_id === c.id);
  if (f.status || f.year || f.center || f.q) {
    return epics.some(e => epicMatches(e, f));
  }
  return true;
}

function renderClients() {
  const f = filterContext();
  const clients = (data.clients || []).filter(c => clientMatches(c, f)).sort((a, b) => (b.stats?.epics || 0) - (a.stats?.epics || 0) || a.name.localeCompare(b.name, 'es'));
  document.getElementById('clientList').innerHTML = clients.map(c => {
    const st = c.stats || {};
    const isActive = c.active !== false;
    return `<div class="client-card ${c.id === selectedClientId ? 'active' : ''} ${!isActive ? 'client-inactive' : ''}" data-client="${esc(c.id)}">
      <div class="client-name">${esc(c.name)} ${!isActive ? '<span class="tag tag-default" style="font-size:9px;padding:1px 5px;margin-left:5px;">Inactivo</span>' : ''}</div>
      <div class="client-meta">
        <span class="tag tag-blue">${esc(c.type || 'Sin tipo')}</span>
        <span class="tag tag-default">${st.epics || 0} Pedidos</span>
        <span class="tag tag-green">${st.epics_finalizados || 0} fin.</span>
        <span class="tag ${(st.epics_activos || 0) > 0 ? 'tag-red' : 'tag-default'}">${st.epics_activos || 0} act.</span>
      </div>
    </div>`;
  }).join('') || '<div class="empty">Sin clientes.</div>';
  document.querySelectorAll('[data-client]').forEach(el => el.addEventListener('click', () => { selectedClientId = el.dataset.client; selectedCenterId = ''; selectedEpicKey = ''; refreshAll(); }));
}

function renderClientPanel() {
  const panel = document.getElementById('clientPanel');
  const title = document.getElementById('clientPanelTitle');
  if (!selectedClientId) {
    title.textContent = 'Ficha de cliente';
    panel.innerHTML = '<div class="empty">Selecciona un cliente para ver y editar su ficha.</div>';
    return;
  }
  const c = idx.clientsById[selectedClientId];
  if (!c) { panel.innerHTML = '<div class="empty">Cliente no encontrado.</div>'; return; }
  title.textContent = 'Ficha de cliente · ' + c.name;
  const contact = c.contact || {};
  const custom = c.custom || {};
  const types = ['', ...idx.types];
  if (c.type && !types.includes(c.type)) types.push(c.type);

  panel.innerHTML = `<div class="contact-grid">
    <div class="field"><label>Nombre cliente CRM</label><input id="cl_name" value="${esc(c.name)}"></div>
    <div class="field"><label>Tipo cliente</label><select id="cl_type">${types.map(o => `<option value="${esc(o)}" ${o === c.type ? 'selected' : ''}>${esc(o || '-- No asignado --')}</option>`).join('')}</select></div>
    <div class="field" style="display:flex; align-items:center; gap:8px; height:100%; padding-top:14px;">
      <input type="checkbox" id="cl_active" ${c.active !== false ? 'checked' : ''} style="width:auto; cursor:pointer; margin:0;">
      <label for="cl_active" style="margin:0; cursor:pointer; user-select:none; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--text3);">Cliente Activo</label>
    </div>
    <div class="field"><label>Persona contacto</label><input id="cl_contact" value="${esc(contact.contact_name || '')}"></div>
    <div class="field"><label>Email</label><input id="cl_email" value="${esc(contact.email || '')}"></div>
    <div class="field"><label>Teléfono</label><input id="cl_phone" value="${esc(contact.phone || '')}"></div>
    <div class="field"><label>Móvil</label><input id="cl_mobile" value="${esc(contact.mobile || '')}"></div>
    <div class="field"><label>Ciudad</label><input id="cl_city" value="${esc(contact.city || '')}"></div>
    <div class="field"><label>País</label><input id="cl_country" value="${esc(contact.country || '')}"></div>
    <div class="field wide"><label>Dirección</label><textarea id="cl_address">${esc(contact.address || '')}</textarea></div>
    <div class="field wide"><label>Web</label><input id="cl_website" value="${esc(contact.website || '')}"></div>
    <div class="field wide"><label>Notas contacto</label><textarea id="cl_notes">${esc(contact.notes || '')}</textarea></div>
    <div class="field wide"><label>Notas internas CRM</label><textarea id="cl_internal_notes">${esc(custom.notes || '')}</textarea></div>
  </div>
  <div class="save-strip">
    <div class="mini muted">Origen datos: ${esc(contact.source || 'Sin datos explícitos')}</div>
    <div>
      <button class="btn btn-danger btn-sm" id="deleteClientBtn">Eliminar Cliente</button>
      <button class="btn btn-primary" id="saveClientBtn">Guardar Ficha</button>
    </div>
  </div>`;

  document.getElementById('saveClientBtn').onclick = saveClientForm;
  document.getElementById('deleteClientBtn').onclick = () => {
    if (confirm(`¿Estás seguro de eliminar el cliente ${c.name}? Se perderán todas sus sedes vinculadas.`)) {
      patches.deleted_clients = patches.deleted_clients || {};
      patches.deleted_clients[c.id] = true;
      selectedClientId = '';
      selectedCenterId = '';
      applyPatches();
      persistPatches();
      refreshAll();
    }
  };
}

function saveClientForm() {
  const c = idx.clientsById[selectedClientId]; if (!c) return;
  const patch = {
    name: document.getElementById('cl_name').value.trim() || c.name,
    type: document.getElementById('cl_type').value,
    active: document.getElementById('cl_active').checked,
    contact: {
      contact_name: document.getElementById('cl_contact').value,
      email: document.getElementById('cl_email').value,
      phone: document.getElementById('cl_phone').value,
      mobile: document.getElementById('cl_mobile').value,
      city: document.getElementById('cl_city').value,
      country: document.getElementById('cl_country').value,
      address: document.getElementById('cl_address').value,
      website: document.getElementById('cl_website').value,
      notes: document.getElementById('cl_notes').value,
      source: (c.contact || {}).source || 'Editado manualmente'
    },
    custom: {
      owner: (c.custom || {}).owner || '',
      notes: document.getElementById('cl_internal_notes').value
    }
  };
  patches.clients[selectedClientId] = patches.clients[selectedClientId] || {};
  mergeObj(patches.clients[selectedClientId], patch);
  applyPatches();
  persistPatches();
  refreshAll();
}

function renderEvolution() {
  const title = document.getElementById('evolutionTitle');
  let rows;
  if (selectedClientId) {
    const c = idx.clientsById[selectedClientId];
    title.textContent = 'Evolución · ' + (c?.name || selectedClientId);
    rows = (data.evolution_by_client || []).filter(r => r.client_id === selectedClientId);
  } else {
    title.textContent = 'Evolución global';
    rows = data.evolution_global || [];
  }
  rows = [...rows].sort((a, b) => a.year - b.year);
  const max = Math.max(1, ...rows.map(r => Number(r[currentMetric] || 0)));
  document.getElementById('evolutionChart').innerHTML = rows.length ? `
    <div class="bar-chart">${rows.map(r => {
    const val = Number(r[currentMetric] || 0);
    const h = Math.max(2, Math.round(val / max * 140));
    return `<div class="bar-col">
        <div class="bar" style="height:${h}px"><span class="value">${val}</span></div>
        <div class="bar-label">${esc(r.year)}</div>
      </div>`;
  }).join('')}</div>` : '<div class="empty">No hay datos para esta selección.</div>';
}

function renderTopClients() {
  const metricSelect = document.getElementById('topClientsMetricSelect');
  if (metricSelect) {
    topClientsMetric = metricSelect.value;
  }

  const clientStats = {};
  for (const c of data.clients || []) {
    clientStats[c.id] = { epics: 0, productos: 0 };
  }
  const filteredEpics = getFilteredEpics();
  for (const e of filteredEpics) {
    const clStat = clientStats[e.client_id];
    if (clStat) {
      clStat.epics++;
      const acts = idx.activitiesByEpic[e.key] || [];
      for (const a of acts) {
        if (a.line_kind === 'Producto') {
          clStat.productos += (parseInt(a.quantity || 1) || 1);
        }
      }
    }
  }

  const clients = (data.clients || [])
    .map(c => ({ c, stats: clientStats[c.id] }))
    .filter(item => topClientsMetric === 'epics' ? item.stats.epics > 0 : item.stats.productos > 0)
    .sort((a, b) => {
      const valA = topClientsMetric === 'epics' ? a.stats.epics : a.stats.productos;
      const valB = topClientsMetric === 'epics' ? b.stats.epics : b.stats.productos;
      return valB - valA || a.c.name.localeCompare(b.c.name, 'es');
    })
    .slice(0, 5)
    .map(item => ({ ...item.c, dynamicStats: item.stats }));

  const max = Math.max(1, ...clients.map(c => topClientsMetric === 'epics' ? (c.dynamicStats?.epics || 0) : (c.dynamicStats?.productos || 0)));
  const metricLabel = topClientsMetric === 'epics' ? 'Pedidos' : 'Productos';

  document.getElementById('topClientsChart').innerHTML = clients.length ? `
    <div style="display:flex;flex-direction:column;gap:12px">
      ${clients.map(c => {
    const val = topClientsMetric === 'epics' ? (c.dynamicStats?.epics || 0) : (c.dynamicStats?.productos || 0);
    const pct = Math.round(val / max * 100);
    return `<div class="clickable" data-top-client-go="${esc(c.id)}">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;font-weight:600">
            <span>${esc(c.name)}</span>
            <span class="muted">${val} ${metricLabel}</span>
          </div>
          <div style="background:var(--surface2);height:8px;border-radius:4px;overflow:hidden">
            <div style="background:var(--accent);width:${pct}%;height:100%;border-radius:4px"></div>
          </div>
        </div>`;
  }).join('')}
    </div>` : '<div class="empty">No hay datos para esta selección.</div>';

  document.querySelectorAll('[data-top-client-go]').forEach(el => {
    el.onclick = () => {
      selectedClientId = el.dataset.topClientGo;
      selectedCenterId = '';
      selectedEpicKey = '';
      switchPage('clients');
      refreshAll();
    };
  });
}

function renderTypeDistribution() {
  const counts = {};
  const filteredEpics = getFilteredEpics();
  const activeClientIds = new Set(filteredEpics.map(e => e.client_id));

  const f = filterContext();
  const isFiltered = f.q || f.type || f.status || f.year || f.center;
  const clientList = isFiltered
    ? (data.clients || []).filter(c => activeClientIds.has(c.id))
    : (data.clients || []);

  for (const c of clientList) {
    const t = c.type || 'Sin tipo';
    counts[t] = (counts[t] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...sorted.map(x => x[1]));

  document.getElementById('typeDistribution').innerHTML = sorted.length ? `
    <div class="grid-2">
      ${sorted.map(([type, val]) => {
    const pct = Math.round(val / max * 100);
    return `<div style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
            <span style="font-weight:600">${esc(type)}</span>
            <span class="muted">${val} clientes</span>
          </div>
          <div style="background:var(--surface2);height:6px;border-radius:3px;overflow:hidden">
            <div style="background:var(--cyan);width:${pct}%;height:100%;border-radius:3px"></div>
          </div>
        </div>`;
  }).join('')}
    </div>` : '<div class="empty">No hay datos para esta selección.</div>';
}

function renderCenters() {
  const panel = document.getElementById('centersPanel');
  if (!selectedClientId) {
    panel.innerHTML = '<div class="empty">Selecciona un cliente para ver sus centros/sedes.</div>';
    return;
  }

  const centers = (data.centers || []).filter(c => c.client_id === selectedClientId).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const clientEpics = (data.epics || []).filter(e => e.client_id === selectedClientId);

  // Map epics by center
  const epicsByCenter = {};
  for (const c of centers) {
    epicsByCenter[c.id] = [];
  }
  for (const e of clientEpics) {
    let cid = e.center_id;
    if (!cid || !epicsByCenter[cid]) {
      if (centers.length > 0) cid = centers[0].id;
    }
    if (cid && epicsByCenter[cid]) {
      epicsByCenter[cid].push(e);
    }
  }

  // Sort epics in each center
  for (const cid in epicsByCenter) {
    epicsByCenter[cid].sort((a, b) => {
      let valA, valB;
      if (clientComsSortKey === 'com') {
        valA = a.com || '';
        valB = b.com || '';
      } else if (clientComsSortKey === 'epic') {
        valA = a.key || '';
        valB = b.key || '';
      } else if (clientComsSortKey === 'fecha') {
        valA = a.created || '';
        valB = b.created || '';
      } else if (clientComsSortKey === 'estado') {
        valA = a.status_group || '';
        valB = b.status_group || '';
      }

      const res = String(valA).localeCompare(String(valB), 'es', { numeric: true });
      return clientComsSortAsc ? res : -res;
    });
  }

  let html = centers.map(c => {
    const st = c.stats || {};
    const epicsList = epicsByCenter[c.id] || [];
    const sortIndicator = (key) => {
      if (clientComsSortKey !== key) return '↕';
      return clientComsSortAsc ? '▲' : '▼';
    };

    let tableHtml = '';
    if (epicsList.length > 0) {
      tableHtml = `
        <table class="center-coms-table">
          <thead>
            <tr>
              <th onclick="event.stopPropagation(); sortClientComs('com')">COM ${sortIndicator('com')}</th>
              <th onclick="event.stopPropagation(); sortClientComs('epic')">DOIT ${sortIndicator('epic')}</th>
              <th onclick="event.stopPropagation(); sortClientComs('fecha')">Fecha ${sortIndicator('fecha')}</th>
              <th onclick="event.stopPropagation(); sortClientComs('estado')">Estado ${sortIndicator('estado')}</th>
            </tr>
          </thead>
          <tbody>
            ${epicsList.map(e => {
        const acts = idx.activitiesByEpic[e.key] || [];
        const isSelected = selectedEpicKey === e.key;
        const productRows = acts.map(a => `
                <div class="nested-product-item">
                  <span>${esc(a.product_name || a.summary || '')}</span>
                  <span class="mono muted" style="font-size:10px">${esc(a.reference || '--')}</span>
                  <span class="tag tag-default">${esc(a.quantity || 1)} ud.</span>
                  <button class="btn btn-sm" style="padding:2px 6px; font-size:9px" onclick="event.stopPropagation(); openEditLineModal('${esc(a.key)}')">Editar</button>
                </div>
              `).join('');

        return `
                <tr class="com-row ${isSelected ? 'selected-row' : ''}" 
                    draggable="true" 
                    ondragstart="dragEpic(event, '${esc(e.key)}')"
                    onclick="event.stopPropagation(); selectEpicFromCenter('${esc(e.key)}')">
                  <td class="mono"><b>${esc(e.com || 'SIN COM')}</b></td>
                  <td class="mono">${esc(e.key)}</td>
                  <td>${esc(e.created ? e.created.split(' ')[0] : '--')}</td>
                  <td><span class="${e.status_group === 'Finalizada' ? 'status-finalizada' : 'status-activa'}">${esc(e.status_group || e.status || '')}</span></td>
                </tr>
                <tr id="com-detail-${esc(e.key)}" class="com-products-row" style="display: ${isSelected ? 'table-row' : 'none'}">
                  <td colspan="4">
                    <div class="nested-products-list">
                      <div style="font-weight:700; font-size:10px; text-transform:uppercase; color:var(--text3); margin-bottom:4px">Productos de la Comanda:</div>
                      ${productRows || '<div class="empty" style="padding:8px">Sin productos en este pedido.</div>'}
                    </div>
                  </td>
                </tr>
              `;
      }).join('')}
          </tbody>
        </table>
      `;
    } else {
      tableHtml = `<div class="empty" style="padding:10px; font-size:11px">Sin pedidos asociados.</div>`;
    }

    return `<div class="center-card ${c.id === selectedCenterId ? 'active' : ''}" 
                 data-center="${esc(c.id)}"
                 ondragover="allowDropEpic(event, this)"
                 ondragleave="leaveDropEpic(event, this)"
                 ondrop="dropEpic(event, '${esc(c.id)}', this)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <b>${esc(c.name)}</b>
        <button class="btn btn-sm" style="padding:2px 6px; font-size:10px" onclick="event.stopPropagation(); selectCenterForEditing('${esc(c.id)}')">✏️ Editar</button>
      </div>
      <div class="client-meta" style="margin-bottom:8px">
        <span class="tag tag-cyan">${esc(c.kind || 'Centro')}</span>
        <span class="tag tag-default">${epicsList.length} Pedidos</span>
      </div>
      ${tableHtml}
    </div>`;
  }).join('') || '<div class="empty">Sin centros detectados.</div>';

  if (selectedCenterId) {
    const c = idx.centersById[selectedCenterId];
    if (c) {
      const contact = c.contact || {};
      const kinds = ['Centro', 'Sede', 'Distribuidor', 'Residencia', 'Colegio', 'Clínica', 'Otro'];
      if (c.kind && !kinds.includes(c.kind)) kinds.push(c.kind);

      html += `<hr style="margin:16px 0;border:0;border-top:1px solid var(--border)">
      <div class="panel-header"><h3 style="font-size:13px">Editar Sede: ${esc(c.name)}</h3></div>
      <div class="contact-grid" style="grid-template-columns:1fr;margin-top:10px">
        <div class="field"><label>Nombre centro</label><input id="ct_name" value="${esc(c.name)}"></div>
        <div class="field"><label>Clasificación</label><select id="ct_kind">${kinds.map(k => `<option value="${esc(k)}" ${k === c.kind ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></div>
        <div class="field"><label>Contacto centro</label><input id="ct_contact" value="${esc(contact.contact_name || '')}"></div>
        <div class="field"><label>Email centro</label><input id="ct_email" value="${esc(contact.email || '')}"></div>
        <div class="field"><label>Teléfono centro</label><input id="ct_phone" value="${esc(contact.phone || '')}"></div>
        <div class="field"><label>Dirección centro</label><textarea id="ct_address">${esc(contact.address || '')}</textarea></div>
        <div class="field"><label>Notas centro</label><textarea id="ct_notes">${esc(contact.notes || '')}</textarea></div>
      </div>
      <div class="save-strip">
        <button class="btn btn-danger btn-sm" id="deleteCenterBtn">Eliminar Sede</button>
        <button class="btn btn-primary" id="saveCenterBtn">Guardar Sede</button>
      </div>`;
    }
  }
  panel.innerHTML = html;

  const save = document.getElementById('saveCenterBtn');
  if (save) save.onclick = saveCenterForm;

  const delBtn = document.getElementById('deleteCenterBtn');
  if (delBtn) delBtn.onclick = deleteCenterForm;
}

function selectCenterForEditing(centerId) {
  selectedCenterId = selectedCenterId === centerId ? '' : centerId;
  refreshAll();
}

function saveCenterForm() {
  const c = idx.centersById[selectedCenterId]; if (!c) return;
  const patch = {
    name: document.getElementById('ct_name').value.trim() || c.name,
    kind: document.getElementById('ct_kind').value,
    contact: {
      ...(c.contact || {}),
      contact_name: document.getElementById('ct_contact').value,
      email: document.getElementById('ct_email').value,
      phone: document.getElementById('ct_phone').value,
      address: document.getElementById('ct_address').value,
      notes: document.getElementById('ct_notes').value
    }
  };
  patches.centers[selectedCenterId] = patches.centers[selectedCenterId] || {};
  mergeObj(patches.centers[selectedCenterId], patch);
  applyPatches();
  persistPatches();
  refreshAll();
}

function deleteCenterForm() {
  const centerId = selectedCenterId;
  if (!centerId) return;

  const epics = (data.epics || []).filter(e => e.center_id === centerId);

  if (epics.length === 0) {
    if (confirm('¿Seguro que deseas eliminar esta sede?')) {
      performDeleteCenter(centerId);
    }
    return;
  }

  const overlay = document.getElementById('deleteCenterModalOverlay');
  const select = document.getElementById('deleteCenterTargetSelect');
  const text = document.getElementById('deleteCenterModalText');

  text.innerHTML = `La sede <b>${esc(idx.centersById[centerId]?.name || centerId)}</b> tiene <b>${epics.length}</b> pedidos asociados. ¿Qué deseas hacer con ellos?`;

  const otherCenters = (data.centers || []).filter(c => c.client_id === selectedClientId && c.id !== centerId);
  const moveContainer = document.getElementById('deleteCenterMoveContainer');
  const moveBtn = document.getElementById('deleteCenterMoveBtn');

  if (otherCenters.length > 0) {
    select.innerHTML = otherCenters.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    moveContainer.style.display = 'flex';
    moveBtn.style.display = 'inline-flex';
  } else {
    select.innerHTML = '';
    moveContainer.style.display = 'none';
    moveBtn.style.display = 'none';
  }

  overlay.classList.add('active');

  document.getElementById('deleteCenterConfirmBtn').onclick = () => {
    patches.deleted_centers = patches.deleted_centers || {};
    patches.deleted_centers[centerId] = true;

    patches.deleted_epics = patches.deleted_epics || {};
    for (const e of epics) {
      patches.deleted_epics[e.key] = true;
    }

    if (patches.added_centers && patches.added_centers[centerId]) {
      delete patches.added_centers[centerId];
    }
    if (patches.centers && patches.centers[centerId]) {
      delete patches.centers[centerId];
    }

    selectedCenterId = '';
    selectedEpicKey = '';
    closeDeleteCenterModal();
    applyPatches();
    persistPatches();
    refreshAll();
    showNotice('Sede y pedidos asociados eliminados.');
  };

  moveBtn.onclick = () => {
    const targetId = select.value;
    if (!targetId) return;

    for (const e of epics) {
      patches.epics[e.key] = patches.epics[e.key] || {};
      patches.epics[e.key].center_id = targetId;
    }

    patches.deleted_centers = patches.deleted_centers || {};
    patches.deleted_centers[centerId] = true;

    if (patches.added_centers && patches.added_centers[centerId]) {
      delete patches.added_centers[centerId];
    }
    if (patches.centers && patches.centers[centerId]) {
      delete patches.centers[centerId];
    }

    selectedCenterId = '';
    closeDeleteCenterModal();
    applyPatches();
    persistPatches();
    refreshAll();
    showNotice('Pedidos trasladados y sede eliminada.');
  };
}

function performDeleteCenter(centerId) {
  patches.deleted_centers = patches.deleted_centers || {};
  patches.deleted_centers[centerId] = true;

  if (patches.added_centers && patches.added_centers[centerId]) {
    delete patches.added_centers[centerId];
  }
  if (patches.centers && patches.centers[centerId]) {
    delete patches.centers[centerId];
  }

  selectedCenterId = '';
  applyPatches();
  persistPatches();
  refreshAll();
  showNotice('Sede eliminada.');
}

function sortClientComs(key) {
  if (clientComsSortKey === key) {
    clientComsSortAsc = !clientComsSortAsc;
  } else {
    clientComsSortKey = key;
    clientComsSortAsc = true;
  }
  refreshAll();
}

function selectEpicFromCenter(epicKey) {
  if (selectedEpicKey === epicKey) {
    selectedEpicKey = '';
  } else {
    selectedEpicKey = epicKey;
  }
  refreshAll();
}

function renderEpics() {
  const epics = getFilteredEpics();
  document.getElementById('epicsTitle').textContent = `Pedidos / COM (${epics.length})`;
  const rows = epics.map(e => {
    const client = idx.clientsById[e.client_id] || {};
    const center = idx.centersById[e.center_id] || {};
    const acts = idx.activitiesByEpic[e.key] || [];
    const prod = acts.filter(a => a.line_kind === 'Producto').length;
    const serv = acts.filter(a => a.line_kind === 'Servicio').length;
    return `<tr class="clickable ${selectedEpicKey === e.key ? 'selected-row' : ''}" data-epic="${esc(e.key)}">
      <td class="mono"><b>${esc(e.key)}</b></td>
      <td class="mono">${esc(e.com || 'SIN COM')}</td>
      <td>${esc(client.name || e.client_name || '')}</td>
      <td>${esc(center.name || e.center_name || '')}</td>
      <td class="${e.status_group === 'Finalizada' ? 'status-finalizada' : 'status-activa'}">${esc(e.status_group || e.status || '')}</td>
      <td>${esc(e.created_date || e.created || '')}</td>
      <td>${prod}</td>
      <td>${serv}</td>
    </tr>`;
  }).join('');

  document.getElementById('epicsPanel').innerHTML = rows ? `
    <div class="table-wrap" style="max-height:300px;overflow-y:auto">
      <table class="data-table">
        <thead>
          <tr>
            <th>DOIT</th>
            <th>COM</th>
            <th>Cliente</th>
            <th>Centro</th>
            <th>Estado</th>
            <th>Fecha</th>
            <th>Prod.</th>
            <th>Serv.</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`: '<div class="empty">No hay Pedidos.</div>';

  document.querySelectorAll('#epicsPanel [data-epic]').forEach(el => el.addEventListener('click', () => {
    selectedEpicKey = el.dataset.epic;
    const ep = idx.epicsByKey[selectedEpicKey];
    if (ep) {
      selectedClientId = ep.client_id;
      selectedCenterId = ep.center_id || '';
    }
    refreshAll();
  }));
}

function renderEpicDetail() {
  const panel = document.getElementById('epicDetailPanel');
  if (!selectedEpicKey) {
    panel.innerHTML = '<div class="empty">Selecciona un Pedido para ver su albarán y detalles.</div>';
    return;
  }
  const e = idx.epicsByKey[selectedEpicKey];
  if (!e) { panel.innerHTML = '<div class="empty">Pedido no encontrado.</div>'; return; }
  const acts = idx.activitiesByEpic[e.key] || [];
  const centerOptions = (data.centers || []).filter(c => c.client_id === e.client_id).map(c => c.id);
  if (e.center_id && !centerOptions.includes(e.center_id)) centerOptions.push(e.center_id);
  const custom = e.custom || {};

  panel.innerHTML = `<div class="epic-detail">
    <div class="grid-3" style="margin-bottom:12px">
      <div><b>DOIT / EPIC:</b><br><span class="tag tag-blue mono epic-detail-large-val">${esc(e.key)}</span></div>
      <div><b>COM / Comanda:</b><br><span class="tag tag-purple mono epic-detail-large-val">${esc(e.com || 'SIN COM')}</span></div>
      <div><b>Estado:</b><br><span class="${e.status_group === 'Finalizada' ? 'status-finalizada epic-detail-status-val' : 'status-activa epic-detail-status-val'}">${esc(e.status_group || e.status || '')}</span></div>
    </div>
    <p style="margin-bottom:8px"><b>Resumen:</b> ${esc(e.summary || '')}</p>
    <div class="summary-box"><b>Descripción original:</b><br>${esc(e.description || 'Sin descripción')}</div>
  </div>
  <h3 style="font-size:13px;margin:18px 0 8px">Editar Parámetros Pedido / COM</h3>
  <div class="contact-grid">
    <div class="field"><label>Código COM (Asignar/Cambiar)</label><input id="ep_com" value="${esc(e.com || '')}"></div>
    <div class="field"><label>Sede / Centro</label><select id="ep_center">
      <option value="">-- Ninguno --</option>
      ${centerOptions.map(id => `<option value="${esc(id)}" ${id === e.center_id ? 'selected' : ''}>${esc(idx.centersById[id]?.name || id)}</option>`).join('')}
    </select></div>
    <div class="field"><label>Estado entrega</label><input id="ep_delivery" value="${esc(custom.delivery_status || '')}"></div>
    <div class="field wide"><label>Notas Pedido</label><textarea id="ep_notes">${esc(custom.notes || '')}</textarea></div>
  </div>
  <div class="save-strip">
    <div class="mini muted">Origen: ${esc(e.normalization_rule || 'Directo')}</div>
    <button class="btn btn-primary" id="saveEpicBtn">Guardar Parámetros</button>
  </div>
  <h3 style="font-size:13px;margin:18px 0 8px">Albarán (Líneas de Pedido)</h3>
  ${renderAlbaranTable(acts)}`;

  document.getElementById('saveEpicBtn').onclick = saveEpicForm;

  document.querySelectorAll('.edit-line-btn').forEach(btn => {
    btn.onclick = () => {
      const actKey = btn.dataset.actKey;
      openEditLineModal(actKey);
    };
  });
}

function renderAlbaranTable(rows) {
  if (!rows.length) return '<div class="empty">Sin líneas en el albarán.</div>';
  return `<div class="table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th>DOIT</th>
          <th>Cant.</th>
          <th>Producto / actividad</th>
          <th>Ref.</th>
          <th>Categoría</th>
          <th>Estado</th>
          <th style="width: 80px; text-align: center;">Acción</th>
        </tr>
      </thead>
      <tbody>${rows.map(a => `<tr>
        <td class="mono">${esc(a.key)}</td>
        <td>${esc(a.quantity ?? '')}</td>
        <td>${esc(a.product_name || a.summary || '')}</td>
        <td class="mono">${esc(a.reference || '')}</td>
        <td><span class="tag tag-default">${esc(a.category || a.line_kind || '')}</span></td>
        <td>${esc(a.status || '')}</td>
        <td style="text-align: center;"><button class="btn btn-sm edit-line-btn" data-act-key="${esc(a.key)}">Editar</button></td>
      </tr>`).join('')}</tbody>
    </table>
  </div>`;
}

function openEditLineModal(actKey) {
  const a = (data.activities || []).find(x => x.key === actKey);
  if (!a) {
    alert('Línea no encontrada.');
    return;
  }

  const modalHtml = `
    <div class="modal-overlay active" id="editLineModalOverlay">
      <div class="modal-container">
        <div class="modal-header">
          <h3>Editar Línea de Albarán: ${esc(actKey)}</h3>
          <button class="modal-close-btn" id="closeLineModalBtn">×</button>
        </div>
        <div class="modal-body">
          <div class="contact-grid" style="grid-template-columns: 1fr;">
            <div class="field"><label>DOIT / JIRA Key</label><input value="${esc(a.key)}" disabled style="opacity:0.6;"></div>
            <div class="field"><label>Cantidad</label><input type="number" id="edit_li_qty" value="${esc(a.quantity ?? 1)}"></div>
            <div class="field"><label>Producto / Actividad</label><input id="edit_li_name" value="${esc(a.product_name || a.summary || '')}"></div>
            <div class="field"><label>Referencia</label><input id="edit_li_ref" value="${esc(a.reference || '')}"></div>
            <div class="field"><label>Categoría</label><input id="edit_li_cat" value="${esc(a.category || a.line_kind || '')}"></div>
            <div class="field"><label>Estado</label><input id="edit_li_status" value="${esc(a.status || '')}"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" id="closeLineModalFooterBtn">Cancelar</button>
          <button class="btn btn-primary" id="saveLineModalBtn">Guardar Cambios</button>
        </div>
      </div>
    </div>
  `;

  let modalContainer = document.getElementById('modalContainer');
  if (!modalContainer) {
    modalContainer = document.createElement('div');
    modalContainer.id = 'modalContainer';
    document.body.appendChild(modalContainer);
  }
  modalContainer.innerHTML = modalHtml;

  const closeModal = () => {
    const overlay = document.getElementById('editLineModalOverlay');
    if (overlay) {
      overlay.classList.remove('active');
      setTimeout(() => overlay.remove(), 250);
    }
  };

  document.getElementById('closeLineModalBtn').onclick = closeModal;
  document.getElementById('closeLineModalFooterBtn').onclick = closeModal;

  document.getElementById('saveLineModalBtn').onclick = () => {
    const qty = parseInt(document.getElementById('edit_li_qty').value) || 1;
    const name = document.getElementById('edit_li_name').value.trim();
    const ref = document.getElementById('edit_li_ref').value.trim();
    const cat = document.getElementById('edit_li_cat').value.trim();
    const status = document.getElementById('edit_li_status').value.trim();

    patches.activities = patches.activities || {};
    patches.activities[actKey] = {
      quantity: qty,
      product_name: name,
      summary: name,
      reference: ref,
      category: cat,
      status: status
    };

    applyPatches();
    persistPatches();
    closeModal();
    refreshAll();
  };
}

function saveEpicForm() {
  const e = idx.epicsByKey[selectedEpicKey]; if (!e) return;
  const newCenter = document.getElementById('ep_center').value;
  const newCom = document.getElementById('ep_com').value.trim();
  const patch = {
    com: newCom || null,
    center_id: newCenter,
    center_name: idx.centersById[newCenter]?.name || e.center_name || '',
    custom: {
      ...(e.custom || {}),
      delivery_status: document.getElementById('ep_delivery').value,
      notes: document.getElementById('ep_notes').value
    }
  };
  patches.epics[selectedEpicKey] = patches.epics[selectedEpicKey] || {};
  mergeObj(patches.epics[selectedEpicKey], patch);
  applyPatches();
  persistPatches();
  selectedCenterId = newCenter;
  refreshAll();
}

function renderAllEpics() {
  const epics = getFilteredEpics();

  // Sort epics table dynamically
  epics.sort((a, b) => {
    let valA, valB;
    if (epicsSortKey === 'key') {
      valA = parseInt(a.key.replace(/\D/g, '')) || 0;
      valB = parseInt(b.key.replace(/\D/g, '')) || 0;
    } else if (epicsSortKey === 'com') {
      valA = a.com || '';
      valB = b.com || '';
    } else if (epicsSortKey === 'client') {
      valA = idx.clientsById[a.client_id]?.name || a.client_name || '';
      valB = idx.clientsById[b.client_id]?.name || b.client_name || '';
    } else if (epicsSortKey === 'center') {
      valA = idx.centersById[a.center_id]?.name || a.center_name || '';
      valB = idx.centersById[b.center_id]?.name || b.center_name || '';
    } else if (epicsSortKey === 'status') {
      valA = a.status_group || '';
      valB = b.status_group || '';
    } else if (epicsSortKey === 'date') {
      valA = a.created_date || a.created || '';
      valB = b.created_date || b.created || '';
    } else if (epicsSortKey === 'lines') {
      valA = (idx.activitiesByEpic[a.key] || []).length;
      valB = (idx.activitiesByEpic[b.key] || []).length;
    }

    let cmp = 0;
    if (typeof valA === 'number' && typeof valB === 'number') {
      cmp = valA - valB;
    } else {
      cmp = String(valA).localeCompare(String(valB), 'es', { numeric: true });
    }
    return epicsSortAsc ? cmp : -cmp;
  });

  const f = filterContext();
  const rows = epics.map(e => {
    const client = idx.clientsById[e.client_id] || {};
    const center = idx.centersById[e.center_id] || {};
    const acts = idx.activitiesByEpic[e.key] || [];
    return `<tr class="clickable" data-epic-go="${esc(e.key)}">
      <td class="mono"><b>${highlight(e.key, f.q)}</b></td>
      <td class="mono">${highlight(e.com || 'SIN COM', f.q)}</td>
      <td><b>${highlight(client.name || '', f.q)}</b></td>
      <td>${highlight(center.name || '', f.q)}</td>
      <td class="${e.status_group === 'Finalizada' ? 'status-finalizada' : 'status-activa'}">${esc(e.status_group || '')}</td>
      <td>${esc(e.created_date || '')}</td>
      <td>${acts.length}</td>
      <td>${highlight(e.summary || '', f.q)}</td>
    </tr>`;
  }).join('');

  function sortClass(key) {
    if (epicsSortKey !== key) return 'sortable';
    return `sortable ${epicsSortAsc ? 'asc' : 'desc'}`;
  }

  document.getElementById('allEpicsPanel').innerHTML = rows ? `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th class="${sortClass('key')}" data-sort="key">Pedido / DOIT</th>
            <th class="${sortClass('com')}" data-sort="com">COM / Comanda</th>
            <th class="${sortClass('client')}" data-sort="client">Cliente</th>
            <th class="${sortClass('center')}" data-sort="center">Sede</th>
            <th class="${sortClass('status')}" data-sort="status">Estado</th>
            <th class="${sortClass('date')}" data-sort="date">Fecha</th>
            <th class="${sortClass('lines')}" data-sort="lines">Líneas</th>
            <th>Resumen</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>` : '<div class="empty">Sin Pedidos que coincidan.</div>';

  document.querySelectorAll('[data-epic-go]').forEach(el => el.addEventListener('click', (e) => {
    // Avoid triggering when clicking sort headers
    if (e.target.closest('th')) return;
    selectedEpicKey = el.dataset.epicGo;
    const ep = idx.epicsByKey[selectedEpicKey];
    if (ep) {
      selectedClientId = ep.client_id;
      selectedCenterId = ep.center_id || '';
    }
    switchPage('clients');
    refreshAll();
  }));
}

function renderProductAnalytics() {
  // Fill suggestions list with both reference and name
  const suggestions = document.getElementById('productSuggestions');
  const sugKeys = [];
  for (const key in idx.productSales) {
    const p = idx.productSales[key];
    if (p.reference) sugKeys.push(p.reference);
    if (p.name) sugKeys.push(p.name);
  }
  suggestions.innerHTML = [...new Set(sugKeys)]
    .sort()
    .map(val => `<option value="${esc(val)}"></option>`)
    .join('');

  // Fetch product search
  const searchQ = norm(document.getElementById('productSearchInput').value.trim());
  const allProds = Object.values(idx.productSales)
    .map(p => {
      const total = Object.values(p.years).reduce((a, b) => a + b, 0);
      return { name: p.name, reference: p.reference || '', key: p.reference || p.name, total };
    })
    .filter(p => !searchQ || norm(p.name).includes(searchQ) || norm(p.reference).includes(searchQ))
    .sort((a, b) => b.total - a.total); // default sorted by units sold descending

  document.getElementById('topProductsList').innerHTML = `
    <div class="table-wrap" style="max-height: 400px; overflow-y: auto;">
      <table class="data-table">
        <thead>
          <tr>
            <th>Nombre Producto</th>
            <th>Referencia</th>
            <th>Unidades Vendidas</th>
          </tr>
        </thead>
        <tbody>
          ${allProds.map(p => `<tr class="clickable product-row-btn ${selectedProductId === p.key ? 'selected-row' : ''}" data-prod="${esc(p.key)}">
            <td><b>${highlight(p.name, searchQ)}</b></td>
            <td class="mono">${highlight(p.reference || 'Sin ref', searchQ)}</td>
            <td><span class="tag tag-blue">${p.total} uds.</span></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  document.querySelectorAll('#topProductsList .product-row-btn').forEach(el => {
    el.onclick = () => {
      selectedProductId = el.dataset.prod;
      renderProductAnalytics();
    };
  });

  // Render sales detail panels
  const currentProd = selectedProductId || (allProds[0] ? allProds[0].key : '');
  const salesData = idx.productSales[currentProd];
  const chartPanel = document.getElementById('productYearChart');
  const detailPanel = document.getElementById('productDetailPanel');
  const detailTitle = document.getElementById('productDetailTitle');

  if (!salesData) {
    chartPanel.innerHTML = '<div class="empty">Selecciona o busca un producto para ver su evolución anual.</div>';
    detailPanel.innerHTML = '<div class="empty">Sin detalle de producto.</div>';
    detailTitle.textContent = 'Detalle de producto';
    return;
  }

  const titleText = salesData.reference ? `${salesData.name} (${salesData.reference})` : salesData.name;
  detailTitle.textContent = `Detalle: ${esc(titleText)}`;

  // Render annual chart
  const years = Object.keys(salesData.years).sort();
  const max = Math.max(1, ...Object.values(salesData.years));
  chartPanel.innerHTML = `
    <h3 style="font-size:13px;margin-bottom:12px">Evolución anual de ventas (uds):</h3>
    <div class="bar-chart">
      ${years.map(y => {
    const val = salesData.years[y];
    const h = Math.max(2, Math.round(val / max * 130));
    return `<div class="bar-col clickable-bar" data-year="${y}" title="Ver detalle de ventas en ${y}">
          <div class="bar" style="height:${h}px;background:linear-gradient(180deg,var(--cyan),var(--accent))"><span class="value">${val}</span></div>
          <div class="bar-label">${esc(y)}</div>
        </div>`;
  }).join('')}
    </div>`;

  // Bind click handlers to chart bars
  document.querySelectorAll('.clickable-bar').forEach(el => {
    el.onclick = () => {
      const year = el.dataset.year;
      showProductYearDetailModal(currentProd, year);
    };
  });

  // Sort detailed table columns
  const sortedDetails = [...salesData.details].sort((a, b) => {
    let valA, valB;
    if (productDetailSortKey === 'client') {
      valA = idx.clientsById[a.client_id]?.name || '';
      valB = idx.clientsById[b.client_id]?.name || '';
    } else if (productDetailSortKey === 'center') {
      valA = idx.centersById[a.center_id]?.name || 'Sede principal';
      valB = idx.centersById[b.center_id]?.name || 'Sede principal';
    } else if (productDetailSortKey === 'epic') {
      valA = parseInt(a.epic_key.replace(/\D/g, '')) || 0;
      valB = parseInt(b.epic_key.replace(/\D/g, '')) || 0;
    } else if (productDetailSortKey === 'com') {
      valA = a.com || '';
      valB = b.com || '';
    } else if (productDetailSortKey === 'quantity') {
      valA = a.quantity || 0;
      valB = b.quantity || 0;
    } else if (productDetailSortKey === 'description') {
      valA = a.line_description || '';
      valB = b.line_description || '';
    } else if (productDetailSortKey === 'date') {
      valA = a.date || '';
      valB = b.date || '';
    } else if (productDetailSortKey === 'status') {
      valA = a.status || '';
      valB = b.status || '';
    }

    let cmp = 0;
    if (typeof valA === 'number' && typeof valB === 'number') {
      cmp = valA - valB;
    } else {
      cmp = String(valA).localeCompare(String(valB), 'es', { numeric: true });
    }
    return productDetailSortAsc ? cmp : -cmp;
  });

  const rows = sortedDetails.map(d => {
    const cl = idx.clientsById[d.client_id] || {};
    const ct = idx.centersById[d.center_id] || {};
    return `<tr>
      <td><b>${esc(cl.name || '')}</b></td>
      <td>${esc(ct.name || 'Sede principal')}</td>
      <td class="mono">${esc(d.epic_key)}</td>
      <td class="mono">${esc(d.com || 'SIN COM')}</td>
      <td>${d.quantity}</td>
      <td>${esc(d.line_description || d.product_name || '')}</td>
      <td>${esc(d.date)}</td>
      <td>${esc(d.status)}</td>
    </tr>`;
  }).join('');

  function prodSortClass(key) {
    if (productDetailSortKey !== key) return 'sortable';
    return `sortable ${productDetailSortAsc ? 'asc' : 'desc'}`;
  }

  detailPanel.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th class="${prodSortClass('client')}" data-sort="client">Cliente</th>
            <th class="${prodSortClass('center')}" data-sort="center">Centro / Sede</th>
            <th class="${prodSortClass('epic')}" data-sort="epic">Pedido / DOIT</th>
            <th class="${prodSortClass('com')}" data-sort="com">COM / Comanda</th>
            <th class="${prodSortClass('quantity')}" data-sort="quantity">Cantidad</th>
            <th class="${prodSortClass('description')}" data-sort="description">Descripción en Pedido</th>
            <th class="${prodSortClass('date')}" data-sort="date">Fecha</th>
            <th class="${prodSortClass('status')}" data-sort="status">Estado</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="8" class="empty">Sin registros.</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

function showProductYearDetailModal(prodRef, year) {
  const salesData = idx.productSales[prodRef];
  if (!salesData) return;

  const details = salesData.details.filter(d => {
    const epic = idx.epicsByKey[d.epic_key] || {};
    const eYear = epic.created_year || (d.date ? new Date(d.date).getFullYear() : '');
    return String(eYear) === String(year);
  });

  const rows = details.map(d => {
    const cl = idx.clientsById[d.client_id] || {};
    const ct = idx.centersById[d.center_id] || {};
    return `<tr>
      <td><b>${esc(cl.name || '')}</b></td>
      <td>${esc(ct.name || 'Sede principal')}</td>
      <td class="mono">${esc(d.epic_key)}</td>
      <td class="mono">${esc(d.com || 'SIN COM')}</td>
      <td>${d.quantity}</td>
      <td>${esc(d.line_description || d.product_name || '')}</td>
      <td>${esc(d.date)}</td>
      <td>${esc(d.status)}</td>
    </tr>`;
  }).join('');

  const titleText = salesData.reference ? `${salesData.name} (${salesData.reference})` : salesData.name;
  const modalHtml = `
    <div class="modal-overlay active" id="yearDetailModalOverlay">
      <div class="modal-container">
        <div class="modal-header">
          <h3>Detalle de ventas: ${esc(titleText)} (${esc(year)})</h3>
          <button class="modal-close-btn" id="closeYearModalBtn">×</button>
        </div>
        <div class="modal-body">
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Sede / Centro</th>
                  <th>Pedido / DOIT</th>
                  <th>COM</th>
                  <th>Cant.</th>
                  <th>Descripción en Pedido</th>
                  <th>Fecha</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                ${rows || '<tr><td colspan="8" class="empty">Sin registros para este año.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" id="closeYearModalFooterBtn">Cerrar</button>
        </div>
      </div>
    </div>
  `;

  let modalContainer = document.getElementById('modalContainer');
  if (!modalContainer) {
    modalContainer = document.createElement('div');
    modalContainer.id = 'modalContainer';
    document.body.appendChild(modalContainer);
  }
  modalContainer.innerHTML = modalHtml;

  const closeModal = () => {
    const overlay = document.getElementById('yearDetailModalOverlay');
    if (overlay) {
      overlay.classList.remove('active');
      setTimeout(() => overlay.remove(), 250);
    }
  };
  document.getElementById('closeYearModalBtn').onclick = closeModal;
  document.getElementById('closeYearModalFooterBtn').onclick = closeModal;
}

function addClient() {
  const id = 'CLI_MANUAL_' + Date.now();
  const c = {
    id, name: 'Nuevo cliente', type: 'Pendiente clasificar',
    contact: { contact_name: '', email: '', phone: '', mobile: '', address: '', city: '', country: '', website: '', notes: '', source: 'Alta manual' },
    custom: { owner: '', priority: '', segment: '', notes: '' },
    aliases: [], centers: [], epics: [], comandas: [], jira_keys: [],
    stats: { epics: 0, epics_finalizados: 0, epics_activos: 0, productos: 0, servicios: 0 },
    review_flags: ['Alta manual']
  };
  patches.added_clients[id] = c;
  selectedClientId = id;
  selectedCenterId = '';
  selectedEpicKey = '';
  applyPatches();
  persistPatches();
  refreshAll();
}

function addCenter() {
  if (!selectedClientId) { alert('Selecciona primero un cliente.'); return; }
  const client = idx.clientsById[selectedClientId];
  const id = 'CTR_MANUAL_' + Date.now();
  const ctr = {
    id, client_id: selectedClientId, client_name: client?.name || '',
    name: 'Nuevo centro', kind: 'Centro',
    contact: { contact_name: '', email: '', phone: '', mobile: '', address: '', city: '', country: '', website: '', notes: '', source: 'Alta manual' },
    epics: [], comandas: [], stats: { epics: 0, productos: 0, servicios: 0 }, detection_rule: 'Alta manual'
  };
  patches.added_centers[id] = ctr;
  selectedCenterId = id;
  applyPatches();
  persistPatches();
  refreshAll();
}

function exportJson() { const out = prepareExportData(); downloadText('crm_jira_2022_2026_actualizado.json', JSON.stringify(out, null, 2), 'application/json;charset=utf-8'); }
function csvCell(v) { const s = String(v ?? ''); return '"' + s.replace(/"/g, '""') + '"'; }

function exportCsv() {
  const out = prepareExportData();
  const centers = Object.fromEntries(out.centers.map(c => [c.id, c]));
  const clients = Object.fromEntries(out.clients.map(c => [c.id, c]));
  const actsByEpic = {};
  for (const a of out.activities || []) { (actsByEpic[a.root_epic_key] || (actsByEpic[a.root_epic_key] = [])).push(a); }
  const header = ['cliente_id', 'cliente', 'tipo_cliente', 'cliente_activo', 'contacto', 'email', 'telefono', 'direccion', 'centro_id', 'centro', 'epic_doit', 'com', 'estado_epic', 'fecha_epic', 'actividad_doit', 'tipo_linea', 'cantidad', 'producto_actividad', 'referencia', 'categoria', 'estado_actividad', 'fecha_actividad', 'resumen_epic'];
  const lines = [header.map(csvCell).join(',')];
  for (const e of out.epics || []) {
    const cl = clients[e.client_id] || {};
    const ct = centers[e.center_id] || {};
    const contact = cl.contact || {};
    const rows = actsByEpic[e.key] && actsByEpic[e.key].length ? actsByEpic[e.key] : [{}];
    for (const a of rows) {
      const clActive = cl.active !== false ? 'Activo' : 'Inactivo';
      lines.push([cl.id, cl.name, cl.type, clActive, contact.contact_name, contact.email, contact.phone, contact.address, ct.id, ct.name, e.key, e.com, e.status_group || e.status, e.created, a.key, a.line_kind, a.quantity, a.product_name || a.summary, a.reference, a.category, a.status, a.created, e.summary].map(csvCell).join(','));
    }
  }
  downloadText('crm_jira_2022_2026_operativo.csv', lines.join('\n'), 'text/csv;charset=utf-8');
}

function clearLocal() {
  if (!confirm('Esto eliminará las ediciones guardadas en este navegador y volverá a los datos base embebidos.')) return;
  patches = { clients: {}, centers: {}, epics: {}, activities: {}, added_clients: {}, added_centers: {}, deleted_centers: {}, deleted_clients: {}, deleted_epics: {} };
  if (storage) storage.removeItem(STORAGE_KEY);
  selectedClientId = ''; selectedCenterId = ''; selectedEpicKey = ''; selectedProductId = '';
  applyPatches(); refreshAll();
  showNotice('Cambios locales descartados.', true);
}

function bindEvents() {
  // Search and Filters inputs
  ['typeFilter', 'statusFilter', 'yearFilter', 'centerFilter'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      selectedEpicKey = '';
      refreshAll();
    });
  });

  document.getElementById('searchInput').addEventListener('input', () => {
    selectedEpicKey = '';
    const q = document.getElementById('searchInput').value.trim();
    if (q && currentPage !== 'search-results') {
      switchPage('search-results');
    } else if (!q && currentPage === 'search-results') {
      switchPage(lastNonSearchPage || 'overview');
    }
    refreshAll();
  });

  // Reset Filters
  document.getElementById('showAllBtn').onclick = () => {
    document.getElementById('searchInput').value = '';
    document.getElementById('typeFilter').value = '';
    document.getElementById('statusFilter').value = '';
    document.getElementById('yearFilter').value = '';
    document.getElementById('centerFilter').value = '';
    selectedClientId = ''; selectedCenterId = ''; selectedEpicKey = ''; selectedProductId = '';
    refreshAll();
  };

  // Banner Reset Filters Button
  document.getElementById('bannerResetBtn').onclick = () => {
    document.getElementById('showAllBtn').click();
  };

  // Top clients metric change
  document.getElementById('topClientsMetricSelect').addEventListener('change', () => {
    renderTopClients();
  });

  // Buttons actions
  document.getElementById('addClientBtn').onclick = addClient;
  document.getElementById('addCenterBtn').onclick = addCenter;
  document.getElementById('exportJsonBtn').onclick = exportJson;
  document.getElementById('exportCsvBtn').onclick = exportCsv;
  document.getElementById('clearLocalBtn').onclick = clearLocal;

  // Overview metrics tabs
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentMetric = btn.dataset.metric;
    renderEvolution();
  }));

  // Sidebar navigation
  document.querySelectorAll('.sidebar-nav .nav-btn').forEach(btn => {
    btn.onclick = () => {
      switchPage(btn.dataset.page);
      refreshAll();
    };
  });

  // Mobile menu toggle
  const toggle = document.getElementById('menuToggle');
  const overlay = document.getElementById('overlay');

  toggle.onclick = () => document.body.classList.toggle('sidebar-open');
  overlay.onclick = () => document.body.classList.remove('sidebar-open');

  document.querySelectorAll('.sidebar-nav .nav-btn, .sidebar-actions button').forEach(el => {
    el.addEventListener('click', () => document.body.classList.remove('sidebar-open'));
  });

  // Product page analytics event
  document.getElementById('productSearchInput').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    const qNorm = q.toLowerCase();
    let foundKey = '';
    for (const key in idx.productSales) {
      if (key.toLowerCase() == qNorm) {
        foundKey = key;
        break;
      }
    }
    if (foundKey) {
      selectedProductId = foundKey;
    }
    renderProductAnalytics();
  });

  // Event Delegation for Epic tables sort header clicks
  document.getElementById('allEpicsPanel').onclick = (e) => {
    const th = e.target.closest('th.sortable');
    if (th) {
      const key = th.dataset.sort;
      if (epicsSortKey === key) {
        epicsSortAsc = !epicsSortAsc;
      } else {
        epicsSortKey = key;
        epicsSortAsc = true;
      }
      renderAllEpics();
    }
  };

  // Event Delegation for Product detail tables sort header clicks
  document.getElementById('productDetailPanel').onclick = (e) => {
    const th = e.target.closest('th.sortable');
    if (th) {
      const key = th.dataset.sort;
      if (productDetailSortKey === key) {
        productDetailSortAsc = !productDetailSortAsc;
      } else {
        productDetailSortKey = key;
        productDetailSortAsc = true;
      }
      renderProductAnalytics();
    }
  };

  // Initialize Search Suggestions
  initSearchSuggestions();
}

function closeDeleteCenterModal() {
  const overlay = document.getElementById('deleteCenterModalOverlay');
  if (overlay) overlay.classList.remove('active');
}

function dragEpic(ev, epicKey) {
  ev.dataTransfer.setData("text/plain", epicKey);
}

function allowDropEpic(ev, el) {
  ev.preventDefault();
  el.classList.add('drag-over');
}

function leaveDropEpic(ev, el) {
  el.classList.remove('drag-over');
}

function dropEpic(ev, centerId, el) {
  ev.preventDefault();
  el.classList.remove('drag-over');
  const epicKey = ev.dataTransfer.getData("text/plain");
  if (!epicKey) return;

  const ep = idx.epicsByKey[epicKey];
  if (!ep || ep.client_id !== selectedClientId) {
    showNotice("Solo puedes mover pedidos de este mismo cliente.", false);
    return;
  }
  if (ep.center_id === centerId) return;

  patches.epics[epicKey] = patches.epics[epicKey] || {};
  patches.epics[epicKey].center_id = centerId;

  applyPatches();
  persistPatches();
  refreshAll();
  showNotice(`Pedido ${epicKey} movido a la sede seleccionada.`, true);
}

function initSearchSuggestions() {
  const searchInput = document.getElementById('searchInput');
  const suggestionsDiv = document.getElementById('searchSuggestions');
  if (!searchInput || !suggestionsDiv) return;

  searchInput.addEventListener('input', () => {
    const q = norm(searchInput.value).trim();
    if (!q) {
      suggestionsDiv.innerHTML = '';
      suggestionsDiv.classList.remove('active');
      return;
    }

    const suggestions = [];

    // Match clients
    for (const c of data.clients || []) {
      if (norm(c.name).includes(q)) {
        suggestions.push({ type: 'client', id: c.id, text: c.name, cat: 'Cliente', icon: '👥' });
      }
    }

    // Match epics (orders)
    for (const e of data.epics || []) {
      if (norm(e.key).includes(q) || (e.com && norm(e.com).includes(q))) {
        const code = e.com ? `${e.key} (${e.com})` : e.key;
        suggestions.push({ type: 'epic', id: e.key, text: code, cat: 'Pedido', icon: '📋' });
      }
    }

    // Match products
    const matchedProducts = [];
    for (const key in idx.productSales) {
      const p = idx.productSales[key];
      if (norm(p.name).includes(q) || (p.reference && norm(p.reference).includes(q))) {
        const display = p.reference ? `${p.name} (${p.reference})` : p.name;
        matchedProducts.push({ key, display });
      }
    }
    for (const p of matchedProducts) {
      suggestions.push({ type: 'product', id: p.key, text: p.display, cat: 'Producto', icon: '📦' });
    }

    const sliced = suggestions.slice(0, 8);
    if (!sliced.length) {
      suggestionsDiv.innerHTML = '';
      suggestionsDiv.classList.remove('active');
      return;
    }

    suggestionsDiv.innerHTML = sliced.map(s => `
      <div class="suggestion-item" data-type="${s.type}" data-id="${esc(s.id)}" data-text="${esc(s.text)}">
        <span class="icon">${s.icon}</span>
        <span class="suggestion-text">${esc(s.text)}</span>
        <span class="suggestion-category">${s.cat}</span>
      </div>
    `).join('');
    suggestionsDiv.classList.add('active');

    suggestionsDiv.querySelectorAll('.suggestion-item').forEach(item => {
      item.onclick = (e) => {
        e.stopPropagation();
        const type = item.dataset.type;
        const id = item.dataset.id;

        if (type === 'client') {
          selectedClientId = id;
          selectedCenterId = '';
          selectedEpicKey = '';
          switchPage('clients');
        } else if (type === 'epic') {
          const ep = idx.epicsByKey[id] || {};
          selectedClientId = ep.client_id || '';
          selectedCenterId = ep.center_id || '';
          selectedEpicKey = id;
          switchPage('clients');
        } else if (type === 'product') {
          selectedProductId = id;
          const prodSearchInput = document.getElementById('productSearchInput');
          if (prodSearchInput) prodSearchInput.value = id;
          switchPage('products');
        }

        suggestionsDiv.classList.remove('active');
        refreshAll();
      };
    });
  });

  document.addEventListener('click', (e) => {
    if (e.target !== searchInput && e.target !== suggestionsDiv && !suggestionsDiv.contains(e.target)) {
      suggestionsDiv.classList.remove('active');
    }
  });
}

function renderSearchResults() {
  const panel = document.getElementById('page-search-results');
  if (!panel) return;

  const f = filterContext();
  if (!f.q) {
    panel.innerHTML = '<div class="empty">Escribe algo en el buscador superior para ver resultados.</div>';
    return;
  }

  const clients = (data.clients || []).filter(c => norm(c.name).includes(f.q) || norm(c.type).includes(f.q));

  const epics = (data.epics || []).filter(e => {
    const client = idx.clientsById[e.client_id] || {};
    const center = idx.centersById[e.center_id] || {};
    const text = [e.key, e.com, e.summary, e.status, client.name, center.name].join(' ');
    return norm(text).includes(f.q);
  });

  const products = [];
  for (const key in idx.productSales) {
    const p = idx.productSales[key];
    if (norm(p.name).includes(f.q) || (p.reference && norm(p.reference).includes(f.q))) {
      products.push(p);
    }
  }

  if (clients.length === 0 && epics.length === 0 && products.length === 0) {
    panel.innerHTML = `<div class="empty">No se encontraron resultados para la búsqueda: "<b>${esc(document.getElementById('searchInput').value)}</b>"</div>`;
    return;
  }

  let html = `<div style="display:flex;flex-direction:column;gap:24px">`;

  if (clients.length > 0) {
    html += `<div>
      <h3 style="font-size:14px;margin-bottom:10px;display:flex;align-items:center;gap:6px">👥 Clientes Encontrados (${clients.length})</h3>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Tipo</th>
              <th>Pedidos</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            ${clients.map(c => `
              <tr>
                <td><b>${highlight(c.name, f.q)}</b></td>
                <td>${highlight(c.type, f.q)}</td>
                <td><span class="tag tag-default">${c.stats?.epics || 0} Pedidos</span></td>
                <td><button class="btn btn-sm btn-primary go-client-btn" data-id="${esc(c.id)}">Ver Ficha</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  if (epics.length > 0) {
    html += `<div>
      <h3 style="font-size:14px;margin-bottom:10px;display:flex;align-items:center;gap:6px">📋 Pedidos Encontrados (${epics.length})</h3>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>DOIT / EPIC</th>
              <th>COM</th>
              <th>Cliente</th>
              <th>Sede</th>
              <th>Estado</th>
              <th>Fecha</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            ${epics.map(e => {
      const client = idx.clientsById[e.client_id] || {};
      const center = idx.centersById[e.center_id] || {};
      return `
                <tr>
                  <td class="mono"><b>${highlight(e.key, f.q)}</b></td>
                  <td class="mono">${highlight(e.com || 'SIN COM', f.q)}</td>
                  <td>${highlight(client.name || e.client_name || '', f.q)}</td>
                  <td>${highlight(center.name || e.center_name || '', f.q)}</td>
                  <td><span class="${e.status_group === 'Finalizada' ? 'status-finalizada' : 'status-activa'}">${highlight(e.status_group || e.status || '', f.q)}</span></td>
                  <td>${e.created || ''}</td>
                  <td><button class="btn btn-sm btn-primary go-epic-btn" data-client="${esc(e.client_id)}" data-center="${esc(e.center_id || '')}" data-epic="${esc(e.key)}">Ver Pedido</button></td>
                </tr>
              `;
    }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  if (products.length > 0) {
    html += `<div>
      <h3 style="font-size:14px;margin-bottom:10px;display:flex;align-items:center;gap:6px">📦 Productos Encontrados (${products.length})</h3>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Nombre Producto</th>
              <th>Referencia</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            ${products.map(p => {
      const key = p.reference || p.name;
      return `
              <tr>
                <td><b>${highlight(p.name, f.q)}</b></td>
                <td class="mono">${highlight(p.reference || '--', f.q)}</td>
                <td><button class="btn btn-sm btn-primary go-product-btn" data-key="${esc(key)}">Ver Estadísticas</button></td>
              </tr>
            `;
    }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  html += `</div>`;
  panel.innerHTML = html;

  panel.querySelectorAll('.go-client-btn').forEach(btn => {
    btn.onclick = () => {
      selectedClientId = btn.dataset.id;
      selectedCenterId = '';
      selectedEpicKey = '';
      switchPage('clients');
      refreshAll();
    };
  });

  panel.querySelectorAll('.go-epic-btn').forEach(btn => {
    btn.onclick = () => {
      selectedClientId = btn.dataset.client;
      selectedCenterId = btn.dataset.center;
      selectedEpicKey = btn.dataset.epic;
      switchPage('clients');
      refreshAll();
    };
  });

  panel.querySelectorAll('.go-product-btn').forEach(btn => {
    btn.onclick = () => {
      selectedProductId = btn.dataset.key;
      const pSearch = document.getElementById('productSearchInput');
      if (pSearch) pSearch.value = btn.dataset.key;
      switchPage('products');
      refreshAll();
    };
  });
}

function init() {
  try {
    seedData = JSON.parse(document.getElementById('seed-data').textContent);
  } catch (e) {
    document.body.innerHTML = '<pre>Error leyendo datos embebidos: ' + esc(e.message) + '</pre>';
    return;
  }
  loadPatches();
  applyPatches();
  buildIndexes();
  bindEvents();
  refreshAll();
}

init();
