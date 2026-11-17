/* Yomeru guest menu — static, no build step.
 * URL: /s/<id>/?table=<n>  (s/<id>/index.html is generated per shop by the
 *      deploy workflow, with <base href="../../">), or ./?shop=<id>&table=<n>.
 * "table" is stored internally as "seat" so hotels/rooms can reuse it later.
 */
(function () {
  'use strict';

  const LANGS = ['ko', 'en', 'zh', 'ja'];
  const EXPIRY_MS = 3 * 60 * 60 * 1000;         // reset cart/history 3h after last use
  const DATA_MAX_AGE_MS = 12 * 60 * 60 * 1000;  // how long a saved copy of the menu may be shown first
  const MAX_QTY = 99;
  const LANG_KEY = 'yomeru:lang';

  const params = new URLSearchParams(location.search);
  const pathShop = (location.pathname.match(/\/s\/([A-Za-z0-9_-]+)\/?(?:index\.html)?$/) || [])[1];
  const shopId = (pathShop || params.get('shop') || 'sample').replace(/[^A-Za-z0-9_-]/g, '') || 'sample';
  let seatParam = params.get('table') || params.get('seat');
  if (seatParam && !/^[A-Za-z0-9-]{1,8}$/.test(seatParam)) seatParam = null;
  const STATE_KEY = 'yomeru:state:' + shopId;
  const DATA_KEY = 'yomeru:data:v1:' + shopId;
  const BASE_URL = location.pathname + location.search;

  const app = document.getElementById('app');
  const sheetRoot = document.getElementById('sheet-root');

  let shop = null, calls = [], lang = null, fmt = null;
  const I = {};
  let sheet = null;        // { id, opts: [], qty }
  let pendingData = null;  // fresh menu data that arrived while a sheet was open
  let view = null;         // name of the view currently on screen
  let menuScroll = 0;      // where the guest was in the menu, restored on return
  let wake = null;
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; // we restore the menu position ourselves

  /* ---------- storage ---------- */
  function load(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode etc. */ } }
  function freshState() { return { cart: [], ordered: [], rounds: 0, seat: null, updated: Date.now() }; }
  function isExpired(s) { return !s || !Array.isArray(s.cart) || !Array.isArray(s.ordered) || Date.now() - (s.updated || 0) > EXPIRY_MS; }

  let state = load(STATE_KEY);
  if (isExpired(state)) state = freshState();
  if (seatParam) state.seat = seatParam; // waiting-QR cart carries over; seat just gets filled in
  function save() { state.updated = Date.now(); store(STATE_KEY, state); }
  save();

  function detectLang() {
    const saved = load(LANG_KEY);
    if (LANGS.includes(saved)) return saved;
    const list = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || ''];
    for (const l of list) { const p = String(l).toLowerCase().slice(0, 2); if (LANGS.includes(p)) return p; }
    return null;
  }

  /* ---------- helpers ---------- */
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]); }
  function L(obj, lg) { if (!obj) return ''; if (typeof obj === 'string') return obj; lg = lg || lang; return obj[lg] || obj.en || obj.ja || ''; }
  function fill(s, vars) { if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]); return s; }
  function t(key, vars, lg) {
    let s = (I[lg || lang] || {})[key];
    if (s == null) s = (I.en || {})[key];
    if (s == null) s = key;
    return esc(fill(s, vars));
  }
  function staffT(key, vars) { return esc(fill(((I.ja || {}).staff || {})[key] || '', vars)); }
  function price(n) { return esc(fmt.format(n)); }
  function itemById(id) { return shop.items.find(i => i.id === id); }

  const ICONS = {
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    water: '<path d="M12 2.7s-6 6.3-6 11.3a6 6 0 0 0 12 0c0-5-6-11.3-6-11.3z"/>',
    receipt: '<path d="M4 2v20l3-2 3 2 2-2 2 2 3-2 3 2V2l-3 2-3-2-2 2-2-2-3 2z"/><path d="M8 9h8M8 13h6"/>',
    plate: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/>',
    towel: '<rect x="3" y="7" width="18" height="10" rx="5"/><path d="M8 12h8"/>'
  };
  function icon(name) { return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`; }

  /* ---------- order lines ---------- */
  // line = { key, id, opts: [choiceIndex per option], qty }
  function lineKey(id, opts) { return id + '|' + opts.join(','); }
  function lineItemValid(l) {
    const it = itemById(l.id);
    if (!it || !Array.isArray(l.opts)) return false;
    const os = it.options || [];
    return os.length === l.opts.length && l.opts.every((c, i) => os[i].choices[c]);
  }
  function linePrice(l) {
    const it = itemById(l.id);
    const extra = (it.options || []).reduce((s, o, i) => s + (o.choices[l.opts[i]].price || 0), 0);
    return (it.price + extra) * l.qty;
  }
  function lineName(l, lg) {
    const it = itemById(l.id);
    const name = L(it.name, lg);
    if (!l.opts.length) return name;
    const ch = (it.options || []).map((o, i) => L(o.choices[l.opts[i]], lg));
    return lg === 'ja' ? `${name}（${ch.join('・')}）` : `${name} (${ch.join(', ')})`;
  }
  function sum(lines) { return lines.reduce((s, l) => s + linePrice(l), 0); }
  function count(lines) { return lines.reduce((s, l) => s + l.qty, 0); }
  function qtyOfItem(id) { return state.cart.filter(l => l.id === id).reduce((s, l) => s + l.qty, 0); }

  function addLine(id, opts, qty) {
    const key = lineKey(id, opts);
    const l = state.cart.find(x => x.key === key);
    if (l) l.qty = Math.min(MAX_QTY, l.qty + qty); else state.cart.push({ key, id, opts: opts.slice(), qty: Math.min(MAX_QTY, qty) });
    save();
  }
  function changeQty(key, d) {
    const l = state.cart.find(x => x.key === key);
    if (!l) return;
    l.qty = Math.min(MAX_QTY, l.qty + d);
    if (l.qty <= 0) state.cart = state.cart.filter(x => x !== l);
    save();
  }
  function completeOrder() {
    for (const l of state.cart) {
      const o = state.ordered.find(x => x.key === l.key);
      if (o) o.qty += l.qty; else state.ordered.push({ key: l.key, id: l.id, opts: l.opts.slice(), qty: l.qty });
    }
    state.cart = [];
    state.rounds += 1;
    save();
    menuScroll = 0;
    home();
  }

  /* ---------- navigation ----------
   * Every in-app step forward is one history entry (state.d = how many steps
   * deep), so the phone's Back button closes a sheet or returns one screen
   * instead of leaving the site, and Back never loops between screens. */
  function route() { return location.hash.replace(/^#/, ''); }
  function depth() { return (history.state && history.state.d) || 0; }
  function go(h) {
    history.pushState({ d: depth() + 1 }, '', BASE_URL + '#' + h); // absolute: <base href> would redirect a bare '#…'
    render();
  }
  function back(fallback) {
    if (depth() > 0) { history.back(); return; }
    history.replaceState(null, '', BASE_URL + (fallback ? '#' + fallback : ''));
    render();
  }
  function home() {
    const d = depth();
    if (d > 0) { history.go(-d); return; }
    history.replaceState(null, '', BASE_URL);
    render();
  }
  function viewOf(r) {
    if (!lang || r === 'lang') return 'lang';
    if (r === 'cart') return 'cart';
    if (r === 'staff') return state.cart.length ? 'staff' : 'cart';
    if (r === 'call') return 'call';
    if (r.indexOf('call/') === 0) return calls.some(c => c.id === r.slice(5)) ? 'callshow' : 'call';
    return 'menu';
  }
  window.addEventListener('popstate', () => {
    if (sheet && !(history.state && history.state.sheet)) {
      const id = sheet.id;
      const swapped = closeSheetDom();
      if (!swapped && viewOf(route()) === view) { refreshItem(id); return; }
    }
    render();
  });
  window.addEventListener('hashchange', render);
  window.addEventListener('scroll', () => { if (view === 'menu' && !sheet) menuScroll = window.scrollY; }, { passive: true });

  /* ---------- views ---------- */
  function seatChip() {
    return state.seat
      ? `<span class="seat-chip">${t('seat', { n: esc(state.seat) })}</span>`
      : `<span class="seat-chip waiting">${t('waiting')}</span>`;
  }
  function topBar(opts) {
    const left = opts.back
      ? `<button class="icon-btn plain" data-act="back" aria-label="${t('backToMenu')}">${icon('back')}</button>`
      : '';
    const right = opts.tools ? `
      <button class="icon-btn" data-act="go" data-to="call">${icon('bell')}<span>${t('call')}</span></button>
      <button class="icon-btn" data-act="go" data-to="lang" aria-label="${t('language')}">${icon('globe')}<span>${lang.toUpperCase()}</span></button>` : '';
    return `<header class="top"><div class="wrap">${left}
      <div class="title"><h1>${opts.title}</h1>${seatChip()}</div>${right}</div></header>`;
  }

  function badge(q) { return q ? `<span class="qbadge">${q}</span>` : ''; }
  function stepper(key, qty) {
    return `<span class="stepper">
      <button data-act="qty" data-key="${esc(key)}" data-d="-1" aria-label="−">${icon('minus')}</button>
      <span class="n">${qty}</span>
      <button data-act="qty" data-key="${esc(key)}" data-d="1" aria-label="+">${icon('plus')}</button></span>`;
  }
  function qtyControl(it) {
    if (it.options && it.options.length) {
      return `${badge(qtyOfItem(it.id))}<button class="add-btn" data-act="open" data-id="${esc(it.id)}">${icon('plus')}${t('add')}</button>`;
    }
    const key = lineKey(it.id, []);
    const l = state.cart.find(x => x.key === key);
    return l ? stepper(key, l.qty)
      : `<button class="add-btn" data-act="add" data-id="${esc(it.id)}">${icon('plus')}${t('add')}</button>`;
  }
  function bottomBar() {
    const n = count(state.cart);
    if (n) return `<div class="bottom"><div class="inner"><button class="primary" data-act="go" data-to="cart">
      ${icon('bag')}<span class="grow">${t("viewCart")} · ${n === 1 && (I[lang] || {}).item1 ? t("item1") : t("items", { n })}</span><span>${price(sum(state.cart))}</span></button></div></div>`;
    if (state.ordered.length) return `<div class="bottom"><div class="inner"><button class="primary ghost" data-act="go" data-to="cart">
      ${icon('receipt')}<span class="grow">${t('viewOrders')}</span><span>${t('grandTotal')} ${price(sum(state.ordered))}</span></button></div></div>`;
    return '';
  }
  // Update one item's controls in place: keeps scroll, tab position and photos as they are.
  function refreshItem(id) {
    const it = view === 'menu' && itemById(id);
    if (!it) { render(); return; }
    const sel = window.CSS && CSS.escape ? CSS.escape(id) : id;
    app.querySelectorAll(`[data-ctl="${sel}"]`).forEach(el => { el.innerHTML = qtyControl(it); });
    app.querySelectorAll(`[data-badge="${sel}"]`).forEach(el => { el.innerHTML = badge(qtyOfItem(id)); });
    const bar = document.getElementById('bar');
    if (bar) bar.innerHTML = bottomBar();
  }

  function photoOf(it, size) {
    const p = it.photo;
    if (!p) return null;
    if (typeof p === 'string') return p;
    return size === 'large' ? (p.large || p.thumb) : (p.thumb || p.large);
  }

  function itemCard(it) {
    const src = photoOf(it, 'thumb');
    return `<article class="card" data-act="open" data-id="${esc(it.id)}">
      ${src ? `<img class="thumb" src="shops/${esc(src)}" alt="" width="88" height="88" loading="lazy" decoding="async">` : ''}
      <div class="body">
        <h3>${esc(L(it.name))}</h3>
        ${lang !== 'ja' ? `<p class="jname" lang="ja">${esc(it.name.ja)}</p>` : ''}
        ${it.desc ? `<p class="desc">${esc(L(it.desc))}</p>` : ''}
        <div class="row"><span class="price">${price(it.price)}</span><span class="ctl" data-ctl="${esc(it.id)}">${qtyControl(it)}</span></div>
      </div></article>`;
  }

  function viewMenu() {
    const n = shop.notices || {};
    const notes = [];
    if (n.otoshi && n.otoshi.enabled) notes.push(t('otoshi', { price: fmt.format(n.otoshi.price) }));
    if (n.taxIncluded === true) notes.push(t('taxIncluded'));
    if (n.taxIncluded === false) notes.push(t('taxExcluded'));
    if (n.cashOnly) notes.push(t('cashOnly'));
    if (n.lastOrder) notes.push(t('lastOrder', { time: n.lastOrder }));

    const picks = (shop.ownerPicks || []).map(itemById).filter(Boolean).slice(0, 3);
    const cats = shop.categories.filter(c => shop.items.some(i => i.category === c.id));

    return `${topBar({ title: esc(L(shop.name)), tools: true })}
    <main class="wrap">
      <div class="banner allergy" role="note">${icon('alert')}<span>${t('allergy')}</span></div>
      ${state.seat ? '' : `<div class="banner waiting">${icon('clock')}<span>${t('waitingNote')}</span></div>`}
      ${notes.length ? `<section class="notices"><h2>${t('noticeTitle')}</h2><ul>${notes.map(x => `<li>${x}</li>`).join('')}</ul></section>` : ''}

      ${picks.length ? `<h2 class="section-title">${t('ownerPicks')}${lang !== 'ja' ? '<small lang="ja">店長のおすすめ</small>' : ''}</h2>
      <div class="picks">${picks.map((it, i) => `<button class="pick" data-act="open" data-id="${esc(it.id)}">
          <span data-badge="${esc(it.id)}">${badge(qtyOfItem(it.id))}</span>
          <span class="rank">${i + 1}</span><span class="nm">${esc(L(it.name))}</span><span class="pr">${price(it.price)}</span></button>`).join('')}</div>` : ''}

      <nav class="tabs" aria-label="categories">${cats.map(c => `<button class="tab" data-act="jump" data-cat="${esc(c.id)}">${esc(L(c))}</button>`).join('')}</nav>
      ${cats.map(c => `<section class="cat" id="cat-${esc(c.id)}">
        <h2 class="section-title">${esc(L(c))}${lang !== 'ja' ? `<small lang="ja">${esc(c.ja)}</small>` : ''}</h2>
        <div class="cards">${shop.items.filter(i => i.category === c.id).map(itemCard).join('')}</div></section>`).join('')}
      <div class="spacer"></div>
    </main>
    <div id="bar">${bottomBar()}</div>`;
  }

  function viewCart() {
    const lineRow = (l, editable) => `<div class="line"><div class="info">
        <div class="nm">${esc(lineName(l, lang))}</div>
        <div class="lp">${price(linePrice(l) / l.qty)}${editable ? '' : ` × ${l.qty}`}</div></div>
        ${editable ? stepper(l.key, l.qty) : `<span class="q">${price(linePrice(l))}</span>`}</div>`;
    const hasOrdered = state.ordered.length > 0;
    return `${topBar({ title: t('cart'), back: true })}
    <main class="wrap">
      <section class="block"><h2>${t('newItems')}</h2>
        ${state.cart.length ? state.cart.map(l => lineRow(l, true)).join('') : `<div class="empty">${t('emptyCart')}</div>`}
        <div class="sum"><span>${t('thisTotal')}</span><span>${price(sum(state.cart))}</span></div></section>
      ${hasOrdered ? `<section class="block muted"><h2>${t('orderedItems')}</h2>
        ${state.ordered.map(l => lineRow(l, false)).join('')}
        <div class="sum"><span>${t('grandTotal')}</span><span>${price(sum(state.ordered) + sum(state.cart))}</span></div></section>` : ''}
      ${(hasOrdered || state.cart.length) ? `<button class="link-btn" data-act="reset">${t('reset')}</button>` : ''}
      <div class="spacer"></div>
    </main>
    <div class="bottom"><div class="inner"><button class="primary" data-act="go" data-to="staff" ${state.cart.length ? '' : 'disabled'}>${t('showStaff')}</button></div></div>`;
  }

  function viewStaff() {
    const n = shop.notices || {};
    const title = state.rounds === 0 ? staffT('order') : staffT('additional', { n: state.rounds + 1 });
    const langNames = ((I.ja || {}).staff || {}).langNames || {};
    const tax = n.taxIncluded === true ? staffT('taxIn') : n.taxIncluded === false ? staffT('taxOut') : '';
    const cnt = staffT('count', { n: count(state.cart) });
    return `<div class="staff" lang="ja">
      <header class="staff-head"><div class="wrap">
        <h1>${title}</h1>
        <div class="seat">${state.seat ? staffT('seat', { n: esc(state.seat) }) : staffT('noSeat')}</div>
        <div class="gl">${staffT('guestLang', { lang: langNames[lang] || lang })}</div>
      </div></header>
      <main class="wrap">
        ${state.cart.map(l => `<div class="s-line"><div class="info">
          <div class="ja">${esc(lineName(l, 'ja'))}</div>
          ${lang !== 'ja' ? `<div class="gn" lang="${lang}">${esc(lineName(l, lang))}</div>` : ''}</div>
          <div class="q">× ${l.qty}</div></div>`).join('')}
        <div class="s-total"><span>${staffT('total')}${cnt ? ` <span class="cnt">${cnt}</span>` : ''}</span>
          <span>${price(sum(state.cart))}${tax ? `<small>（${tax}）</small>` : ''}</span></div>
        <div class="s-note" lang="${lang}">${t('showThisScreen')}</div>
        <p class="s-hint" lang="${lang}">${t('orderDoneHint')}</p>
        <div class="s-actions">
          <button class="secondary" data-act="back" data-fb="cart"><span>${t('editOrder')}</span>${lang !== 'ja' ? `<span class="sub-ja">${t('editOrder', null, 'ja')}</span>` : ''}</button>
          <button class="primary" data-act="done"><span>${t('orderDone')}</span>${lang !== 'ja' ? `<span class="sub-ja">${t('orderDone', null, 'ja')}</span>` : ''}</button>
        </div>
      </main></div>`;
  }

  function viewCall() {
    return `${topBar({ title: t('call'), back: true })}
    <main class="wrap">
      <h2 class="section-title">${t('callTitle')}</h2>
      <div class="calls">${calls.map(c => `<button class="call-btn" data-act="go" data-to="call/${esc(c.id)}">
        ${icon(c.icon)}<span><span class="nm">${esc(L(c))}</span>${lang !== 'ja' ? `<span class="sub-ja" lang="ja">${esc(c.ja)}</span>` : ''}</span></button>`).join('')}</div>
      <p class="hint">${t('callHint')}</p>
    </main>`;
  }

  function viewCallShow(id) {
    const c = calls.find(x => x.id === id);
    return `<div class="call-show" role="dialog" aria-modal="true">
      <div class="msg" lang="ja">
        ${state.seat ? `<div class="seat">${staffT('seat', { n: esc(state.seat) })}</div>` : ''}
        <div class="ja">${esc(c.ja)}</div>
        ${lang !== 'ja' ? `<div class="gl" lang="${lang}">${esc(L(c))}</div>` : ''}
      </div>
      <button class="secondary" data-act="back" data-fb="call">${t('close')}</button></div>`;
  }

  function viewLang() {
    return `<main class="lang-screen">
      <div class="brand">YOMERU · ヨメル</div>
      <h1>Language · 언어 · 语言 · 言語</h1>
      <p class="shop" lang="ja">${esc(shop.name.ja)}</p>
      <div class="lang-list">${LANGS.map(l => `<button class="lang-btn ${l === lang ? 'on' : ''}" data-act="setlang" data-lang="${l}" lang="${l}">${esc(I[l].langName)}</button>`).join('')}</div>
    </main>`;
  }

  /* ---------- sheet (item detail / options) ---------- */
  function openSheet(id) {
    const it = itemById(id);
    if (!it || sheet) return;
    sheet = { id, opts: (it.options || []).map(() => null), qty: 1 };
    history.pushState({ d: depth() + 1, sheet: true }, '', location.href); // phone Back closes the sheet
    renderSheet();
  }
  function closeSheet() {
    if (!sheet) return;
    if (history.state && history.state.sheet) history.back(); // popstate finishes the close
    else { closeSheetDom(); render(); }
  }
  // Returns true when newer menu data was waiting and has now been applied.
  function closeSheetDom() {
    sheet = null;
    sheetRoot.innerHTML = '';
    document.body.style.overflow = '';
    if (!pendingData) return false;
    applyData(pendingData);
    pendingData = null;
    return true;
  }
  function renderSheet() {
    const it = sheet && itemById(sheet.id);
    if (!it) { closeSheet(); return; }
    const src = photoOf(it, 'large');
    const ready = sheet.opts.every(c => c !== null);
    const unit = it.price + (it.options || []).reduce((s, o, i) => s + (sheet.opts[i] !== null ? (o.choices[sheet.opts[i]].price || 0) : 0), 0);
    document.body.style.overflow = 'hidden';
    sheetRoot.innerHTML = `<div class="backdrop" data-act="close-sheet"></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(L(it.name))}">
        <div class="grab"></div>
        <button class="close" data-act="close-sheet" aria-label="${t('close')}">${icon('x')}</button>
        ${src ? `<img class="big" src="shops/${esc(src)}" alt="">` : ''}
        <div class="content">
          <h2>${esc(L(it.name))}</h2>
          ${lang !== 'ja' ? `<p class="jname" lang="ja">${esc(it.name.ja)}</p>` : ''}
          ${it.desc ? `<p class="desc">${esc(L(it.desc))}</p>` : ''}
          <span class="price">${price(unit)}</span>
          ${(it.options || []).map((o, oi) => `<div class="opt"><h3>${esc(L(o))} · <span>${t('chooseOption')}</span></h3>
            <div class="chips">${o.choices.map((c, ci) => `<button class="chip ${sheet.opts[oi] === ci ? 'on' : ''}" data-act="pick" data-o="${oi}" data-c="${ci}" aria-pressed="${sheet.opts[oi] === ci}">
              ${esc(L(c))}${lang !== 'ja' ? `<span class="sub-ja" lang="ja">${esc(c.ja)}</span>` : ''}</button>`).join('')}</div></div>`).join('')}
        </div>
        <div class="sheet-actions">
          <span class="stepper">
            <button data-act="sqty" data-d="-1" aria-label="−">${icon('minus')}</button>
            <span class="n">${sheet.qty}</span>
            <button data-act="sqty" data-d="1" aria-label="+">${icon('plus')}</button></span>
          <button class="primary" data-act="sheet-add" ${ready ? '' : 'disabled'}><span class="grow">${t('addToCart')}</span><span>${price(unit * sheet.qty)}</span></button>
        </div>
      </div>`;
  }

  /* ---------- render ---------- */
  function render() {
    if (!shop) return;
    if (isExpired(state)) { state = freshState(); if (seatParam) state.seat = seatParam; save(); menuScroll = 0; }
    const r = route();
    const name = viewOf(r);
    const prev = view;
    view = name;
    document.documentElement.lang = lang || 'ja';
    app.innerHTML = name === 'lang' ? viewLang()
      : name === 'cart' ? viewCart()
      : name === 'staff' ? viewStaff()
      : name === 'call' ? viewCall()
      : name === 'callshow' ? viewCallShow(r.slice(5))
      : viewMenu();
    // Same format as the per-shop <title> made by .github/scripts/build_site.py
    document.title = `${(shop.shortName && shop.shortName.ja) || shop.name.ja} メニュー | Menu · 메뉴 · 菜单`;
    if (prev !== name) window.scrollTo(0, name === 'menu' ? menuScroll : 0);
    keepScreenOn();
  }

  // Staff and call screens are held up for someone to read: don't let the phone dim or lock.
  function keepScreenOn() {
    const want = (view === 'staff' || view === 'callshow') && !document.hidden;
    if (want && !wake && navigator.wakeLock) {
      navigator.wakeLock.request('screen').then(w => {
        wake = w;
        w.addEventListener('release', () => { if (wake === w) wake = null; });
        if (view !== 'staff' && view !== 'callshow') w.release().catch(() => {});
      }).catch(() => {});
    } else if (!want && wake) {
      wake.release().catch(() => {});
      wake = null;
    }
  }

  // Web fonts load after the first paint and only for the languages on screen.
  function loadFonts() {
    const fam = ['Noto+Sans+JP:wght@400;700'];
    if (lang === 'ko') fam.push('Noto+Sans+KR:wght@400;700');
    if (lang === 'zh') fam.push('Noto+Sans+SC:wght@400;700');
    const href = 'https://fonts.googleapis.com/css2?family=' + fam.join('&family=') + '&display=swap';
    if ([].some.call(document.styleSheets, s => s.href === href) || document.querySelector(`link[href="${href}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }

  /* ---------- events ---------- */
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const d = el.dataset;
    switch (d.act) {
      case 'go': go(d.to); break;
      case 'back': back(d.fb); break;
      case 'setlang':
        lang = d.lang; store(LANG_KEY, lang); loadFonts();
        if (route() === 'lang') back(); else render();
        break;
      case 'open': openSheet(d.id); break;
      case 'add': addLine(d.id, [], 1); refreshItem(d.id); break;
      case 'qty':
        changeQty(d.key, Number(d.d));
        if (view === 'menu') refreshItem(d.key.split('|')[0]); else render();
        break;
      case 'jump': {
        const sec = document.getElementById('cat-' + d.cat);
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }
      case 'close-sheet': closeSheet(); break;
      case 'pick': if (sheet) { sheet.opts[Number(d.o)] = Number(d.c); renderSheet(); } break;
      case 'sqty': if (sheet) { sheet.qty = Math.max(1, Math.min(MAX_QTY, sheet.qty + Number(d.d))); renderSheet(); } break;
      case 'sheet-add':
        if (sheet && sheet.opts.every(c => c !== null)) { addLine(sheet.id, sheet.opts, sheet.qty); closeSheet(); }
        break;
      case 'done': completeOrder(); break;
      case 'reset':
        if (window.confirm((I[lang] || I.en).resetConfirm)) { state = freshState(); if (seatParam) state.seat = seatParam; save(); render(); }
        break;
      case 'reload': location.reload(); break;
    }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheet) closeSheet(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !shop) return;
    if (isExpired(state)) render(); else keepScreenOn();
  });

  /* ---------- data ----------
   * The menu is shown from a copy saved on the phone first (instant on a slow
   * connection, e.g. waiting QR → table QR), then refreshed from the network. */
  function getJSON(url) { return fetch(url, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }); }
  function fetchData() {
    return Promise.all([
      getJSON('shops/' + shopId + '.json'),
      getJSON('i18n/calls.json'),
      ...LANGS.map(l => getJSON('i18n/' + l + '.json'))
    ]).then(([s, c, ...langs]) => {
      const i18n = {};
      LANGS.forEach((l, i) => { i18n[l] = langs[i]; });
      return { shop: s, calls: c, i18n };
    });
  }
  function validData(d) {
    return d && d.shop && Array.isArray(d.shop.items) && Array.isArray(d.shop.categories) && d.shop.name
      && Array.isArray(d.calls) && d.i18n && LANGS.every(l => d.i18n[l]);
  }
  function applyData(d) {
    shop = d.shop;
    calls = d.calls;
    LANGS.forEach(l => { I[l] = d.i18n[l]; });
    if (shop.accent && /^#[0-9a-fA-F]{3,8}$/.test(shop.accent)) document.documentElement.style.setProperty('--accent', shop.accent);
    fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: shop.currency || 'JPY', maximumFractionDigits: 0 });
    state.cart = state.cart.filter(lineItemValid);
    state.ordered = state.ordered.filter(lineItemValid);
    save();
  }
  function start() {
    lang = detectLang();
    render();
    setTimeout(loadFonts, 60); // after the first paint; a timer also works when the tab is in the background
  }
  function showError(err) {
    console.error(err);
    const msgs = {
      ko: ['메뉴를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.', '다시 시도'],
      en: ["Couldn't load the menu. Please check your connection.", 'Try again'],
      zh: ['菜单加载失败，请检查网络连接。', '重试'],
      ja: ['メニューを読み込めませんでした。通信状況をご確認ください。', '再読み込み']
    };
    const m = msgs[detectLang() || 'en'];
    app.innerHTML = `<div class="loading"><span>${esc(m[0])}</span><button class="retry" data-act="reload">${esc(m[1])}</button></div>`;
  }

  let started = false;
  const saved = load(DATA_KEY);
  const savedJson = saved && validData(saved.d) && Date.now() - (saved.at || 0) < DATA_MAX_AGE_MS ? JSON.stringify(saved.d) : null;
  if (savedJson) {
    try { applyData(saved.d); start(); started = true; } catch (e) { shop = null; }
  }
  fetchData().then(d => {
    if (!validData(d)) throw new Error('bad menu data');
    store(DATA_KEY, { at: Date.now(), d });
    if (started && JSON.stringify(d) === savedJson) return;
    if (sheet) { pendingData = d; return; }
    applyData(d);
    if (started) render(); else { start(); started = true; }
  }).catch(err => { if (!started) showError(err); else console.warn(err); });
})();
