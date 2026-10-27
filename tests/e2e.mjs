// End-to-end test: two MCP sessions (hub + peer) drive Chrome for Testing through
// the extension. Run via tests/run.sh, which sets up Chrome, the extension and the site.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const BIN = process.env.AGY_BROWSER_BIN;
const PORT = process.env.AGY_BROWSER_PORT;
const BASE = process.env.SITE_URL;

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail.replace(/\n/g, '\n      ')}`}`);
}

function session(name) {
  const p = spawn(BIN, [], { env: { ...process.env, AGY_BROWSER_PORT: PORT }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiters = new Map();
  let id = 0;
  createInterface({ input: p.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    waiters.get(m.id)?.(m.result);
  });
  const call = (tool, args = {}) =>
    new Promise((resolve) => {
      const i = ++id;
      waiters.set(i, (res) => {
        const out = res.content.map((c) => (c.type === 'text' ? c.text : `<${c.type}>`)).join('');
        resolve({ out, isError: !!res.isError, content: res.content });
      });
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: tool, arguments: args } }) + '\n');
    });
  return { name, p, call };
}

const refOf = (snapshot, label) => snapshot.split('\n').find((l) => l.includes(label))?.match(/ref=(e\d+)/)?.[1];

const a = session('A');
await new Promise((r) => setTimeout(r, 300)); // let A become the hub
const b = session('B');

// A cold Chrome can take a while to start the extension's service worker.
for (let i = 0; ; i++) {
  if (!(await a.call('tabs_list')).isError) break;
  if (i === 5) throw new Error('extension never connected to the hub');
}

// --- tabs, groups, focus
const opened = await a.call('navigate', { url: `${BASE}/index.html` });
check('navigate opens a tab when the session has none', /Opened tab \d+: Test Form/.test(opened.out), opened.out);
const tabId = Number(opened.out.match(/tab (\d+)/)?.[1]);
let tabs = await a.call('tabs_list');
check('new tab is in the agy-browser group', new RegExp(`${tabId} .*\\[group: agy-browser\\]`).test(tabs.out), tabs.out);
check("user's tab keeps focus", /about:blank\s+about:blank\s+\[active\]/.test(tabs.out), tabs.out);
const focus = await a.call('evaluate', { code: 'document.hasFocus()' });
check('background tab behaves as focused', focus.out === 'true', focus.out);

// --- snapshot and form input
const snap = (await a.call('snapshot')).out;
check('snapshot lists controls with refs', /combobox "Plan" \[ref=e\d+\] value="Free" options: Free \| Pro/.test(snap), snap);
const fill = await a.call('fill', {
  fields: [
    { ref: refOf(snap, 'textbox "Email"'), value: 'a@b.com' },
    { ref: refOf(snap, 'combobox'), value: 'Pro' },
    { ref: refOf(snap, 'checkbox'), value: true },
  ],
});
check('fill sets several fields', !fill.isError && !/not found|no option/.test(fill.out), fill.out);
await a.call('type', { ref: refOf(snap, '"Note"'), text: 'hello world' });
await a.call('press_key', { keys: 'Meta+a Backspace' });

// --- sessions: B has no tab of its own, but can act on A's tab by id
const noTab = await b.call('snapshot');
check('session without a tab gets an error, not the user tab', noTab.isError && /no tab yet/.test(noTab.out), noTab.out);
await b.call('click', { tabId, ref: refOf(snap, 'button "Sign up"') });
const result = await b.call('get_text', { tabId, selector: '#out' });
check('click by ref submits the form', result.out.includes('Submitted: a@b.com / pro / true'), result.out);

await a.call('click', { ref: refOf(snap, 'clickable') });
const state = await a.call('evaluate', { code: 'document.querySelector("textarea").value + "|" + document.querySelector("div[style]").textContent' });
check('type + Meta+a Backspace cleared the textarea; clickable div clicked', state.out === '|div clicked', state.out);
const logs = await a.call('console_logs');
check('console_logs captures page logs', logs.out.includes('[log] submitted a@b.com'), logs.out);

const shot = await a.call('screenshot');
check('screenshot returns an image', shot.content[0]?.type === 'image', shot.out);
tabs = await a.call('tabs_list');
check("screenshot hands focus back to the user's tab", /about:blank\s+about:blank\s+\[active\]/.test(tabs.out), tabs.out);

// --- navigation
await a.call('click', { ref: refOf(snap, 'link "Next page"') });
const page2 = await a.call('snapshot', { mode: 'all' });
check('link click navigates', page2.out.includes('Page: Page Two'), page2.out);
await a.call('navigate', { url: 'back' });
const back = await a.call('wait_for', { text: 'Signup', timeout: 3000 });
check('navigate back + wait_for', !back.isError, back.out);

// --- network
await a.call('navigate', { url: `${BASE}/net.html` });
const netSnap = (await a.call('snapshot')).out;
let net = await a.call('network_requests');
check('network captures the first requests of a page', /GET 200 Document .*net\.html/.test(net.out) && /GET 200 Fetch .*data\.json/.test(net.out), net.out);
await a.call('click', { ref: refOf(netSnap, 'button "Save"') });
await new Promise((r) => setTimeout(r, 300));
net = await a.call('network_requests', { failed: true });
check('failed filter shows the 501 POST', /POST 501 Fetch .*\/api\/save/.test(net.out), net.out);
const postId = net.out.match(/^(n\d+)/m)?.[1];
const getId = (await a.call('network_requests', { pattern: 'data\\.json' })).out.match(/^(n\d+)/m)?.[1];
const getDetail = await a.call('network_request', { id: getId });
check('response body is pretty-printed JSON', getDetail.out.includes('"name": "Huan"'), getDetail.out);
const postDetail = await a.call('network_request', { id: postId, body: false });
check('request body is shown', postDetail.out.includes('{"plan":"pro","qty":2}'), postDetail.out);
check('auth headers are hidden by default', !postDetail.out.includes('secret-token-123') && /authorization: <\d+ chars hidden>/i.test(postDetail.out), postDetail.out);
const secrets = await a.call('network_request', { id: postId, body: false, showSecrets: true });
check('showSecrets reveals them', secrets.out.includes('Bearer secret-token-123'), secrets.out);

// --- dedicated window
const winTab = await a.call('tab_new', { url: `${BASE}/page2.html`, newWindow: true });
const winTabId = winTab.out.match(/tab (\d+)/)?.[1];
tabs = await a.call('tabs_list');
check('newWindow opens the tab in the agy-browser window', new RegExp(`${winTabId} .*\\[active\\].*\\[window: agy-browser\\]`).test(tabs.out), tabs.out);
check("newWindow leaves the user's tab active", /about:blank\s+about:blank\s+\[active\]\n/.test(tabs.out + '\n'), tabs.out);
const winTab2 = await a.call('tab_new', { url: `${BASE}/index.html`, newWindow: true });
tabs = await a.call('tabs_list');
const winCount = tabs.out.split('\n').filter((l) => l.includes('[window: agy-browser]')).length;
check('later newWindow tabs reuse the same window', winCount === 2, tabs.out);
const winShot = await a.call('screenshot');
check('screenshot works in the agy-browser window', winShot.content[0]?.type === 'image', winShot.out);
await a.call('tab_close', { tabId: Number(winTabId) });
await a.call('tab_close');
await a.call('tab_select', { tabId: Number(tabs.out.match(/(\d+)\s+Net Test/)?.[1]) });

// --- per-session tabs
await b.call('navigate', { url: `${BASE}/page2.html` });
const aPath = await a.call('evaluate', { code: 'location.pathname' });
const bPath = await b.call('evaluate', { code: 'location.pathname' });
check('each session keeps its own tab', aPath.out === '/net.html' && bPath.out === '/page2.html', `${aPath.out} / ${bPath.out}`);

// --- hub handover
await a.call('tab_close');
a.p.kill();
await new Promise((r) => setTimeout(r, 500));
const after = await b.call('tabs_list');
check('peer takes over when the hub exits', !after.isError && after.out.includes('page2.html'), after.out);
b.p.kill();

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
