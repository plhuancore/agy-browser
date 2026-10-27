//! agy-browser: MCP server (stdio) that forwards tool calls to a Chrome
//! extension over a local WebSocket, the same shape as Claude in Chrome.

mod bridge;
mod tools;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let port = std::env::var("AGY_BROWSER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8765);
    let bridge = bridge::Bridge::new(port);
    // Take the port now so the extension can connect before the first tool call.
    // If another agy session already owns it, we relay through that one instead.
    bridge.try_become_hub().await;

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(msg) = out_rx.recv().await {
            let mut line = msg.to_string();
            line.push('\n');
            if stdout.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            let _ = stdout.flush().await;
        }
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        // Notifications (no id) and responses to our requests (we send none) need no reply.
        let (Some(id), Some(method)) = (msg.get("id").cloned(), msg["method"].as_str()) else {
            continue;
        };
        let method = method.to_string();
        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
        let out = out_tx.clone();
        let bridge = bridge.clone();
        tokio::spawn(async move {
            let reply = match method.as_str() {
                "initialize" => ok(
                    id,
                    json!({
                        "protocolVersion": params["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                        "capabilities": { "tools": {} },
                        "serverInfo": { "name": "agy-browser", "version": env!("CARGO_PKG_VERSION") },
                        "instructions": tools::INSTRUCTIONS,
                    }),
                ),
                "ping" => ok(id, json!({})),
                "tools/list" => ok(id, json!({ "tools": tools::list() })),
                "tools/call" => {
                    let name = params["name"].as_str().unwrap_or_default();
                    let mut args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                    // AGY_BROWSER_NEW_WINDOW=1 makes agy's own window the default for new tabs.
                    if new_window_default() && matches!(name, "tab_new" | "navigate") && args.get("newWindow").is_none() {
                        args["newWindow"] = json!(true);
                    }
                    let result = match bridge.call(name, args).await {
                        Ok(v) => v,
                        Err(e) => json!({
                            "content": [{ "type": "text", "text": format!("Error: {e}") }],
                            "isError": true,
                        }),
                    };
                    ok(id, result)
                }
                _ => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": format!("Method not found: {method}") },
                }),
            };
            let _ = out.send(reply);
        });
    }
    Ok(())
}

fn new_window_default() -> bool {
    matches!(std::env::var("AGY_BROWSER_NEW_WINDOW").as_deref(), Ok("1" | "true"))
}

fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}
