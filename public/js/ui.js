/**
 * Small DOM/UI helpers: toasts, modal dialogs, context menus, storage.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

let toastWrap = null;

export function toast(title, body = '', kind = 'info', timeout = 5200) {
  if (!toastWrap) toastWrap = document.getElementById('toastWrap');
  if (!toastWrap) return;
  const node = el('div', { class: `toast ${kind}` }, [
    el('div', { class: 't-title' }, [title]),
    body ? el('div', { class: 't-body', text: body }) : null,
  ]);
  toastWrap.appendChild(node);
  const remove = () => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    node.style.transition = 'opacity .15s, transform .15s';
    setTimeout(() => node.remove(), 180);
  };
  node.addEventListener('click', remove);
  if (timeout) setTimeout(remove, timeout);
  while (toastWrap.children.length > 6) toastWrap.firstChild.remove();
  return node;
}

/* ------------------------------------------------------------------ *
 * Modal
 * ------------------------------------------------------------------ */

let modalStack = [];

/**
 * Open a modal.
 * @param {{title:string, body:HTMLElement|string, actions?:Array, width?:number}} opts
 * @returns {{close:Function, root:HTMLElement}}
 */
export function openModal(opts) {
  const backdrop = document.getElementById('modalBackdrop');
  const modal = document.getElementById('modal');
  modal.innerHTML = '';
  if (opts.width) modal.style.width = `${opts.width}px`;
  modal.style.minWidth = opts.minWidth ? `${opts.minWidth}px` : '340px';

  const close = () => {
    backdrop.classList.remove('open');
    modalStack = modalStack.filter((m) => m !== handle);
    if (!modalStack.length) backdrop.onclick = null;
  };

  const head = el('div', { class: 'modal-head' }, [
    el('span', { text: opts.title || '' }),
    el('span', { class: 'm-close', onclick: close, html: '&times;' }),
  ]);
  const body = el('div', { class: 'modal-body' });
  if (typeof opts.body === 'string') body.innerHTML = opts.body;
  else if (opts.body) body.appendChild(opts.body);

  modal.append(head, body);

  if (opts.actions?.length) {
    const foot = el('div', { class: 'modal-foot' });
    for (const a of opts.actions) {
      foot.appendChild(
        el('button', {
          class: `btn ${a.primary ? 'active' : 'ghost'}`,
          text: a.label,
          onclick: () => a.onClick?.(close),
        })
      );
    }
    modal.appendChild(foot);
  }

  backdrop.classList.add('open');
  backdrop.onclick = (e) => {
    if (e.target === backdrop && opts.dismissable !== false) close();
  };
  const handle = { close, root: modal };
  modalStack.push(handle);
  const firstInput = modal.querySelector('input, textarea, select');
  setTimeout(() => firstInput?.focus(), 30);
  return handle;
}

export function closeTopModal() {
  const top = modalStack[modalStack.length - 1];
  if (top) {
    top.close();
    return true;
  }
  return false;
}

export function anyModalOpen() {
  return modalStack.length > 0;
}

/* ------------------------------------------------------------------ *
 * Context menu
 * ------------------------------------------------------------------ */

let ctxMenuEl = null;

/**
 * Show a context menu at (x, y).
 * @param {number} x
 * @param {number} y
 * @param {Array<{label?:string, icon?:string, kbd?:string, onClick?:Function, danger?:boolean, separator?:boolean, disabled?:boolean}>} items
 */
export function showContextMenu(x, y, items) {
  // Resolve from the live DOM every time: holding a reference can go stale if
  // the shell is rebuilt.
  const menu = document.getElementById('ctxMenu');
  if (!menu) return;
  ctxMenuEl = menu;
  menu.innerHTML = '';
  for (const item of items) {
    if (item.separator) {
      menu.appendChild(el('div', { class: 'ctx-sep' }));
      continue;
    }
    const node = el('div', { class: `ctx-item ${item.danger ? 'danger' : ''} ${item.disabled ? 'hidden' : ''}` }, [
      item.icon ? icon(item.icon, 14) : el('span', { style: { width: '14px' } }),
      el('span', { text: item.label }),
      item.kbd ? el('span', { class: 'kbd', text: item.kbd }) : null,
    ]);
    if (!item.disabled) {
      node.addEventListener('click', () => {
        hideContextMenu();
        item.onClick?.();
      });
    }
    menu.appendChild(node);
  }
  menu.classList.add('open');
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 6);
  const top = Math.min(y, window.innerHeight - rect.height - 6);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, top)}px`;
}

export function hideContextMenu() {
  const menu = ctxMenuEl || document.getElementById('ctxMenu');
  if (menu) menu.classList.remove('open');
}

export function resetUiCaches() {
  ctxMenuEl = null;
  toastWrap = null;
}

// Global dismiss handlers (browser only - guarded so the module is importable
// from Node test harnesses too).
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    if (ctxMenuEl && !ctxMenuEl.contains(e.target)) hideContextMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideContextMenu();
      closeTopModal();
    }
  });
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

const PREFIX = 'tvclone:';

export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* quota or privacy mode - ignore */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      /* ignore */
    }
  },
  keys(prefix = '') {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX + prefix)) out.push(k.slice(PREFIX.length));
    }
    return out;
  },
};

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

export function debounce(fn, ms = 200) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function throttle(fn, ms = 100) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    } else {
      clearTimeout(timer);
      timer = setTimeout(() => {
        last = Date.now();
        fn(...args);
      }, ms - (now - last));
    }
  };
}

/** Simple audio beep for alerts (no external asset needed). */
export function beep(kind = 'alert') {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = (beep._ctx ||= new Ctx());
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    const freqs = kind === 'alert' ? [880, 1320] : kind === 'error' ? [220, 180] : [660];
    osc.type = 'sine';
    freqs.forEach((f, i) => osc.frequency.setValueAtTime(f, now + i * 0.11));
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.1 * freqs.length + 0.12);
    osc.start(now);
    osc.stop(now + 0.1 * freqs.length + 0.15);
  } catch {
    /* audio not available */
  }
}

export function download(filename, content, mime = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
