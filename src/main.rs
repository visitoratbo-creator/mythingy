//! ============================================================================
//!  THE VAULT: ULTIMATE HEIST HAVOC  —  Embedded Game Server
//! ----------------------------------------------------------------------------
//!  Target: Raspberry Pi Zero 2 W  (512MB RAM, 4× Cortex-A53 @ 1GHz)
//!  Footprint budget: <15MB RAM, 30Hz tick, sub-1ms serialization.
//!
//!  The server NEVER touches:
//!    - 3D meshes / WebGL / visual rendering
//!    - Audio buffers / Web Audio graph / WebRTC media payloads
//!    - Physics collision meshes (uses pure Euclidean distance on f32 coords)
//!
//!  It ONLY coordinates:
//!    - Player position state (snapshots @ 30Hz)
//!    - WebRTC signaling relay (SDP / ICE strings forwarded by u16 player ID)
//!    - Proximity-based WebRTC pair-up triggers
//!    - Global ChaosEvent rotation (60s)
//!    - Scream shockwave ragdoll propagation
//! ============================================================================

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, RwLock};
use tokio::time::interval;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

// ============================================================================
//  CONSTANTS — Tuned for the Pi Zero 2 W's thermal + memory envelope
// ============================================================================

/// Network / simulation tick.  33.33ms = exactly 30 Hz.
const TICK_HZ: u64 = 30;
const TICK_DURATION: Duration = Duration::from_millis(1000 / TICK_HZ);

/// Distance (in world units) under which the server forces a P2P WebRTC link
/// between two players so they can exchange voice.
const PROXIMITY_THRESHOLD: f32 = 8.0;

/// Radius around a screaming player in which peers are ragdolled.
const SCREAM_RADIUS: f32 = 6.0;

/// How long a ragdolled player stays down before the snapshot clears the flag.
const RAGDOLL_DURATION: Duration = Duration::from_secs(2);

/// Global chaos modifier rotation cadence.
const CHAOS_INTERVAL: Duration = Duration::from_secs(60);

/// Hard cap — 8 mobile phones over local Wi-Fi is plenty for party chaos.
const MAX_PLAYERS: usize = 8;

/// TCP port the bare WebSocket server listens on.  nginx fronts TLS on 443.
const LISTEN_PORT: u16 = 8787;

// ============================================================================
//  WIRE PROTOCOL — All structs/enums below are postcard-encoded to bytes
// ============================================================================

/// Global server-forced game modifier. Rotates every 60 seconds.
/// Wire format: single varint tag (0..=3).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChaosEvent {
    Normal         = 0,
    LowGravity     = 1,
    SlipperyFloors = 2,
    HeliumVoices   = 3,
}

/// Per-player authoritative state. Pure math primitives — no meshes, no audio.
/// Wire format (postcard): u16, f32, f32, f32, u8, bool = 14 bytes/player.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
pub struct WackyPlayerState {
    pub id: u16,
    pub x: f32,
    pub z: f32,
    pub speed_modifier: f32,
    pub item_held_weight: u8, // Higher weight = slower movement / more sliding
    pub is_ragdolled: bool,   // True if knocked over by a scream shockwave
}

// ---------------------------------------------------------------------------
//  Client -> Server message envelope (binary postcard frame on the WS).
//  Tag is the first varint byte; payload follows.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone)]
enum ClientMsg {
    /// Local player moved / changed held item. Client is authoritative over
    /// its own avatar (mobiles can't be trusted to stay synced, but on a
    /// trusted LAN party this is by far the cheapest design).
    StateUpdate {
        x: f32,
        z: f32,
        speed_modifier: f32,
        item_held_weight: u8,
    } = 0,

    /// Local mic exceeded the scream threshold. Server uses the screamer's
    /// last known position to ragdoll nearby peers and broadcasts a
    /// ScreamShockwave so every client renders the particle ring.
    Scream { volume: f32 } = 1,

    /// WebRTC offer SDP. Forwarded verbatim to the targeted peer.
    WebRtcOffer  { to: u16, sdp: String } = 2,
    /// WebRTC answer SDP. Forwarded verbatim to the targeted peer.
    WebRtcAnswer { to: u16, sdp: String } = 3,
    /// Trickle ICE candidate. Forwarded verbatim to the targeted peer.
    WebRtcIce    { to: u16, candidate: String } = 4,
}

// ---------------------------------------------------------------------------
//  Server -> Client message envelope.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone)]
enum ServerMsg {
    /// 30Hz authoritative snapshot of every connected player.
    Snapshot {
        tick: u32,
        players: Vec<WackyPlayerState>,
        chaos: ChaosEvent,
    } = 0,

    /// "You are within voice-proximity of player `with` — open a WebRTC
    /// data channel + audio track to them now."  Server is signaling only.
    ProximityConnect { with: u16 } = 1,

    /// "Peer `from` no longer in voice range — close their RTCPeerConnection."
    ProximityDisconnect { with: u16 } = 2,

    /// Relayed WebRTC signaling payloads.
    WebRtcOffer  { from: u16, sdp: String } = 3,
    WebRtcAnswer { from: u16, sdp: String } = 4,
    WebRtcIce    { from: u16, candidate: String } = 5,

    /// A player screamed — render a 3D shockwave at (x,z) and knock over
    /// any nearby avatars (their is_ragdolled flag will follow in the next
    /// Snapshot).
    ScreamShockwave { from: u16, x: f32, z: f32 } = 6,

    /// Chaos modifier just rotated. Apply client-side visual / audio / physics
    /// changes (low gravity, slippery materials, helium-pitch shift, etc.).
    ChaosChanged { chaos: ChaosEvent } = 7,

    /// First message a client receives after WS handshake. Sets their ID.
    AssignId { id: u16 } = 8,
}

// ============================================================================
//  GLOBAL STATE — One RwLock, brief critical sections only.
// ============================================================================

/// Per-connection record. The `tx` channel is the only way the broadcast loop
/// or WebRTC relay pushes bytes to a player's WS sink task.
struct PlayerRecord {
    state: WackyPlayerState,
    tx: mpsc::UnboundedSender<Vec<u8>>,
    /// When `is_ragdolled` should be cleared by the tick loop.
    ragdolled_until: Option<Instant>,
}

struct GameState {
    players: HashMap<u16, PlayerRecord>,
    next_id: u16,
    chaos: ChaosEvent,
    tick: u32,
    /// Pairs currently linked via WebRTC. Tracked so we only emit
    /// ProximityConnect once per pair formation (and ProximityDisconnect once
    /// on breakup), avoiding signaling storm when two avatars linger nearby.
    active_pairs: HashSet<(u16, u16)>,
}

impl GameState {
    fn new() -> Self {
        Self {
            players: HashMap::with_capacity(MAX_PLAYERS),
            next_id: 1, // IDs start at 1; 0 reserved for "unassigned".
            chaos: ChaosEvent::Normal,
            tick: 0,
            active_pairs: HashSet::new(),
        }
    }
}

// ============================================================================
//  ENTRY POINT — Pinned to exactly 2 OS worker threads.
//  The Pi Zero 2 W has 4 cores; we leave 1 for the OS/nginx kernel work and
//  1 spare for bursty WebRTC signaling, while 2 Tokio threads saturate the
//  remaining budget without thrashing the scheduler.
// ============================================================================

#[tokio::main(worker_threads = 2)]
async fn main() {
    println!("[vault] booting — {} worker threads", 2);

    let listener = TcpListener::bind(("0.0.0.0", LISTEN_PORT))
        .await
        .expect("failed to bind TCP listener");

    println!("[vault] listening on ws://0.0.0.0:{LISTEN_PORT}");

    let state = Arc::new(RwLock::new(GameState::new()));

    // Spawn the broadcast + chaos rotation supervisor.
    let supervisor_state = state.clone();
    tokio::spawn(async move {
        supervisor_loop(supervisor_state).await;
    });

    // Accept loop. One task per connection. Cheap on Tokio.
    while let Ok((tcp_stream, peer_addr)) = listener.accept().await {
        let state = state.clone();
        tokio::spawn(async move {
            match accept_async(tcp_stream).await {
                Ok(ws_stream) => handle_connection(ws_stream, state).await,
                Err(e) => eprintln!("[vault] WS handshake failed from {peer_addr}: {e}"),
            }
        });
    }
}

// ============================================================================
//  CONNECTION LIFECYCLE
// ============================================================================

/// One async task per connected phone. Splits the WS into a reader (this task)
/// and a writer (spawned child task fed by an mpsc channel that other tasks
/// push into via the shared `GameState`).
async fn handle_connection(
    ws: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    state: Arc<RwLock<GameState>>,
) {
    // ---- 1. Assign ID + register in global state ------------------------
    let (id, rx) = {
        let mut gs = state.write().await;

        // Hard cap — reject overflow players with a clean close.
        if gs.players.len() >= MAX_PLAYERS {
            drop(gs);
            let _ = ws.close(None).await;
            return;
        }

        let id = gs.next_id;
        gs.next_id = gs.next_id.wrapping_add(1);
        // Skip 0 just in case we wrap.
        if gs.next_id == 0 {
            gs.next_id = 1;
        }

        let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
        gs.players.insert(
            id,
            PlayerRecord {
                state: WackyPlayerState {
                    id,
                    x: 0.0,
                    z: 0.0,
                    speed_modifier: 1.0,
                    item_held_weight: 0,
                    is_ragdolled: false,
                },
                tx,
                ragdolled_until: None,
            },
        );
        (id, rx)
    };

    println!("[vault] player {id} connected");

    // ---- 2. Split WS into sink (writer) + stream (reader) ---------------
    let (mut sink, mut stream) = ws.split();

    // Send the AssignId frame immediately.
    let assign_bytes = postcard::to_allocvec(&ServerMsg::AssignId { id })
        .expect("AssignId serialize");
    let _ = sink.send(Message::Binary(assign_bytes)).await;

    // ---- 3. Spawn writer task -------------------------------------------
    // Reads from `rx` (pushed by broadcast loop / relay logic) and pushes
    // to the WS sink. Exits when `rx` is dropped (i.e., this connection's
    // PlayerRecord is removed from the map).
    let writer_task = tokio::spawn(async move {
        let mut sink = sink;
        while let Some(bytes) = rx.recv().await {
            if sink.send(Message::Binary(bytes)).await.is_err() {
                break;
            }
        }
        let _ = sink.close(None).await;
    });

    // ---- 4. Reader loop (this task) -------------------------------------
    while let Some(msg_result) = stream.next().await {
        match msg_result {
            Ok(Message::Binary(data)) => {
                // Decode with postcard. Unknown / malformed frames are
                // silently dropped — never crash the server on bad client data.
                if let Ok(client_msg) = postcard::from_bytes::<ClientMsg>(&data) {
                    handle_client_msg(id, client_msg, &state).await;
                }
            }
            Ok(Message::Ping(p)) => {
                // tokio-tungstenite auto-pongs, but be defensive.
                // We can't easily send from here without sink; rely on lib default.
                let _ = p;
            }
            Ok(Message::Close(_)) | Err(_) => break,
            // Text/Binary/Pong — ignore. We are binary-only.
            _ => {}
        }
    }

    // ---- 5. Teardown ----------------------------------------------------
    writer_task.abort();

    let mut gs = state.write().await;
    // Remove the player. Also purge any active_pairs they were part of and
    // tell the other side to disconnect their RTCPeerConnection.
    let removed_pairs: Vec<u16> = gs
        .active_pairs
        .iter()
        .filter(|&&(a, b)| a == id || b == id)
        .map(|&&(a, b)| if a == id { b } else { a })
        .collect();

    for other in &removed_pairs {
        gs.active_pairs
            .remove(&(if *other < id { (*other, id) } else { (id, *other) }));
        if let Some(rec) = gs.players.get(other) {
            let bytes = postcard::to_allocvec(&ServerMsg::ProximityDisconnect { with: id })
                .expect("serialize");
            let _ = rec.tx.send(bytes);
        }
    }

    gs.players.remove(&id);
    println!("[vault] player {id} disconnected");
}

// ============================================================================
//  CLIENT MESSAGE DISPATCH
// ============================================================================

async fn handle_client_msg(from_id: u16, msg: ClientMsg, state: &Arc<RwLock<GameState>>) {
    match msg {
        // ----- Authoritative local movement update -----
        ClientMsg::StateUpdate { x, z, speed_modifier, item_held_weight } => {
            let mut gs = state.write().await;
            if let Some(rec) = gs.players.get_mut(&from_id) {
                // Ragdolled players cannot move — their client should suppress
                // updates, but defensively ignore any that arrive.
                if !rec.state.is_ragdolled {
                    rec.state.x = x;
                    rec.state.z = z;
                    rec.state.speed_modifier = speed_modifier;
                    rec.state.item_held_weight = item_held_weight;
                }
            }
        }

        // ----- Scream: ragdoll nearby peers + broadcast shockwave -----
        ClientMsg::Scream { volume: _ } => {
            let mut gs = state.write().await;

            // Pull screamer position first (immutable borrow), then mutably
            // iterate peers. The borrow checker is happy because the Option
            // we extract is owned (tuple of f32s), not a reference.
            let Some((sx, sz)) = gs.players.get(&from_id)
                .map(|r| (r.state.x, r.state.z))
            else {
                return;
            };

            let now = Instant::now();
            let ragdoll_until = now + RAGDOLL_DURATION;

            for (&pid, rec) in gs.players.iter_mut() {
                if pid == from_id {
                    continue;
                }
                let dx = rec.state.x - sx;
                let dz = rec.state.z - sz;
                let dist_sq = dx * dx + dz * dz;
                if dist_sq <= SCREAM_RADIUS * SCREAM_RADIUS {
                    rec.state.is_ragdolled = true;
                    rec.ragdolled_until = Some(ragdoll_until);
                }
            }

            // Broadcast shockwave to every connected client (so each renders
            // its own particle ring locally — server stays pure math).
            let msg = ServerMsg::ScreamShockwave { from: from_id, x: sx, z: sz };
            let bytes = postcard::to_allocvec(&msg).expect("serialize ScreamShockwave");
            for rec in gs.players.values() {
                let _ = rec.tx.send(bytes.clone());
            }
        }

        // ----- WebRTC signaling relay (targeted at a specific peer) -----
        ClientMsg::WebRtcOffer { to, sdp } => {
            relay_webrtc(from_id, to, ServerMsg::WebRtcOffer { from: from_id, sdp }, state).await;
        }
        ClientMsg::WebRtcAnswer { to, sdp } => {
            relay_webrtc(from_id, to, ServerMsg::WebRtcAnswer { from: from_id, sdp }, state).await;
        }
        ClientMsg::WebRtcIce { to, candidate } => {
            relay_webrtc(from_id, to, ServerMsg::WebRtcIce { from: from_id, candidate }, state).await;
        }
    }
}

/// Look up the target peer's tx channel under a *read* lock (no mutation needed)
/// and push the serialized message. Cheap and lock-free for the target's writer
/// task (mpsc::UnboundedSender::send is non-blocking).
async fn relay_webrtc(
    from: u16,
    to: u16,
    msg: ServerMsg,
    state: &Arc<RwLock<GameState>>,
) {
    let bytes = postcard::to_allocvec(&msg).expect("serialize webrtc msg");
    let gs = state.read().await;
    if let Some(rec) = gs.players.get(&to) {
        let _ = rec.tx.send(bytes);
    }
}

// ============================================================================
//  SUPERVISOR LOOP — 30Hz snapshot broadcast + 60s chaos rotation +
//  proximity WebRTC pair-up detection.
// ============================================================================

async fn supervisor_loop(state: Arc<RwLock<GameState>>) {
    let mut tick = interval(TICK_DURATION);
    let mut chaos_timer = interval(CHAOS_INTERVAL);
    // tokio::time::interval fires immediately on first .tick(). Consume the
    // chaos timer's initial fire so the first real rotation happens 60s in.
    chaos_timer.tick().await;

    loop {
        tokio::select! {
            _ = tick.tick() => {
                tick_step(&state).await;
            }
            _ = chaos_timer.tick() => {
                chaos_step(&state).await;
            }
        }
    }
}

/// Single 30Hz tick: clear expired ragdolls, detect proximity WebRTC pairs,
/// build snapshot, broadcast to all clients. Total work is O(n²) over player
/// count — at n=8 this is 28 pairs, ~microseconds on the Pi.
async fn tick_step(state: &Arc<RwLock<GameState>>) {
    let mut gs = state.write().await;
    gs.tick = gs.tick.wrapping_add(1);
    let tick_num = gs.tick;

    // ----- 1. Clear expired ragdolls -----
    let now = Instant::now();
    for rec in gs.players.values_mut() {
        if let Some(until) = rec.ragdolled_until {
            if now >= until {
                rec.state.is_ragdolled = false;
                rec.ragdolled_until = None;
            }
        }
    }

    // ----- 2. Snapshot positions for proximity math -----
    // Collect into a Vec to release the borrow before we mutate active_pairs
    // and call tx.send on individual records.
    let player_data: Vec<(u16, f32, f32)> = gs
        .players
        .iter()
        .map(|(&id, r)| (id, r.state.x, r.state.z))
        .collect();

    // ----- 3. Proximity pair detection -----
    // For each unordered pair (a,b) with a<b, if their Euclidean distance is
    // <= PROXIMITY_THRESHOLD and they're not already linked, fire
    // ProximityConnect to both. If they were linked and drifted apart,
    // fire ProximityDisconnect.
    let mut new_connections: Vec<(u16, u16)> = Vec::new();
    let mut broken_connections: Vec<(u16, u16)> = Vec::new();

    for i in 0..player_data.len() {
        for j in (i + 1)..player_data.len() {
            let (a_id, ax, az) = player_data[i];
            let (b_id, bx, bz) = player_data[j];
            let (lo, hi) = if a_id < b_id { (a_id, b_id) } else { (b_id, a_id) };
            let dx = ax - bx;
            let dz = az - bz;
            let dist_sq = dx * dx + dz * dz;
            let in_range = dist_sq <= PROXIMITY_THRESHOLD * PROXIMITY_THRESHOLD;
            let was_active = gs.active_pairs.contains(&(lo, hi));

            if in_range && !was_active {
                gs.active_pairs.insert((lo, hi));
                new_connections.push((lo, hi));
            } else if !in_range && was_active {
                gs.active_pairs.remove(&(lo, hi));
                broken_connections.push((lo, hi));
            }
        }
    }

    // ----- 4. Send proximity connect/disconnect signals -----
    for &(a, b) in &new_connections {
        let msg_a = ServerMsg::ProximityConnect { with: b };
        let msg_b = ServerMsg::ProximityConnect { with: a };
        let bytes_a = postcard::to_allocvec(&msg_a).expect("serialize");
        let bytes_b = postcard::to_allocvec(&msg_b).expect("serialize");
        if let Some(r) = gs.players.get(&a) { let _ = r.tx.send(bytes_a); }
        if let Some(r) = gs.players.get(&b) { let _ = r.tx.send(bytes_b); }
    }
    for &(a, b) in &broken_connections {
        let msg_a = ServerMsg::ProximityDisconnect { with: b };
        let msg_b = ServerMsg::ProximityDisconnect { with: a };
        let bytes_a = postcard::to_allocvec(&msg_a).expect("serialize");
        let bytes_b = postcard::to_allocvec(&msg_b).expect("serialize");
        if let Some(r) = gs.players.get(&a) { let _ = r.tx.send(bytes_a); }
        if let Some(r) = gs.players.get(&b) { let _ = r.tx.send(bytes_b); }
    }

    // ----- 5. Build & broadcast snapshot -----
    // Snapshot is built once (postcard-serialized once) and the same byte
    // slice is sent to every client's tx channel — zero per-client serialization.
    let players: Vec<WackyPlayerState> = gs.players.values().map(|r| r.state).collect();
    let chaos = gs.chaos;
    let snapshot = ServerMsg::Snapshot { tick: tick_num, players, chaos };
    let snapshot_bytes = postcard::to_allocvec(&snapshot).expect("serialize snapshot");

    for rec in gs.players.values() {
        let _ = rec.tx.send(snapshot_bytes.clone());
    }
}

/// Rotate the chaos modifier every 60 seconds and broadcast ChaosChanged.
async fn chaos_step(state: &Arc<RwLock<GameState>>) {
    let mut gs = state.write().await;
    gs.chaos = match gs.chaos {
        ChaosEvent::Normal         => ChaosEvent::LowGravity,
        ChaosEvent::LowGravity     => ChaosEvent::SlipperyFloors,
        ChaosEvent::SlipperyFloors => ChaosEvent::HeliumVoices,
        ChaosEvent::HeliumVoices   => ChaosEvent::Normal,
    };
    println!("[vault] chaos rotated -> {:?}", gs.chaos);

    let msg = ServerMsg::ChaosChanged { chaos: gs.chaos };
    let bytes = postcard::to_allocvec(&msg).expect("serialize ChaosChanged");
    for rec in gs.players.values() {
        let _ = rec.tx.send(bytes.clone());
    }
}
