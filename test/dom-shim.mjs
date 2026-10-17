/**
 * Minimal DOM/canvas shim so the real Chart class can be exercised in Node.
 * Only implements what the chart engine actually touches.
 */

class ClassList {
  constructor(node) {
    this.node = node;
    this.set = new Set();
  }
  add(...names) {
    for (const n of names) this.set.add(n);
    this._sync();
  }
  remove(...names) {
    for (const n of names) this.set.delete(n);
    this._sync();
  }
  toggle(name, force) {
    const want = force === undefined ? !this.set.has(name) : !!force;
    if (want) this.set.add(name);
    else this.set.delete(name);
    this._sync();
    return want;
  }
  contains(name) {
    return this.set.has(name);
  }
  _sync() {
    this.node._className = [...this.set].join(' ');
  }
}

class Style {
  constructor() {
    this._props = {};
  }
  setProperty(k, v) {
    this._props[k] = v;
  }
  get cssText() {
    return Object.entries(this._props)
      .map(([k, v]) => `${k}:${v}`)
      .join(';');
  }
}

class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = new Style();
    this.dataset = {};
    this._className = '';
    this.classList = new ClassList(this);
    this._listeners = new Map();
    this._text = '';
    this.className = '';
  }

  get classListRef() {
    return this.classList;
  }

  set className(v) {
    this._className = String(v);
    this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get className() {
    return this._className;
  }

  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  get textContent() {
    return this._text || this.children.map((c) => c.textContent).join('');
  }

  set innerHTML(v) {
    this._html = String(v);
    if (v === '') {
      this.children = [];
      this.childNodes = [];
    }
  }
  get innerHTML() {
    return this._html || '';
  }

  appendChild(node) {
    if (!node) return node;
    node.parentNode = this;
    this.children.push(node);
    this.childNodes.push(node);
    return node;
  }
  append(...nodes) {
    for (const n of nodes) {
      if (n === null || n === undefined) continue;
      if (typeof n === 'string') {
        const t = new Element('#text');
        t.textContent = n;
        this.appendChild(t);
      } else this.appendChild(n);
    }
  }
  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) {
      this.children.splice(i, 1);
      this.childNodes.splice(i, 1);
    }
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  insertBefore(node, ref) {
    const i = this.children.indexOf(ref);
    if (i < 0) return this.appendChild(node);
    node.parentNode = this;
    this.children.splice(i, 0, node);
    return node;
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }
  getAttribute(k) {
    return this.attributes[k] ?? null;
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type) || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatch(type, event = {}) {
    for (const fn of this._listeners.get(type) || []) fn({ type, target: this, preventDefault() {}, stopPropagation() {}, ...event });
  }
  dispatchEvent(event) {
    this.dispatch(event.type, event);
    return true;
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  closest() {
    return null;
  }
  getBoundingClientRect() {
    return { x: 0, y: 0, width: this._width || 1200, height: this._height || 700, top: 0, left: 0, right: this._width || 1200, bottom: this._height || 700 };
  }
  get offsetWidth() {
    return this._width || 200;
  }
  get offsetHeight() {
    return this._height || 100;
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  focus() {
    global.document.activeElement = this;
  }
  blur() {
    global.document.activeElement = null;
  }
  getContext() {
    return null;
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get clientWidth() {
    return this._width || 1200;
  }
  get clientHeight() {
    return this._height || 700;
  }
}

/** Records every 2D call so tests can assert what was drawn. */
class RecordingContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.calls = [];
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.font = '';
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this.globalAlpha = 1;
    this.lineJoin = 'miter';
    this.lineCap = 'butt';
    this._record('init');
  }
  _record(name, ...args) {
    this.calls.push({ name, args });
  }
  setTransform(...a) {
    this._record('setTransform', ...a);
  }
  save() {
    this._record('save');
  }
  restore() {
    this._record('restore');
  }
  clearRect(...a) {
    this._record('clearRect', ...a);
  }
  fillRect(...a) {
    this._record('fillRect', ...a);
  }
  strokeRect(...a) {
    this._record('strokeRect', ...a);
  }
  beginPath() {
    this._record('beginPath');
  }
  closePath() {
    this._record('closePath');
  }
  moveTo(...a) {
    this._record('moveTo', ...a);
  }
  lineTo(...a) {
    this._record('lineTo', ...a);
  }
  arc(...a) {
    this._record('arc', ...a);
  }
  arcTo(...a) {
    this._record('arcTo', ...a);
  }
  fill() {
    this._record('fill');
  }
  stroke() {
    this._record('stroke');
  }
  clip() {
    this._record('clip');
  }
  rect(...a) {
    this._record('rect', ...a);
  }
  setLineDash(a) {
    this._record('setLineDash', a);
  }
  fillText(text, x, y) {
    this._record('fillText', text, x, y);
  }
  measureText(text) {
    return { width: String(text).length * 6.5 };
  }
  createLinearGradient(...a) {
    this._record('createLinearGradient', ...a);
    return { addColorStop: (o, c) => this._record('addColorStop', o, c) };
  }
  drawImage(...a) {
    this._record('drawImage', ...a);
  }
  /** Count of draw operations, ignoring state changes. */
  drawOps() {
    const draws = new Set(['fillRect', 'strokeRect', 'fill', 'stroke', 'fillText', 'lineTo', 'moveTo', 'arc', 'drawImage']);
    return this.calls.filter((c) => draws.has(c.name)).length;
  }
  texts() {
    return this.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
  }
  countOf(name) {
    return this.calls.filter((c) => c.name === name).length;
  }
}

class CanvasElement extends Element {
  constructor() {
    super('canvas');
    this.width = 300;
    this.height = 150;
  }
  getContext(kind) {
    if (kind !== '2d') return null;
    if (!this._ctx) this._ctx = new RecordingContext2D(this);
    return this._ctx;
  }
  toBlob(cb) {
    cb(null);
  }
}

export function installDomShim({ width = 1400, height = 800 } = {}) {
  const store = new Map();

  const document = {
    createElement(tag) {
      const el = String(tag).toLowerCase() === 'canvas' ? new CanvasElement() : new Element(tag);
      el._width = width;
      el._height = height;
      return el;
    },
    createElementNS(_ns, tag) {
      return document.createElement(tag);
    },
    createTextNode(text) {
      const el = new Element('#text');
      el.textContent = text;
      return el;
    },
    createDocumentFragment() {
      return new Element('#fragment');
    },
    querySelector(sel) {
      return store.get(sel) || null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById(id) {
      return store.get(`#${id}`) || null;
    },
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
    body: new Element('body'),
    documentElement: new Element('html'),
    hidden: false,
    _register(sel, node) {
      store.set(sel, node);
      return node;
    },
  };

  const win = {
    devicePixelRatio: 2,
    innerWidth: width,
    innerHeight: height,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    localStorage: {
      _m: new Map(),
      getItem(k) {
        return this._m.has(k) ? this._m.get(k) : null;
      },
      setItem(k, v) {
        this._m.set(k, String(v));
      },
      removeItem(k) {
        this._m.delete(k);
      },
      key(i) {
        return [...this._m.keys()][i] ?? null;
      },
      get length() {
        return this._m.size;
      },
    },
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    Intl,
    Date,
    Math,
    JSON,
    AudioContext: undefined,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };

  global.window = win;
  global.document = document;
  global.localStorage = win.localStorage;
  global.CustomEvent = win.CustomEvent;
  global.ResizeObserver = class ResizeObserver {
    constructor(cb) {
      this.cb = cb;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  global.requestAnimationFrame = win.requestAnimationFrame;
  // navigator and location are read-only globals in modern Node; patch defensively.
  try {
    Object.defineProperty(global, 'navigator', { value: { userAgent: 'node-shim' }, configurable: true, writable: true });
  } catch {
    /* keep the built-in navigator */
  }
  try {
    Object.defineProperty(global, 'location', { value: { href: 'http://localhost/', search: '', hash: '' }, configurable: true, writable: true });
  } catch {
    /* ignore */
  }
  global.URL ||= URL;

  return { document, window: win, Element, CanvasElement, RecordingContext2D };
}

export { Element, CanvasElement, RecordingContext2D };
