//! Local WebSocket bridge between MCP sessions and the Chrome extension.
//!
//! The first agy-browser process to bind the port becomes the hub: the
//! extension connects to it at `/ext`, and later processes (other agy
//! sessions) connect at `/peer` and have their calls relayed. If the hub
//! exits, the next call from a peer takes the port over.

use anyhow::{anyhow, bail, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

const CALL_TIMEOUT: Duration = Duration::from_secs(90);
/// How long a call waits for the extension to (re)connect before failing.
const CONNECT_WAIT: Duration = Duration::from_secs(5);

type Reply = std::result::Result<Value, String>;
type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

enum Role {
    Extension,
    Peer,
}

pub struct Bridge {
    port: u16,
    /// Identifies this agy session to the extension, which keeps a current tab per session.
    session: String,
    is_hub: AtomicBool,
    /// The extension (hub mode) or the hub (peer mode), tagged with a connection id.
    upstream: Mutex<Option<(u64, mpsc::UnboundedSender<String>)>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    next_id: AtomicU64,
    conn_seq: AtomicU64,
    /// Optional pin: only accept this extension id (AGY_BROWSER_EXTENSION_ID).
    extension_id: Option<String>,
}

impl Bridge {
    pub fn new(port: u16) -> Arc<Self> {
        Arc::new(Self {
            port,
            session: format!("s{}", std::process::id()),
            is_hub: AtomicBool::new(false),
            upstream: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            conn_seq: AtomicU64::new(0),
            extension_id: std::env::var("AGY_BROWSER_EXTENSION_ID").ok().filter(|s| !s.is_empty()),
        })
    }

    pub async fn try_become_hub(self: &Arc<Self>) -> bool {
        let Ok(listener) = TcpListener::bind(("127.0.0.1", self.port)).await else {
            return false;
        };
        self.is_hub.store(true, SeqCst);
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                if let Ok((stream, _)) = listener.accept().await {
                    tokio::spawn(this.clone().handle_incoming(stream));
                }
            }
        });
        true
    }

    pub async fn call(self: &Arc<Self>, method: &str, params: Value) -> Result<Value> {
        self.call_as(&self.session, method, params).await
    }

    async fn call_as(self: &Arc<Self>, session: &str, method: &str, params: Value) -> Result<Value> {
        let tx = self.ensure_upstream().await?;
        let id = self.next_id.fetch_add(1, SeqCst);
        let (reply_tx, reply_rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, reply_tx);
        let msg = json!({ "id": id, "session": session, "method": method, "params": params }).to_string();
        if tx.send(msg).is_err() {
            self.pending.lock().unwrap().remove(&id);
            bail!("connection to the browser was lost");
        }
        match tokio::time::timeout(CALL_TIMEOUT, reply_rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(anyhow!(e)),
            Ok(Err(_)) => bail!("connection to the browser was lost"),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                bail!("browser did not answer within {}s", CALL_TIMEOUT.as_secs())
            }
        }
    }

    /// Boxed so the hub's relay task and `call` don't form a recursive future type.
    fn call_boxed(self: Arc<Self>, session: String, method: String, params: Value) -> BoxFuture<Result<Value>> {
        Box::pin(async move { self.call_as(&session, &method, params).await })
    }

    fn current_upstream(&self) -> Option<mpsc::UnboundedSender<String>> {
        self.upstream.lock().unwrap().as_ref().map(|(_, tx)| tx.clone())
    }

    async fn ensure_upstream(self: &Arc<Self>) -> Result<mpsc::UnboundedSender<String>> {
        if let Some(tx) = self.current_upstream() {
            return Ok(tx);
        }
        if !self.is_hub.load(SeqCst) {
            let url = format!("ws://127.0.0.1:{}/peer", self.port);
            match tokio_tungstenite::connect_async(url).await {
                Ok((ws, _)) => self.attach_upstream(ws),
                Err(_) => {
                    self.try_become_hub().await;
                }
            }
        }
        let deadline = Instant::now() + CONNECT_WAIT;
        loop {
            if let Some(tx) = self.current_upstream() {
                return Ok(tx);
            }
            if Instant::now() >= deadline {
                bail!(
                    "the agy browser extension is not connected. Open Chrome and make sure the \
                     \"agy browser bridge\" extension is enabled (its icon shows ON when connected)."
                );
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    async fn handle_incoming(self: Arc<Self>, mut stream: TcpStream) {
        // The extension probes /ping before opening a WebSocket, because Chrome logs
        // every refused WebSocket as an extension error while a caught fetch is silent.
        let mut head = [0u8; 10];
        if let Ok(n) = stream.peek(&mut head).await {
            if head[..n].starts_with(b"GET /ping") {
                let _ = stream
                    .write_all(b"HTTP/1.1 204 No Content\r\nX-Agy-Browser: 1\r\nConnection: close\r\n\r\n")
                    .await;
                return;
            }
        }
        let mut role = None;
        let check = |req: &Request, resp: Response| -> std::result::Result<Response, ErrorResponse> {
            let origin = req.headers().get("origin").and_then(|o| o.to_str().ok());
            role = match (origin, req.uri().path()) {
                (Some(o), "/ext") if self.allowed_extension(o) => Some(Role::Extension),
                // Web pages always send an Origin, so a missing one means a local process.
                (None, "/peer") => Some(Role::Peer),
                _ => None,
            };
            if role.is_some() {
                Ok(resp)
            } else {
                let mut rejected = ErrorResponse::new(Some("forbidden".into()));
                *rejected.status_mut() = StatusCode::FORBIDDEN;
                Err(rejected)
            }
        };
        let Ok(ws) = tokio_tungstenite::accept_hdr_async(stream, check).await else {
            return;
        };
        match role {
            Some(Role::Extension) => self.attach_upstream(ws),
            Some(Role::Peer) => self.serve_peer(ws).await,
            None => {}
        }
    }

    fn allowed_extension(&self, origin: &str) -> bool {
        match origin.strip_prefix("chrome-extension://") {
            Some(id) => self.extension_id.as_deref().is_none_or(|want| want == id),
            None => false,
        }
    }

    /// Make `ws` the connection calls are sent to, and route its replies to waiting calls.
    fn attach_upstream<S>(self: &Arc<Self>, ws: WebSocketStream<S>)
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (mut sink, mut stream) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let conn = self.conn_seq.fetch_add(1, SeqCst) + 1;
        *self.upstream.lock().unwrap() = Some((conn, tx));

        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if sink.send(Message::text(msg)).await.is_err() {
                    break;
                }
            }
        });

        let this = self.clone();
        tokio::spawn(async move {
            while let Some(Ok(msg)) = stream.next().await {
                let Message::Text(text) = msg else { continue };
                let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                // Messages without an id are keepalives.
                let Some(id) = v["id"].as_u64() else { continue };
                let Some(waiter) = this.pending.lock().unwrap().remove(&id) else { continue };
                let reply = match v.get("error") {
                    Some(e) if !e.is_null() => Err(e.as_str().map(String::from).unwrap_or_else(|| e.to_string())),
                    _ => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = waiter.send(reply);
            }
            let mut upstream = this.upstream.lock().unwrap();
            if matches!(&*upstream, Some((c, _)) if *c == conn) {
                *upstream = None;
                // Dropping the senders fails in-flight calls right away instead of at the timeout.
                this.pending.lock().unwrap().clear();
            }
        });
    }

    /// Hub side of a peer connection: run each request through our own upstream.
    async fn serve_peer<S>(self: Arc<Self>, ws: WebSocketStream<S>)
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (mut sink, mut stream) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if sink.send(Message::text(msg)).await.is_err() {
                    break;
                }
            }
        });
        while let Some(Ok(msg)) = stream.next().await {
            let Message::Text(text) = msg else { continue };
            let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else { continue };
            let (Some(id), Some(method)) = (v.get("id").cloned(), v["method"].as_str()) else {
                continue;
            };
            let session = v["session"].as_str().unwrap_or("peer").to_string();
            let call = self.clone().call_boxed(session, method.to_string(), v["params"].clone());
            let tx = tx.clone();
            tokio::spawn(async move {
                let reply = match call.await {
                    Ok(result) => json!({ "id": id, "result": result }),
                    Err(e) => json!({ "id": id, "error": e.to_string() }),
                };
                let _ = tx.send(reply.to_string());
            });
        }
    }
}
