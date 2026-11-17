/* Yomeru guest menu — static, no build step.
 * URL: /s/<id>/?table=<n>  (s/<id>/index.html is generated per shop by the
 *      deploy workflow, with <base href="../../">), or ./?shop=<id>&table=<n>.
 * "table" is stored internally as "seat" so hotels/rooms can reuse it later.
 */
(function () {
  'use strict';

  const LANGS = ['ko', 'en', 'zh', 'ja'];
  const EXPIRY_MS = 3 * 60 * 60 * 1000; // reset cart/history 3h after last use
  const LANG_KEY = 'yomeru:lang';

  const params = new URLSearchParams(location.search);
  const pathShop = (location.pathname.match(/\/s\/([A-Za-z0-9_-]+)\/?(?:index\.html)?$/) || [])[1];
  const shopId = (pathShop || params.get('shop') || 'sample').replace(/[^A-Za-z0-9_-]/g, '') || 'sample';
  let seatParam = params.get('table') || params.get('seat');
  if (seatParam && !/^[A-Za-z0-9-]{1,8}$/.test(seatParam)) seatParam = null;
  const STATE_KEY = 'yomeru:state:' + shopId;

  const app = document.getElementById('app');
  const sheetRoot = document.getElementById('sheet-root');

  let shop = null, calls = [], lang = null, fmt = null;
  const I = {};
  let sheet = null; // { id, opts: [], qty }

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
  function t(key, vars, lg) {
    let s = (I[lg || lang] || {})[key];
    if (s == null) s = (I.en || {})[key];
    if (s == null) s = key;
    if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
    return esc(s);
  }
  function staffT(key, vars) {
    let s = ((I.ja || {}).staff || {})[key] || key;
    if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
    return esc(s);
  }
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
    towel: '<rect x="3" y="7" width="18" height="10" rx="5"/><path d="M8 12h8"/>',
    star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>'
  };
  function icon(name) { return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`; }

  /* ---------- order lines ---------- */
  // line = { key, id, opts: [choiceIndex per option], qty }
  function lineKey(id, opts) { return id + '|' + opts.join(','); }
  function lineItemValid(l) {
    const it = itemById(l.id);
    if (!it) return false;
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
    if (l) l.qty += qty; else state.cart.push({ key, id, opts: opts.slice(), qty });
    save();
  }
  function changeQty(key, d) {
    const l = state.cart.find(x => x.key === key);
    if (!l) return;
    l.qty += d;
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
    history.replaceState(null, '', location.pathname + location.search);
    render();
    window.scrollTo(0, 0);
  }

  /* ---------- navigation ---------- */
  function route() { return location.hash.replace(/^#/, ''); }
  function go(h) {
    if (h) { if (route() === h) render(); else location.hash = h; }
    else { history.pushState(null, '', location.pathname + location.search); render(); }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', render);
  window.addEventListener('popstate', render);

  /* ---------- views ---------- */
  function seatChip() {
    return state.seat
      ? `<span class="seat-chip">${t('seat', { n: esc(state.seat) })}</span>`
      : `<span class="seat-chip waiting">${t('waiting')}</span>`;
  }
  function topBar(opts) {
    const left = opts.back
      ? `<button class="icon-btn plain" data-act="nav" data-to="${opts.back === 'menu' ? '' : opts.back}" aria-label="${t('backToMenu')}">${icon('back')}</button>`
      : '';
    const right = opts.tools ? `
      <button class="icon-btn" data-act="nav" data-to="call">${icon('bell')}<span>${t('call')}</span></button>
      <button class="icon-btn" data-act="nav" data-to="lang" aria-label="${t('language')}">${icon('globe')}<span>${lang.toUpperCase()}</span></button>` : '';
    return `<header class="top"><div class="wrap">${left}
      <div class="title"><h1>${opts.title}</h1>${seatChip()}</div>${right}</div></header>`;
  }

  function qtyControl(it) {
    if (it.options && it.options.length) {
      const q = qtyOfItem(it.id);
      return `<span style="display:inline-flex;align-items:center;gap:8px">${q ? `<span class="qbadge">${q}</span>` : ''}
        <button class="add-btn" data-act="open" data-id="${esc(it.id)}">${icon('plus')}${t('add')}</button></span>`;
    }
    const key = lineKey(it.id, []);
    const l = state.cart.find(x => x.key === key);
    if (!l) return `<button class="add-btn" data-act="add" data-id="${esc(it.id)}">${icon('plus')}${t('add')}</button>`;
    return `<span class="stepper">
      <button data-act="qty" data-key="${esc(key)}" data-d="-1" aria-label="-">${icon('minus')}</button>
      <span class="n">${l.qty}</span>
      <button data-act="qty" data-key="${esc(key)}" data-d="1" aria-label="+">${icon('plus')}</button></span>`;
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
      ${src ? `<img class="thumb" src="shops/${esc(src)}" alt="" loading="lazy" decoding="async">` : ''}
      <div class="body">
        <h3>${esc(L(it.name))}</h3>
        ${lang !== 'ja' ? `<p class="jname" lang="ja">${esc(it.name.ja)}</p>` : ''}
        ${it.desc ? `<p class="desc">${esc(L(it.desc))}</p>` : ''}
        <div class="row"><span class="price">${price(it.price)}</span>${qtyControl(it)}</div>
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
    const cartN = count(state.cart);

    return `${topBar({ title: esc(L(shop.name)), tools: true })}
    <main class="wrap">
      <div class="banner allergy" role="note">${icon('alert')}<span>${t('allergy')}</span></div>
      ${state.seat ? '' : `<div class="banner waiting">${icon('clock')}<span>${t('waitingNote')}</span></div>`}
      ${notes.length ? `<section class="notices"><h2>${t('noticeTitle')}</h2><ul>${notes.map(x => `<li>${x}</li>`).join('')}</ul></section>` : ''}

      ${picks.length ? `<h2 class="section-title">${t('ownerPicks')}${lang !== 'ja' ? '<small lang="ja">店長のおすすめ</small>' : ''}</h2>
      <div class="picks">${picks.map((it, i) => {
        const q = qtyOfItem(it.id);
        return `<button class="pick" data-act="open" data-id="${esc(it.id)}">
          ${q ? `<span class="qbadge">${q}</span>` : ''}
          <span class="rank">${i + 1}</span><span class="nm">${esc(L(it.name))}</span><span class="pr">${price(it.price)}</span></button>`;
      }).join('')}</div>` : ''}

      <nav class="tabs" aria-label="categories">${cats.map(c => `<button class="tab" data-act="jump" data-cat="${esc(c.id)}">${esc(L(c))}</button>`).join('')}</nav>
      ${cats.map(c => `<section class="cat" id="cat-${esc(c.id)}">
        <h2 class="section-title">${esc(L(c))}${lang !== 'ja' ? `<small lang="ja">${esc(c.ja)}</small>` : ''}</h2>
        <div class="cards">${shop.items.filter(i => i.category === c.id).map(itemCard).join('')}</div></section>`).join('')}
      <div class="spacer"></div>
    </main>
    ${cartN ? `<div class="bottom"><div class="inner"><button class="primary" data-act="nav" data-to="cart">
      ${icon('bag')}<span class="grow">${t('viewCart')} · ${t('items', { n: cartN })}</span><span>${price(sum(state.cart))}</span></button></div></div>`
      : state.ordered.length ? `<div class="bottom"><div class="inner"><button class="primary ghost" data-act="nav" data-to="cart">
      ${icon('receipt')}<span class="grow">${t('viewOrders')}</span><span>${t('grandTotal')} ${price(sum(state.ordered))}</span></button></div></div>` : ''}`;
  }

  function viewCart() {
    const lineRow = (l, editable) => `<div class="line"><div class="info">
        <div class="nm">${esc(lineName(l, lang))}</div>
        <div class="lp">${price(linePrice(l) / l.qty)}${editable ? '' : ` × ${l.qty}`}</div></div>
        ${editable ? `<span class="stepper">
          <button data-act="qty" data-key="${esc(l.key)}" data-d="-1" aria-label="-">${icon('minus')}</button>
          <span class="n">${l.qty}</span>
          <button data-act="qty" data-key="${esc(l.key)}" data-d="1" aria-label="+">${icon('plus')}</button></span>`
          : `<span class="q">${price(linePrice(l))}</span>`}</div>`;
    const hasOrdered = state.ordered.length > 0;
    return `${topBar({ title: t('cart'), back: 'menu' })}
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
    <div class="bottom"><div class="inner"><button class="primary" data-act="nav" data-to="staff" ${state.cart.length ? '' : 'disabled'}>${t('showStaff')}</button></div></div>`;
  }

  function viewStaff() {
    if (!state.cart.length) return viewCart();
    const n = shop.notices || {};
    const title = state.rounds === 0 ? staffT('order') : staffT('additional', { n: state.rounds + 1 });
    const langNames = ((I.ja || {}).staff || {}).langNames || {};
    const tax = n.taxIncluded === true ? staffT('taxIn') : n.taxIncluded === false ? staffT('taxOut') : '';
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
        <div class="s-total"><span>${staffT('total')}</span><span>${price(sum(state.cart))}${tax ? `<small>（${tax}）</small>` : ''}</span></div>
        <div class="s-note" lang="${lang}">${t('showThisScreen')}</div>
        <p class="s-hint" lang="${lang}">${t('orderDoneHint')}</p>
        <div class="s-actions">
          <button class="secondary" data-act="nav" data-to="cart"><span>${t('editOrder')}</span>${lang !== 'ja' ? `<span class="sub-ja">${t('editOrder', null, 'ja')}</span>` : ''}</button>
          <button class="primary" data-act="done"><span>${t('orderDone')}</span>${lang !== 'ja' ? `<span class="sub-ja">${t('orderDone', null, 'ja')}</span>` : ''}</button>
        </div>
      </main></div>`;
  }

  function viewCall() {
    return `${topBar({ title: t('call'), back: 'menu' })}
    <main class="wrap">
      <h2 class="section-title">${t('callTitle')}</h2>
      <div class="calls">${calls.map(c => `<button class="call-btn" data-act="nav" data-to="call/${esc(c.id)}">
        ${icon(c.icon)}<span><span class="nm">${esc(L(c))}</span>${lang !== 'ja' ? `<span class="sub-ja" style="display:block">${esc(c.ja)}</span>` : ''}</span></button>`).join('')}</div>
      <p class="hint">${t('callHint')}</p>
    </main>`;
  }

  function viewCallShow(id) {
    const c = calls.find(x => x.id === id);
    if (!c) return viewCall();
    return `<div class="call-show" role="dialog" aria-modal="true">
      <div class="msg" lang="ja">
        ${state.seat ? `<div class="seat">${staffT('seat', { n: esc(state.seat) })}</div>` : ''}
        <div class="ja">${esc(c.ja)}</div>
        ${lang !== 'ja' ? `<div class="gl" lang="${lang}">${esc(L(c))}</div>` : ''}
      </div>
      <button class="secondary" data-act="nav" data-to="call">${t('close')}</button></div>`;
  }

  function viewLang() {
    return `<main class="lang-screen">
      <div class="brand">YOMERU · ヨメル</div>
      <h1>Language · 언어 · 语言 · 言語</h1>
      <p class="shop">${esc(shop.name.ja)}</p>
      <div class="lang-list">${LANGS.map(l => `<button class="lang-btn ${l === lang ? 'on' : ''}" data-act="setlang" data-lang="${l}" lang="${l}">${esc(I[l].langName)}</button>`).join('')}</div>
    </main>`;
  }

  /* ---------- sheet (item detail / options) ---------- */
  function openSheet(id) {
    const it = itemById(id);
    if (!it) return;
    sheet = { id, opts: (it.options || []).map(() => null), qty: 1 };
    renderSheet();
  }
  function closeSheet() { sheet = null; sheetRoot.innerHTML = ''; document.body.style.overflow = ''; }
  function renderSheet() {
    if (!sheet) return closeSheet();
    const it = itemById(sheet.id);
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
          ${(it.options || []).map((o, oi) => `<div class="opt"><h3>${esc(L(o))} · <span style="font-weight:400;color:var(--muted)">${t('chooseOption')}</span></h3>
            <div class="chips">${o.choices.map((c, ci) => `<button class="chip ${sheet.opts[oi] === ci ? 'on' : ''}" data-act="pick" data-o="${oi}" data-c="${ci}" aria-pressed="${sheet.opts[oi] === ci}">
              ${esc(L(c))}${lang !== 'ja' ? `<span class="sub-ja">${esc(c.ja)}</span>` : ''}</button>`).join('')}</div></div>`).join('')}
        </div>
        <div class="sheet-actions">
          <span class="stepper">
            <button data-act="sqty" data-d="-1" aria-label="-">${icon('minus')}</button>
            <span class="n">${sheet.qty}</span>
            <button data-act="sqty" data-d="1" aria-label="+">${icon('plus')}</button></span>
          <button class="primary" data-act="sheet-add" ${ready ? '' : 'disabled'}><span class="grow">${t('addToCart')}</span><span>${price(unit * sheet.qty)}</span></button>
        </div>
      </div>`;
  }

  /* ---------- render ---------- */
  function render() {
    if (isExpired(state)) { state = freshState(); if (seatParam) state.seat = seatParam; save(); }
    const r = route();
    document.documentElement.lang = lang || 'ja';
    let html;
    if (!lang || r === 'lang') html = viewLang();
    else if (r === 'cart') html = viewCart();
    else if (r === 'staff') html = viewStaff();
    else if (r === 'call') html = viewCall();
    else if (r.startsWith('call/')) html = viewCallShow(r.slice(5));
    else html = viewMenu();
    app.innerHTML = html;
    document.title = shop ? `${L(shop.name)} · Yomeru` : 'Yomeru';
  }

  /* ---------- events ---------- */
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const d = el.dataset;
    switch (d.act) {
      case 'nav': closeSheet(); go(d.to); break;
      case 'setlang': lang = d.lang; store(LANG_KEY, lang); go(''); break;
      case 'open': openSheet(d.id); break;
      case 'add': addLine(d.id, [], 1); render(); break;
      case 'qty': changeQty(d.key, Number(d.d)); render(); break;
      case 'jump': {
        const sec = document.getElementById('cat-' + d.cat);
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }
      case 'close-sheet': closeSheet(); break;
      case 'pick': sheet.opts[Number(d.o)] = Number(d.c); renderSheet(); break;
      case 'sqty': sheet.qty = Math.max(1, Math.min(99, sheet.qty + Number(d.d))); renderSheet(); break;
      case 'sheet-add':
        if (sheet && sheet.opts.every(c => c !== null)) { addLine(sheet.id, sheet.opts, sheet.qty); closeSheet(); render(); }
        break;
      case 'done': completeOrder(); break;
      case 'reset':
        if (window.confirm((I[lang] || I.en).resetConfirm)) { state = freshState(); if (seatParam) state.seat = seatParam; save(); render(); }
        break;
    }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheet) closeSheet(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && shop && isExpired(state)) render(); });

  /* ---------- boot ---------- */
  function getJSON(url) { return fetch(url, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }); }

  Promise.all([
    getJSON('shops/' + shopId + '.json'),
    getJSON('i18n/calls.json'),
    ...LANGS.map(l => getJSON('i18n/' + l + '.json'))
  ]).then(([s, c, ...langs]) => {
    shop = s;
    calls = c;
    LANGS.forEach((l, i) => { I[l] = langs[i]; });
    if (shop.accent && /^#[0-9a-fA-F]{3,8}$/.test(shop.accent)) document.documentElement.style.setProperty('--accent', shop.accent);
    fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: shop.currency || 'JPY', maximumFractionDigits: 0 });
    lang = detectLang();
    state.cart = state.cart.filter(lineItemValid);
    state.ordered = state.ordered.filter(lineItemValid);
    save();
    render();
  }).catch(err => {
    console.error(err);
    const msgs = {
      ko: '메뉴를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.',
      en: "Couldn't load the menu. Please try again in a moment.",
      zh: '菜单加载失败，请稍后再试。',
      ja: 'メニューを読み込めませんでした。しばらくしてからもう一度お試しください。'
    };
    app.innerHTML = `<div class="loading" style="padding:16px;text-align:center">${esc(msgs[detectLang() || 'en'])}</div>`;
  });
})();
