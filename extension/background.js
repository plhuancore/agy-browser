// agy browser bridge: connects to the agy-browser MCP hub on localhost and
// executes tool calls in this Chrome using chrome.debugger (CDP) and
// chrome.scripting. Tool names match src/tools.rs.

const PORT = 8765;
const CONSOLE_LIMIT = 300;
const GROUP_TITLE = 'agy-browser';
// Glowing border + simulated cursor on tabs agy is driving. Set to false for zero visual overhead.
const SHOW_OVERLAY = true;
// Tools that don't act on a page, so they shouldn't light it up.
const NO_OVERLAY = new Set(['tabs_list', 'tab_close']);

let ws = null;
// Each agy session (one MCP server process) drives its own current tab, so parallel
// agents don't steal each other's tab. Tools receive their session as p._session.
const currentTabs = {};
// Chrome suspends idle service workers; keep current tabs across restarts.
const restored = chrome.storage.session.get('currentTabs').then((s) => {
  for (const [session, tabId] of Object.entries(s.currentTabs || {})) currentTabs[session] ??= tabId;
});
const currentTab = (p) => currentTabs[p._session] ?? null;
function setCurrentTab(p, id) {
  if (id == null) delete currentTabs[p._session];
  else currentTabs[p._session] = id;
  chrome.storage.session.set({ currentTabs });
}
const attached = new Set();
const consoleLogs = new Map(); // tabId -> [{ level, text }]

// ---------------------------------------------------------------- connection

let probing = false;

async function connect() {
  if (probing || (ws && ws.readyState <= WebSocket.OPEN)) return;
  // Probe first: Chrome logs a refused WebSocket as an extension error, a caught fetch it doesn't.
  probing = true;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/ping`, { cache: 'no-store' });
    if (!res.headers.has('x-agy-browser')) throw new Error('port is used by another service');
  } catch {
    setTimeout(connect, 2000);
    return;
  } finally {
    probing = false;
  }
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ext`);
  ws = sock;
  sock.onopen = () => setBadge(true);
  sock.onerror = () => {};
  sock.onclose = () => {
    if (ws === sock) ws = null;
    setBadge(false);
    setTimeout(connect, 2000);
  };
  sock.onmessage = (ev) => onRequest(sock, ev.data);
}

async function onRequest(sock, data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (msg.id == null) return;
  await restored;
  const params = { ...msg.params, _session: msg.session || 'default' };
  const lightUp = !NO_OVERLAY.has(msg.method);
  const before = params.tabId ?? currentTab(params);
  if (lightUp && before != null) overlay(before, { type: 'show' });
  let reply;
  try {
    const tool = TOOLS[msg.method];
    if (!tool) throw new Error(`Unknown tool: ${msg.method}`);
    reply = { id: msg.id, result: await tool(params) };
  } catch (e) {
    reply = { id: msg.id, error: e?.message || String(e) };
  }
  // Navigation replaces the page (and its overlay), so light the tab up again afterwards.
  const after = currentTab(params);
  if (lightUp && after != null) overlay(after, { type: 'show' });
  if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(reply));
}

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
}

// Traffic every 20s keeps the service worker alive while connected; the alarm
// wakes it up to reconnect after Chrome has suspended it.
setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) ws.send('{"type":"keepalive"}');
}, 20000);
chrome.alarms.create('agy-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// ------------------------------------------------------------------- helpers

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolveTab(p) {
  const id = p.tabId ?? currentTab(p);
  if (id != null) {
    try {
      const tab = await chrome.tabs.get(id);
      if (tab.id !== currentTab(p)) setCurrentTab(p, tab.id);
      return tab;
    } catch {
      if (p.tabId != null) throw new Error(`Tab ${p.tabId} not found`);
    }
  }
  // Never fall back to the user's active tab: it may belong to them or another agent's group.
  throw new Error(
    'This session has no tab yet. Use navigate or tab_new to open one in the agy-browser group, ' +
      'or tabs_list + tab_select to work in an existing tab.',
  );
}

// Put a tab in this window's "agy-browser" group, creating the group if needed.
async function addToGroup(tab) {
  try {
    const [group] = await chrome.tabGroups.query({ windowId: tab.windowId, title: GROUP_TITLE });
    if (group) {
      await chrome.tabs.group({ groupId: group.id, tabIds: tab.id });
    } else {
      const groupId = await chrome.tabs.group({ tabIds: tab.id, createProperties: { windowId: tab.windowId } });
      await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'blue' });
    }
  } catch {
    // Popup and app windows can't hold groups; the tab still works ungrouped.
  }
}

const cdp = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

async function attach(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    if (!/already attached/i.test(e.message)) throw e;
  }
  attached.add(tabId);
  await cdp(tabId, 'Runtime.enable');
}

chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  consoleLogs.delete(tabId);
  const sessions = Object.keys(currentTabs).filter((s) => currentTabs[s] === tabId);
  for (const s of sessions) delete currentTabs[s];
  if (sessions.length) chrome.storage.session.set({ currentTabs });
});

const fmtArg = (a) =>
  a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : a.description ?? a.type;

chrome.debugger.onEvent.addListener(({ tabId }, method, p) => {
  let entry;
  if (method === 'Runtime.consoleAPICalled') entry = { level: p.type, text: p.args.map(fmtArg).join(' ') };
  else if (method === 'Runtime.exceptionThrown')
    entry = { level: 'exception', text: p.exceptionDetails.exception?.description || p.exceptionDetails.text };
  else return;
  const list = consoleLogs.get(tabId) || [];
  list.push(entry);
  if (list.length > CONSOLE_LIMIT) list.shift();
  consoleLogs.set(tabId, list);
});

async function inPage(tabId, func, ...args) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  const out = res?.result;
  if (out?.error) throw new Error(out.error);
  return out;
}

function waitLoad(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeout);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') done();
    }
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// After an input event: if it started a navigation, wait for the new page.
async function settle(tabId) {
  await sleep(120);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.status === 'loading') await waitLoad(tabId, 10000);
}

async function locate(tabId, ref) {
  return inPage(tabId, pageLocate, ref);
}

function overlay(tabId, cmd) {
  if (!SHOW_OVERLAY) return Promise.resolve();
  return chrome.scripting.executeScript({ target: { tabId }, func: pageOverlay, args: [cmd] }).catch(() => {});
}

// Glide the simulated cursor to (x, y) and give it time to arrive before acting there.
async function moveCursor(tabId, x, y) {
  if (!SHOW_OVERLAY) return;
  await overlay(tabId, { type: 'move', x, y });
  await sleep(180);
}

async function mouseClick(tabId, x, y, button = 'left', count = 1) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let i = 1; i <= count; i++) {
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i });
  }
}

const KEYS = {
  Enter: [13, '\r'], Tab: [9], Backspace: [8], Delete: [46], Escape: [27],
  ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39],
  Home: [36], End: [35], PageUp: [33], PageDown: [34], Space: [32, ' '],
};
const MODIFIERS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Command: 4, Shift: 8 };
// macOS ignores editing shortcuts sent via CDP unless the command is named.
const EDIT_COMMANDS = { a: ['selectAll'], c: ['copy'], v: ['paste'], x: ['cut'], z: ['undo'] };

async function pressKey(tabId, combo) {
  const parts = combo.split('+');
  let key = parts.pop();
  let modifiers = 0;
  for (const m of parts) {
    if (!(m in MODIFIERS)) throw new Error(`Unknown modifier "${m}" in "${combo}"`);
    modifiers |= MODIFIERS[m];
  }
  let keyCode, keyText, code;
  if (KEYS[key]) {
    [keyCode, keyText] = KEYS[key];
    code = key;
    if (key === 'Space') key = ' ';
  } else if (key.length === 1) {
    const upper = key.toUpperCase();
    keyCode = upper.charCodeAt(0);
    code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(key) ? `Digit${key}` : undefined;
    keyText = key;
  } else {
    throw new Error(`Unknown key "${key}"`);
  }
  const shortcut = modifiers & (MODIFIERS.Alt | MODIFIERS.Control | MODIFIERS.Meta);
  if (shortcut) keyText = undefined;
  const base = { modifiers, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    ...base,
    type: keyText ? 'keyDown' : 'rawKeyDown',
    text: keyText,
    unmodifiedText: keyText,
    commands: shortcut ? EDIT_COMMANDS[key.toLowerCase()] : undefined,
  });
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function normalizeUrl(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
}

// --------------------------------------------------------------------- tools

const TOOLS = {
  async tabs_list(p) {
    const tabs = await chrome.tabs.query({});
    const groupNames = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g.title || '(unnamed)']));
    const lines = tabs.map(
      (t) =>
        `${t.id === currentTab(p) ? '*' : ' '} ${t.id}  ${t.title || '(no title)'}  ${t.url || ''}` +
        `${t.active ? '  [active]' : ''}${groupNames.has(t.groupId) ? `  [group: ${groupNames.get(t.groupId)}]` : ''}`,
    );
    return text(lines.join('\n') || 'No tabs');
  },

  async tab_new(p) {
    const tab = await chrome.tabs.create({ url: p.url ? normalizeUrl(p.url) : undefined, active: true });
    setCurrentTab(p, tab.id);
    await addToGroup(tab);
    if (p.url) await waitLoad(tab.id);
    const t = await chrome.tabs.get(tab.id);
    return text(`Opened tab ${t.id}: ${t.title} (${t.url || t.pendingUrl})`);
  },

  async tab_select(p) {
    const tab = await chrome.tabs.update(p.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    setCurrentTab(p, tab.id);
    if (p.group) await addToGroup(tab);
    return text(`Current tab is ${tab.id}: ${tab.title}`);
  },

  async tab_close(p) {
    const tab = await resolveTab(p);
    await chrome.tabs.remove(tab.id);
    return text(`Closed tab ${tab.id}`);
  },

  async navigate(p) {
    // With no tab of its own yet, open one in the agy-browser group instead of taking over the user's tab.
    if (p.tabId == null && currentTab(p) == null &&!['back', 'forward', 'reload'].includes(p.url)) {
      return TOOLS.tab_new(p);
    }
    const tab = await resolveTab(p);
    const loaded = waitLoad(tab.id);
    if (p.url === 'back') await chrome.tabs.goBack(tab.id);
    else if (p.url === 'forward') await chrome.tabs.goForward(tab.id);
    else if (p.url === 'reload') await chrome.tabs.reload(tab.id);
    else await chrome.tabs.update(tab.id, { url: normalizeUrl(p.url) });
    await loaded;
    const t = await chrome.tabs.get(tab.id);
    return text(`Loaded: ${t.title} (${t.url})`);
  },

  async snapshot(p) {
    const tab = await resolveTab(p);
    return text(await inPage(tab.id, pageSnapshot, {
      mode: p.mode || 'interactive',
      viewportOnly: !!p.viewportOnly,
      maxChars: p.maxChars || 20000,
    }));
  },

  async click(p) {
    const tab = await resolveTab(p);
    await attach(tab.id);
    let { x, y } = p;
    if (p.ref) ({ x, y } = await locate(tab.id, p.ref));
    if (x == null || y == null) throw new Error('Provide ref, or x and y');
    await moveCursor(tab.id, x, y);
    await mouseClick(tab.id, x, y, p.button || 'left', p.double ? 2 : 1);
    overlay(tab.id, { type: 'click', x, y });
    await settle(tab.id);
    return text(`Clicked ${p.ref || `(${Math.round(x)}, ${Math.round(y)})`}`);
  },

  async fill(p) {
    const tab = await resolveTab(p);
    const fields = p.fields || [{ ref: p.ref, value: p.value }];
    if (!fields.every((f) => f.ref)) throw new Error('Provide ref and value, or fields');
    const results = await inPage(tab.id, pageFill, fields);
    return text(results.join('\n'));
  },

  async type(p) {
    const tab = await resolveTab(p);
    await attach(tab.id);
    if (p.ref) {
      const { x, y } = await locate(tab.id, p.ref);
      await moveCursor(tab.id, x, y);
      await mouseClick(tab.id, x, y);
      overlay(tab.id, { type: 'click', x, y });
    }
    if (p.clear) await inPage(tab.id, pageSelectFocused);
    await cdp(tab.id, 'Input.insertText', { text: p.text });
    if (p.submit) {
      await pressKey(tab.id, 'Enter');
      await settle(tab.id);
    }
    return text(`Typed ${p.text.length} chars${p.ref ? ` into ${p.ref}` : ''}${p.submit ? ' and pressed Enter' : ''}`);
  },

  async press_key(p) {
    const tab = await resolveTab(p);
    await attach(tab.id);
    for (const combo of p.keys.trim().split(/\s+/)) await pressKey(tab.id, combo);
    await settle(tab.id);
    return text(`Pressed ${p.keys}`);
  },

  async scroll(p) {
    const tab = await resolveTab(p);
    let x, y;
    if (p.ref) {
      ({ x, y } = await locate(tab.id, p.ref));
      if (!p.direction) return text(`Scrolled ${p.ref} into view`);
    } else {
      const vp = await inPage(tab.id, () => ({ w: innerWidth, h: innerHeight }));
      x = vp.w / 2;
      y = vp.h / 2;
    }
    await attach(tab.id);
    const px = (p.amount ?? 5) * 100;
    const dir = p.direction || 'down';
    await cdp(tab.id, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y,
      deltaX: dir === 'left' ? -px : dir === 'right' ? px : 0,
      deltaY: dir === 'up' ? -px : dir === 'down' ? px : 0,
    });
    await sleep(150);
    const pos = await inPage(tab.id, () => ({ y: Math.round(scrollY), h: document.documentElement.scrollHeight, vh: innerHeight }));
    return text(`Scrolled ${dir}. Page position ${pos.y}/${pos.h - pos.vh}px`);
  },

  async screenshot(p) {
    const tab = await resolveTab(p);
    // Background tabs don't paint, so capture would hang.
    if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
    await attach(tab.id);
    const { cssLayoutViewport: vp } = await cdp(tab.id, 'Page.getLayoutMetrics');
    // Keep the glow and cursor out of what the agent sees.
    await overlay(tab.id, { type: 'conceal' });
    let shot;
    try {
      shot = await cdp(tab.id, 'Page.captureScreenshot', { format: 'jpeg', quality: 80 });
    } finally {
      overlay(tab.id, { type: 'reveal' });
    }
    const w = Math.round(vp.clientWidth);
    const h = Math.round(vp.clientHeight);
    let data = shot.data;
    const bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${data}`)).blob());
    if (bitmap.width !== w) {
      // Retina captures are 2x; resize to CSS pixels so coordinates match click x/y.
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      data = await blobToBase64(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 }));
    }
    return {
      content: [
        { type: 'image', data, mimeType: 'image/jpeg' },
        { type: 'text', text: `Viewport ${w}x${h} CSS px of ${tab.url}` },
      ],
    };
  },

  async get_text(p) {
    const tab = await resolveTab(p);
    return text(await inPage(tab.id, pageText, p.selector || null, p.maxChars || 30000));
  },

  async evaluate(p) {
    const tab = await resolveTab(p);
    await attach(tab.id);
    const r = await cdp(tab.id, 'Runtime.evaluate', {
      expression: p.code, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    const v = r.result.value;
    if (v === undefined) return text(r.result.description ?? 'undefined');
    return text(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  },

  async console_logs(p) {
    const tab = await resolveTab(p);
    const firstTime = !attached.has(tab.id);
    await attach(tab.id);
    let list = consoleLogs.get(tab.id) || [];
    if (p.pattern) {
      const re = new RegExp(p.pattern, 'i');
      list = list.filter((e) => re.test(e.text));
    }
    list = list.slice(-(p.limit || 100));
    if (p.clear) consoleLogs.delete(tab.id);
    const out = list.map((e) => `[${e.level}] ${e.text}`).join('\n');
    return text(out || (firstTime ? 'Started capturing console for this tab; call again after reproducing.' : 'No console messages'));
  },

  async wait_for(p) {
    const tab = await resolveTab(p);
    if (!p.text) {
      await sleep(p.ms ?? 1000);
      return text(`Waited ${p.ms ?? 1000}ms`);
    }
    const deadline = Date.now() + (p.timeout ?? 10000);
    while (Date.now() < deadline) {
      const found = await inPage(tab.id, (t) => document.body?.innerText.includes(t), p.text).catch(() => false);
      if (found) return text(`Found "${p.text}"`);
      await sleep(250);
    }
    throw new Error(`"${p.text}" did not appear within ${p.timeout ?? 10000}ms`);
  },
};

// ------------------------------------------------------- injected page code
// These run inside the page (extension isolated world) and must be self-contained.
// Refs live on window.__agy, which persists in the isolated world between calls.

function pageSnapshot(opts) {
  const S = (window.__agy ||= { n: 0, ids: new WeakMap(), els: new Map() });
  const refOf = (el) => {
    let id = S.ids.get(el);
    if (!id) {
      id = `e${++S.n}`;
      S.ids.set(el, id);
      S.els.set(id, new WeakRef(el));
    }
    return id;
  };
  const clean = (s, n = 80) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? `${s.slice(0, n)}…` : s;
  };

  const INTERACTIVE = new Set([
    'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'slider', 'spinbutton',
    'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'file', 'clickable',
  ]);
  // Roles whose text is already in their name, so their subtree isn't listed.
  const LEAF = new Set([
    'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'slider', 'spinbutton', 'switch',
    'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'file', 'heading', 'img',
  ]);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'svg', 'IFRAME']);
  const INPUT_ROLES = {
    checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button',
    range: 'slider', file: 'file', search: 'searchbox', number: 'spinbutton',
  };
  const LANDMARKS = { NAV: 'navigation', MAIN: 'main', FORM: 'form', DIALOG: 'dialog', HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary' };

  const roleOf = (el, style, parentPointer) => {
    const explicit = el.getAttribute('role');
    if (explicit && explicit !== 'presentation' && explicit !== 'none') return explicit.split(' ')[0];
    const tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'INPUT') return el.type === 'hidden' ? null : INPUT_ROLES[el.type] || 'textbox';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'IMG') return el.alt ? 'img' : null;
    if (LANDMARKS[tag]) return LANDMARKS[tag];
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox';
    // Divs with click handlers: pointer cursor that doesn't just inherit from the parent.
    if (el.hasAttribute('onclick') || (style.cursor === 'pointer' && !parentPointer)) return 'clickable';
    return null;
  };

  const nameOf = (el) => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
      if (t.trim()) return clean(t);
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    if (el.labels?.length) {
      // Wrapping labels contain the control itself (e.g. a select's options); drop it from the name.
      const label = el.labels[0].cloneNode(true);
      label.querySelectorAll('input, select, textarea').forEach((c) => c.remove());
      const t = clean(label.textContent);
      if (t) return t;
    }
    if (el.tagName === 'IMG') return clean(el.alt);
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) return clean(el.value);
    const isField = ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable;
    return clean(
      (!isField && el.innerText) || el.getAttribute('placeholder') || el.getAttribute('title') ||
        el.querySelector?.('img[alt]')?.alt || '',
    );
  };

  const describe = (el, role) => {
    const level = /^H[1-6]$/.test(el.tagName) ? el.tagName[1] : el.getAttribute('aria-level') || '';
    let s = role === 'heading' ? `heading h${level}` : role;
    const name = nameOf(el);
    if (name) s += ` "${name}"`;
    s += ` [ref=${refOf(el)}]`;
    if (role === 'link') {
      const href = el.getAttribute('href');
      if (href && !href.startsWith('javascript:')) s += ` -> ${clean(href, 100)}`;
    }
    if (['INPUT', 'TEXTAREA'].includes(el.tagName) && !['checkbox', 'radio', 'submit', 'button', 'reset', 'file'].includes(el.type)) {
      const v = el.type === 'password' ? (el.value ? '••••' : '') : el.value;
      if (v) s += ` value="${clean(v, 60)}"`;
    }
    if (el.tagName === 'SELECT') {
      s += ` value="${clean(el.selectedOptions[0]?.text, 40)}" options: ${clean([...el.options].map((o) => o.text).join(' | '), 150)}`;
    }
    if (el.isContentEditable && role === 'textbox') {
      const v = clean(el.innerText, 60);
      if (v) s += ` value="${v}"`;
    }
    if (el.checked || el.getAttribute('aria-checked') === 'true') s += ' checked';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s += ' disabled';
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) s += ` expanded=${expanded}`;
    if (el.getAttribute('aria-selected') === 'true') s += ' selected';
    return s;
  };

  const all = opts.mode === 'all';
  const lines = [];
  let size = 0;
  let truncated = false;
  const emit = (depth, s) => {
    if (size > opts.maxChars) {
      truncated = true;
      return;
    }
    const line = '  '.repeat(depth) + s;
    lines.push(line);
    size += line.length + 1;
  };
  const onScreen = (r) => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;

  const visit = (el, depth, parentPointer) => {
    if (truncated || SKIP.has(el.tagName) || el.getAttribute('aria-hidden') === 'true') return;
    const style = getComputedStyle(el);
    if (style.display === 'none') return;
    const role = roleOf(el, style, parentPointer);
    let next = depth;
    if (role && (all || INTERACTIVE.has(role) || role === 'heading') && style.visibility !== 'hidden') {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && (!opts.viewportOnly || onScreen(r))) {
        emit(depth, describe(el, role));
        next = depth + 1;
        if (LEAF.has(role)) return;
      }
    }
    const pointer = style.cursor === 'pointer';
    const kids = el.shadowRoot ? [...el.shadowRoot.childNodes, ...el.childNodes] : el.childNodes;
    for (const c of kids) {
      if (c.nodeType === 1) visit(c, next, pointer);
      else if (all && c.nodeType === 3) {
        const t = clean(c.textContent, 200);
        if (t) emit(next, `text: ${t}`);
      }
    }
  };

  visit(document.body || document.documentElement, 0, false);
  const header =
    `Page: ${document.title}\nURL: ${location.href}\n` +
    `Viewport: ${innerWidth}x${innerHeight}, scrolled ${Math.round(scrollY)}/${Math.max(0, document.documentElement.scrollHeight - innerHeight)}px\n`;
  return `${header}\n${lines.join('\n') || '(no matching elements)'}${truncated ? '\n… truncated; use viewportOnly or a larger maxChars' : ''}`;
}

function pageOverlay(cmd) {
  const COLOR = '37, 99, 235'; // matches the blue "agy-browser" tab group
  const IDLE_MS = 8000;
  let o = window.__agyOverlay;
  if (!o?.host.isConnected) {
    // Closed shadow root + aria-hidden keeps it out of snapshot and get_text; built without
    // <style> or innerHTML so page CSP and Trusted Types can't block it.
    const host = document.createElement('agy-overlay');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      .wrap { position: fixed; inset: 0; pointer-events: none; }
      .glow { position: fixed; inset: 0; opacity: 0; transition: opacity .3s;
        box-shadow: inset 0 0 0 2px rgba(${COLOR}, .9), inset 0 0 32px 8px rgba(${COLOR}, .45);
        animation: pulse 2s ease-in-out infinite; }
      @keyframes pulse { 50% { box-shadow: inset 0 0 0 2px rgba(${COLOR}, .6), inset 0 0 20px 4px rgba(${COLOR}, .28); } }
      .on .glow { opacity: 1; }
      .cursor { position: fixed; left: 0; top: 0; width: 24px; height: 24px; opacity: 0;
        transition: transform .18s cubic-bezier(.2, .7, .3, 1), opacity .2s;
        filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .35)); }
      .on .cursor.seen { opacity: 1; }
      .ripple { position: fixed; width: 30px; height: 30px; margin: -15px 0 0 -15px; border-radius: 50%;
        border: 2px solid rgba(${COLOR}, .95); animation: ripple .45s ease-out forwards; }
      @keyframes ripple { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }
    `);
    root.adoptedStyleSheets = [sheet];
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const glow = document.createElement('div');
    glow.className = 'glow';
    const NS = 'http://www.w3.org/2000/svg';
    const cursor = document.createElementNS(NS, 'svg');
    cursor.setAttribute('class', 'cursor');
    cursor.setAttribute('viewBox', '0 0 24 24');
    const arrow = document.createElementNS(NS, 'path');
    arrow.setAttribute('d', 'M4 2 L20 11.5 L13 13.1 L9.4 20 Z');
    arrow.setAttribute('fill', `rgb(${COLOR})`);
    arrow.setAttribute('stroke', '#fff');
    arrow.setAttribute('stroke-width', '1.5');
    arrow.setAttribute('stroke-linejoin', 'round');
    cursor.append(arrow);
    wrap.append(glow, cursor);
    root.append(wrap);
    document.documentElement.append(host);
    o = window.__agyOverlay = { host, root, wrap, cursor, timer: 0 };
  }

  if (cmd.type === 'conceal' || cmd.type === 'reveal') {
    o.host.style.display = cmd.type === 'conceal' ? 'none' : '';
    return;
  }
  clearTimeout(o.timer);
  o.wrap.classList.add('on');
  o.timer = setTimeout(() => o.wrap.classList.remove('on'), IDLE_MS);
  if (cmd.x == null) return;

  // The arrow's tip is at (4, 2) in its 24x24 box.
  const transform = `translate(${cmd.x - 4}px, ${cmd.y - 2}px)`;
  if (!o.cursor.classList.contains('seen')) {
    // First appearance: place it without gliding in from the corner.
    o.cursor.style.transition = 'none';
    o.cursor.style.transform = transform;
    o.cursor.getBoundingClientRect();
    o.cursor.style.transition = '';
    o.cursor.classList.add('seen');
  } else {
    o.cursor.style.transform = transform;
  }
  if (cmd.type === 'click') {
    const ripple = document.createElement('div');
    ripple.className = 'ripple';
    ripple.style.left = `${cmd.x}px`;
    ripple.style.top = `${cmd.y}px`;
    o.root.append(ripple);
    setTimeout(() => ripple.remove(), 500);
  }
}

function pageLocate(ref) {
  const el = window.__agy?.els.get(ref)?.deref();
  if (!el?.isConnected) return { error: `Ref ${ref} not found; take a new snapshot` };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function pageFill(fields) {
  return fields.map(({ ref, value }) => {
    const el = window.__agy?.els.get(ref)?.deref();
    if (!el?.isConnected) return `${ref}: not found; take a new snapshot`;
    el.focus();
    if (el.tagName === 'SELECT') {
      const opt = [...el.options].find((o) => o.value === String(value) || o.text.trim() === String(value));
      if (!opt) return `${ref}: no option "${value}"`;
      el.value = opt.value;
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      const want = value === true || value === 'true';
      if (el.checked !== want) el.click();
      return `${ref}: ${want ? 'checked' : 'unchecked'}`;
    } else if (el.isContentEditable) {
      el.textContent = String(value);
    } else {
      // Use the native setter so frameworks like React notice the change.
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value));
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return `${ref}: set`;
  });
}

function pageSelectFocused() {
  const el = document.activeElement;
  if (el && typeof el.select === 'function') el.select();
  else if (el?.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function pageText(selector, maxChars) {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) return { error: `No element matches ${selector}` };
  let t = root.innerText.replace(/\n{3,}/g, '\n\n').trim();
  if (t.length > maxChars) t = `${t.slice(0, maxChars)}\n… truncated (${t.length} chars total)`;
  return `Page: ${document.title}\nURL: ${location.href}\n\n${t}`;
}
