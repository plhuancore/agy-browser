//! Tool definitions advertised to the agent. Each tool name is handled by the
//! extension's `TOOLS` table in `extension/background.js`.

use serde_json::{json, Value};

pub const INSTRUCTIONS: &str = "\
Drives the user's real Chrome (their logins and cookies) through the agy browser extension.
Workflow: snapshot -> act by ref (click / fill / type) -> snapshot again only when you need to see the result.
- Prefer `snapshot` over `screenshot`: it is text, cheap, and gives refs like e12 for click/fill/type.
- Refs stay valid until the element leaves the page; after navigation take a new snapshot.
- Use `fill` with several fields at once for forms; it is much faster than typing.
- Actions apply to the current tab (the last one you opened/selected); pass tabId to target another.
- Use screenshot only for visual questions; its pixel coordinates can be passed to click x/y.";

fn tab_id() -> Value {
    json!({ "type": "integer", "description": "Tab to act on. Defaults to the current tab." })
}

fn tool(name: &str, description: &str, mut properties: Value, required: &[&str]) -> Value {
    properties["tabId"] = tab_id();
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required },
    })
}

pub fn list() -> Vec<Value> {
    vec![
        json!({
            "name": "tabs_list",
            "description": "List open tabs with their ids, titles and URLs. The current tab is marked with *; grouped tabs show [group: name].",
            "inputSchema": { "type": "object", "properties": {} },
        }),
        json!({
            "name": "tab_new",
            "description": "Open a new background tab in the \"agy-browser\" tab group (optionally at a URL), wait for it to load and make it the current tab. \
                            It does not take the user's focus.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string" },
                    "activate": { "type": "boolean", "description": "Bring the tab to the front. Only when the user wants to watch." },
                },
            },
        }),
        json!({
            "name": "tab_select",
            "description": "Make a tab the current tab for this session (tools act on it). Does not bring it to the front.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "integer" },
                    "group": { "type": "boolean", "description": "Also move the tab into the \"agy-browser\" tab group." },
                    "activate": { "type": "boolean", "description": "Also bring the tab to the front. Only when the user asks." },
                },
                "required": ["tabId"],
            },
        }),
        tool("tab_close", "Close a tab (defaults to the current tab).", json!({}), &[]),
        tool(
            "navigate",
            "Go to a URL in the current tab and wait for the page to load (opens a new tab in the agy-browser group if this session has none yet). \
             Also accepts \"back\", \"forward\" or \"reload\".",
            json!({ "url": { "type": "string" } }),
            &["url"],
        ),
        tool(
            "snapshot",
            "Text outline of the page with refs for interactive elements, e.g. `button \"Sign in\" [ref=e7]`. \
             mode \"interactive\" (default) lists controls and headings; \"all\" also lists text, images and landmarks.",
            json!({
                "mode": { "type": "string", "enum": ["interactive", "all"] },
                "viewportOnly": { "type": "boolean", "description": "Only elements currently on screen." },
                "maxChars": { "type": "integer", "description": "Truncate output after this many characters (default 20000)." },
            }),
            &[],
        ),
        tool(
            "click",
            "Click an element by ref, or at viewport coordinates x/y (CSS pixels, as in screenshot).",
            json!({
                "ref": { "type": "string" },
                "x": { "type": "number" },
                "y": { "type": "number" },
                "button": { "type": "string", "enum": ["left", "right", "middle"] },
                "double": { "type": "boolean" },
            }),
            &[],
        ),
        tool(
            "fill",
            "Set values of inputs, textareas, selects (option value or label), checkboxes/radios (true/false) \
             without typing. Pass `fields` to fill several at once.",
            json!({
                "ref": { "type": "string" },
                "value": { "type": ["string", "boolean"] },
                "fields": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": { "ref": { "type": "string" }, "value": { "type": ["string", "boolean"] } },
                        "required": ["ref", "value"],
                    },
                },
            }),
            &[],
        ),
        tool(
            "type",
            "Type text with real keyboard input into the focused element, or into `ref` after clicking it. \
             Use for editors and inputs where `fill` is not picked up.",
            json!({
                "text": { "type": "string" },
                "ref": { "type": "string" },
                "clear": { "type": "boolean", "description": "Select existing content first so it is replaced." },
                "submit": { "type": "boolean", "description": "Press Enter afterwards." },
            }),
            &["text"],
        ),
        tool(
            "press_key",
            "Press keys. Space-separated sequence of keys or combos, e.g. \"Enter\", \"Tab Tab Enter\", \"Meta+a\", \"Shift+ArrowDown\".",
            json!({ "keys": { "type": "string" } }),
            &["keys"],
        ),
        tool(
            "scroll",
            "Scroll the page (or scroll an element into view when only `ref` is given).",
            json!({
                "direction": { "type": "string", "enum": ["up", "down", "left", "right"] },
                "amount": { "type": "number", "description": "Wheel ticks, ~100px each (default 5)." },
                "ref": { "type": "string" },
            }),
            &[],
        ),
        tool(
            "screenshot",
            "JPEG of the tab's viewport, sized in CSS pixels so its coordinates work with click x/y. \
             A background tab is brought forward for ~0.2s to paint, then the user's tab is restored.",
            json!({}),
            &[],
        ),
        tool(
            "get_text",
            "Visible text of the page (or of the first element matching `selector`).",
            json!({
                "selector": { "type": "string" },
                "maxChars": { "type": "integer", "description": "Default 30000." },
            }),
            &[],
        ),
        tool(
            "evaluate",
            "Evaluate a JavaScript expression in the page and return its JSON value. Promises are awaited; \
             wrap statements in an IIFE.",
            json!({ "code": { "type": "string" } }),
            &["code"],
        ),
        tool(
            "console_logs",
            "Console messages and uncaught exceptions captured since the extension first acted on the tab.",
            json!({
                "pattern": { "type": "string", "description": "Regex filter." },
                "limit": { "type": "integer", "description": "Most recent N (default 100)." },
                "clear": { "type": "boolean" },
            }),
            &[],
        ),
        tool(
            "wait_for",
            "Wait until `text` appears on the page, or for `ms` milliseconds.",
            json!({
                "text": { "type": "string" },
                "ms": { "type": "integer" },
                "timeout": { "type": "integer", "description": "Max wait for text in ms (default 10000)." },
            }),
            &[],
        ),
    ]
}
