---
name: agy-browser
description: "Drive the user's real Chrome (their logins, cookies, open tabs) through the agy-browser MCP tools: open pages, read them, click, fill forms, type, take screenshots, read console logs, run JS. Use whenever a task needs a web browser: checking a web app or localhost page, reproducing a UI bug, filling a form, logging into or reading something from a site the user is signed into, or verifying a frontend change. Prefer it over Playwright or chrome-devtools MCP, which launch a separate slower browser without the user's sessions."
---

# agy-browser

The `agy-browser` MCP server controls the user's own Chrome through the "agy browser bridge" extension. Pages are the user's real tabs with their real sessions, so act as carefully as the user would.

## Core loop

1. **Open**: `tab_new { url }` for a fresh tab. It goes into the blue **agy-browser** tab group and becomes the current tab. To work in a tab the user already has open, use `tabs_list` then `tab_select` (add `group: true` only if the user wants it moved into the group). `navigate` reuses the current tab and opens a new agy-browser tab when this session has none yet. Tools never fall back to the tab the user is looking at; without a tab of your own they return an error telling you to open one.
2. **Look**: `snapshot` returns a text outline with refs:
   ```
   textbox "Email" [ref=e2]
   combobox "Plan" [ref=e3] value="Free" options: Free | Pro
   button "Sign up" [ref=e6]
   link "Next page" [ref=e8] -> /page2.html
   ```
3. **Act** by ref: `click { ref }`, `fill`, `type`, `press_key`.
4. **Check** only what you need: `get_text { selector }` for a result message, `wait_for { text }` for async UI, or a new `snapshot` once the page has changed.

Actions do not return a snapshot. Take one yourself when you need to see the new state; skipping unneeded snapshots is what makes this fast.

## Choosing the right tool

| Need | Use | Not |
|---|---|---|
| Find what to click/fill | `snapshot` (~10ms, text) | `screenshot` |
| Long page | `snapshot { viewportOnly: true }` or `get_text { selector }` | full `snapshot { mode: "all" }` |
| Read article/result text | `get_text` | `snapshot` |
| Fill a form | one `fill { fields: [...] }` call | several `type` calls |
| Rich editors, inputs that ignore `fill`, autocomplete | `type { ref, text, clear?, submit? }` | `fill` |
| Keyboard shortcuts, menus | `press_key { keys: "Escape" }`, `"Tab Tab Enter"`, `"Meta+a"` | |
| Layout, colors, charts, canvas, "how does it look" | `screenshot` | `snapshot` |
| Element without a ref (canvas, map) | `screenshot`, then `click { x, y }` | |
| Data inside the page / app state | `evaluate { code }` | scraping by snapshot |
| JS errors | `console_logs` | |
| API calls, status codes, payloads | `network_requests` then `network_request { id }` | `evaluate` with fetch |

- `fill` values: text for inputs, option value or label for selects, `true`/`false` for checkboxes and radios.
- `evaluate` takes an expression; wrap statements in an IIFE: `(() => { ...; return x })()`. Promises are awaited.
- `screenshot` coordinates are CSS pixels and match `click { x, y }` directly.
- `scroll { ref }` without a direction scrolls that element into view.
- agy works in **background tabs** and never takes the user's focus: `tab_new` opens in the background and `tab_select` only changes which tab you act on. Don't pass `activate: true` unless the user asks to watch. Pass `newWindow: true` to `tab_new` (or to the first `navigate`) to work in agy-browser's own unfocused window instead of the user's window; there the tab stays active, so animations run and screenshots don't flash. If the user asks for a separate window, use it for every tab you open. `screenshot` of a background tab flashes it for ~0.2s, which is one more reason to prefer `snapshot`.
- Every tool accepts `tabId` to target another tab for that one call (it doesn't change your current tab); otherwise it acts on the current tab (the last one this session opened or selected with `tab_new` / `tab_select`). Each agy session has its own current tab, so parallel agents don't interfere; still close tabs you opened with `tab_close` when done.

## Refs

- Refs (`e12`) stay valid as long as the element is still on the page, and survive other DOM updates.
- After navigation or a big re-render, a ref error says "take a new snapshot". Do that rather than guessing.
- Elements inside iframes are not listed. Use `evaluate`, or open the iframe URL in its own tab.
- `clickable "..."` entries are non-semantic elements with a pointer cursor (custom buttons). They are usually the right click target when there is no `button`.

## Debugging a web app

1. Console and network capture start when agy-browser attaches to a tab. Tabs you open with `tab_new`/`navigate` are captured from their first request; for a tab the user opened, call `network_requests` once, then reproduce or `navigate { url: "reload" }`.
2. Reproduce the bug with click/fill/type.
3. Call `console_logs { pattern: "error|warn" }` and `network_requests { failed: true }`; open the suspicious call with `network_request { id }` to read its payload and response. Use `evaluate` to inspect state (`localStorage`, globals).
4. `navigate { url: "reload" }` to retry with a clean page.

## Safety

This is the user's logged-in browser. Before submitting forms that spend money, send messages, publish, delete, or change account settings, confirm with the user unless they explicitly asked for that exact action. Do not close tabs you did not open unless asked. Never type passwords or secrets the user did not give you for that purpose.

## Troubleshooting

| Error | Fix |
|---|---|
| "extension is not connected" | Ask the user to open Chrome and check that "agy browser bridge" is enabled in `chrome://extensions`; the icon shows **ON** when connected. If agy was restarted, wait a few seconds and retry once. |
| "Cannot access contents of url" / chrome:// pages | Extensions cannot script `chrome://`, the Web Store, or other extension pages. Use a normal page. |
| "Another debugger is already attached" | DevTools is open on that tab; ask the user to close DevTools for it. |
| Screenshot hangs or times out | The tab's window is minimized. Ask the user to restore the window. |
| `fill` set the value but the app ignores it | Use `type { ref, text, clear: true }` for real key events. |
