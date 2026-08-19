// ============================================================================
//  THE VAULT — Client Audio + WebRTC + Scream Detection
// ----------------------------------------------------------------------------
//  Responsibilities:
//    1. Connect to the WebSocket server (binary postcard frames).
//    2. Decode ServerMsg packets and dispatch them.
//    3. Build a WebRTC RTCPeerConnection per proximate peer.
//    4. Plug each peer's inbound MediaStream into a Web Audio API graph:
//         MediaStreamSource -> VoiceFx Chain -> Wall-Muffle Biquad -> Gain -> Destination
//    5. Run a local AnalyserNode on the mic input; when RMS exceeds the
//       SCREAM_THRESHOLD for SCREAM_HOLD_MS, send a Scream packet to the
//       server and trigger a local canvas shockwave particle ring.
//    6. Apply ChaosEvent-driven voice filter reconfiguration (helium/slime).
// ============================================================================

// ---------------------------------------------------------------------------
//  TINY POSTCARD DECODER
//  Wire format reference (matches postcard 1.0 / serde):
//    - u8            : 1 byte
//    - u16/u32/u64   : varint LEB128 (unsigned)
//    - bool          : 1 byte (0 or 1)
//    - f32           : 4 bytes, little-endian IEEE 754
//    - String/&str   : varint length prefix + UTF-8 bytes
//    - Vec<T>        : varint length prefix + N items
//    - enum variant  : varint tag + payload (in order)
//    - struct/tuple  : fields concatenated, no delimiter
// ---------------------------------------------------------------------------

class PostcardReader {
  constructor(buffer) {
    this.view = new DataView(buffer);
    this.offset = 0;
  }
  readU8()  { return this.view.getUint8(this.offset++); }
  readBool(){ return this.readU8() !== 0; }
  readVarint() {
    let result = 0, shift = 0;
    for (;;) {
      const byte = this.view.getUint8(this.offset++);
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      // Practical safety: varints > 5 bytes won't happen for our schema.
      if (shift > 35) throw new Error("varint overflow");
    }
    return result >>> 0;
  }
  readU16() { return this.readVarint(); }
  readU32() { return this.readVarint(); }
  readF32() {
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }
  readString() {
    const len = this.readVarint();
    const bytes = new Uint8Array(this.view.buffer, this.offset, len);
    this.offset += len;
    return new TextDecoder("utf-8").decode(bytes);
  }
  readVec(itemReader) {
    const len = this.readVarint();
    const out = new Array(len);
    for (let i = 0; i < len; i++) out[i] = itemReader(this);
    return out;
  }
}

class PostcardWriter {
  constructor() { this.bytes = []; }
  pushByte(b) { this.bytes.push(b & 0xff); }
  writeU8(v)  { this.pushByte(v); }
  writeBool(v){ this.pushByte(v ? 1 : 0); }
  writeVarint(v) {
    v = v >>> 0;
    while (v >= 0x80) {
      this.pushByte((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    this.pushByte(v);
  }
  writeU16(v) { this.writeVarint(v); }
  writeF32(v) {
    const tmp = new ArrayBuffer(4);
    new DataView(tmp).setFloat32(0, v, true);
    new Uint8Array(tmp).forEach(b => this.pushByte(b));
  }
  writeString(s) {
    const enc = new TextEncoder().encode(s);
    this.writeVarint(enc.length);
    enc.forEach(b => this.pushByte(b));
  }
  finalize() { return new Uint8Array(this.bytes); }
}

// ---------------------------------------------------------------------------
//  SCHEMA-SPECIFIC DECODERS — match the Rust enum/struct byte layout.
// ---------------------------------------------------------------------------

const CHAOS_EVENT_NAMES = ["Normal", "LowGravity", "SlipperyFloors", "HeliumVoices"];

function parseChaosEvent(r) {
  const tag = r.readVarint();
  return CHAOS_EVENT_NAMES[tag] ?? "Normal";
}

function parseWackyPlayerState(r) {
  return {
    id: r.readU16(),
    x: r.readF32(),
    z: r.readF32(),
    speed_modifier: r.readF32(),
    item_held_weight: r.readU8(),
    is_ragdolled: r.readBool(),
  };
}

function parseServerMsg(buffer) {
  const r = new PostcardReader(buffer);
  const tag = r.readVarint();
  switch (tag) {
    case 0: return { type: "Snapshot",
                     tick: r.readU32(),
                     players: r.readVec(parseWackyPlayerState),
                     chaos: parseChaosEvent(r) };
    case 1: return { type: "ProximityConnect",    with: r.readU16() };
    case 2: return { type: "ProximityDisconnect", with: r.readU16() };
    case 3: return { type: "WebRtcOffer",  from: r.readU16(), sdp: r.readString() };
    case 4: return { type: "WebRtcAnswer", from: r.readU16(), sdp: r.readString() };
    case 5: return { type: "WebRtcIce",    from: r.readU16(), candidate: r.readString() };
    case 6: return { type: "ScreamShockwave", from: r.readU16(), x: r.readF32(), z: r.readF32() };
    case 7: return { type: "ChaosChanged",    chaos: parseChaosEvent(r) };
    case 8: return { type: "AssignId",        id: r.readU16() };
    default: return { type: "Unknown" };
  }
}

function encodeClientMsg(msg) {
  const w = new PostcardWriter();
  switch (msg.type) {
    case "StateUpdate":
      w.writeVarint(0);
      w.writeF32(msg.x); w.writeF32(msg.z);
      w.writeF32(msg.speed_modifier); w.writeU8(msg.item_held_weight);
      break;
    case "Scream":
      w.writeVarint(1); w.writeF32(msg.volume);
      break;
    case "WebRtcOffer":
      w.writeVarint(2); w.writeU16(msg.to); w.writeString(msg.sdp);
      break;
    case "WebRtcAnswer":
      w.writeVarint(3); w.writeU16(msg.to); w.writeString(msg.sdp);
      break;
    case "WebRtcIce":
      w.writeVarint(4); w.writeU16(msg.to); w.writeString(msg.candidate);
      break;
    default: return null;
  }
  return w.finalize();
}

// ===========================================================================
//  AUDIO ENGINE
// ===========================================================================

const SCREAM_THRESHOLD_DB = -16;     // Volume above which we consider it a scream.
const SCREAM_HOLD_MS       = 220;     // Must sustain for this long to fire.
const SCREAM_COOLDOWN_MS   = 1500;   // One scream per 1.5s max from a single client.
const MIC_ANALYZER_FFT     = 1024;

class VaultAudioEngine {
  constructor(ws, canvas, onLocalState) {
    this.ws = ws;
    this.canvas = canvas;
    this.onLocalState = onLocalState; // (state) => void  -- callback to push StateUpdate
    this.myId = null;
    this.chaos = "Normal";

    // Web Audio context (lazily created on first user gesture due to mobile policy).
    this.audioCtx = null;
    this.localStream = null;
    this.localAnalyser = null;

    // Per-peer WebRTC + audio graph state.
    // peerId -> { pc: RTCPeerConnection, sourceNode, voiceFxChain, wallMuffle, gainNode }
    this.peers = new Map();

    // Per-peer muffle state (true if wall is currently between us and them).
    this.peerMuffle = new Map();

    // Scream detection state.
    this.screamStart = null;
    this.lastScreamAt = 0;
  }

  // -------------------------------------------------------------------------
  //  Bootstrap audio context + local mic. Must be called from a user gesture
  //  (e.g., a "Join Heist" button tap) — mobile Safari/Chrome require this.
  // -------------------------------------------------------------------------
  async initLocalAudio() {
    if (this.audioCtx) return;

    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false, // AGC masks screams — we want raw amplitude.
      },
      video: false,
    });

    // Wire local mic into an analyser for scream detection.
    const src = this.audioCtx.createMediaStreamSource(this.localStream);
    this.localAnalyser = this.audioCtx.createAnalyser();
    this.localAnalyser.fftSize = MIC_ANALYZER_FFT;
    this.localAnalyser.smoothingTimeConstant = 0.4;
    src.connect(this.localAnalyser);

    // Begin the scream detector loop.
    this._screamLoop();
  }

  // -------------------------------------------------------------------------
  //  Build (or rebuild) the audio graph for a peer based on current chaos +
  //  wall-muffle state. Called whenever either changes.
  //
  //  Graph topology:
  //    [MediaStreamSource]
  //        |
  //    [VoiceFXChain]        <-- BiquadFilter configured per chaos event
  //        |
  //    [WallMuffle Biquad]   <-- low-pass when through-wall, else passthrough
  //        |
  //    [GainNode]
  //        |
  //    [audioCtx.destination]
  // -------------------------------------------------------------------------
  _buildPeerGraph(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer || !this.audioCtx) return;

    // Tear down old nodes if rebuilding.
    if (peer.sourceNode) { try { peer.sourceNode.disconnect(); } catch {} }
    if (peer.voiceFx)    { try { peer.voiceFx.disconnect(); } catch {} }
    if (peer.wallMuffle) { try { peer.wallMuffle.disconnect(); } catch {} }
    if (peer.gainNode)   { try { peer.gainNode.disconnect(); } catch {} }

    const sourceNode = this.audioCtx.createMediaStreamSource(peer.stream);

    // --- Voice FX node (chaos-driven) ---
    // For Helium: highpass + boost (squeaky simulation).
    // For Slime:  lowpass + low cutoff (deep monster rumble).
    // For Normal/Slippery/LowGrav: passthrough (allpass with unity gain).
    const voiceFx = this.audioCtx.createBiquadFilter();
    switch (this.chaos) {
      case "HeliumVoices":
        voiceFx.type = "highpass";
        voiceFx.frequency.value = 800;    // Cut low end -> thin squeak.
        voiceFx.Q.value = 0.7;
        break;
      case "SlipperyFloors": // Slime-like effect
        voiceFx.type = "lowpass";
        voiceFx.frequency.value = 320;   // Muffled monster rumble.
        voiceFx.Q.value = 1.2;
        break;
      default:
        voiceFx.type = "allpass";        // Transparent passthrough.
        voiceFx.frequency.value = 1000;
        break;
    }

    // --- Wall muffle node ---
    // Even when chaos is "Normal", if a wall sits between us, we apply
    // a low-pass at 600Hz to simulate through-wall eavesdropping.
    const wallMuffle = this.audioCtx.createBiquadFilter();
    if (this.peerMuffle.get(peerId)) {
      wallMuffle.type = "lowpass";
      wallMuffle.frequency.value = 600;
      wallMuffle.Q.value = 0.5;
    } else {
      wallMuffle.type = "allpass";
    }

    // --- Gain stage ---
    const gainNode = this.audioCtx.createGain();
    gainNode.gain.value = 1.0;

    // Wire the chain.
    sourceNode.connect(voiceFx);
    voiceFx.connect(wallMuffle);
    wallMuffle.connect(gainNode);
    gainNode.connect(this.audioCtx.destination);

    peer.sourceNode = sourceNode;
    peer.voiceFx = voiceFx;
    peer.wallMuffle = wallMuffle;
    peer.gainNode = gainNode;
  }

  // -------------------------------------------------------------------------
  //  Set the wall-muffle flag for a peer (called by the game's wall-collision
  //  logic when a wall is between the local camera and a peer's 3D position).
  // -------------------------------------------------------------------------
  setPeerMuffled(peerId, muffled) {
    if (this.peerMuffle.get(peerId) === muffled) return;
    this.peerMuffle.set(peerId, muffled);
    this._buildPeerGraph(peerId);
  }

  // -------------------------------------------------------------------------
  //  Apply a chaos change to all peers. Rebuilds each graph.
  // -------------------------------------------------------------------------
  applyChaos(chaos) {
    this.chaos = chaos;
    for (const peerId of this.peers.keys()) {
      this._buildPeerGraph(peerId);
    }
  }

  // -------------------------------------------------------------------------
  //  WebRTC: create a peer connection, negotiate, attach inbound track.
  //  We are full-mesh P2P — server only ferries SDP/ICE between the pair.
  // -------------------------------------------------------------------------
  async _createPeerConnection(peerId, initiator) {
    if (this.peers.has(peerId)) return;

    const pc = new RTCPeerConnection({
      iceServers: [],            // local LAN — STUN/TURN unnecessary.
      iceTransportPolicy: "all",
    });

    // Push our local mic tracks into the connection.
    for (const track of this.localStream.getAudioTracks()) {
      pc.addTrack(track, this.localStream);
    }

    // Inbound track handler — fire when remote audio arrives.
    pc.ontrack = (event) => {
      const stream = event.streams[0];
      const peer = this.peers.get(peerId);
      if (peer) {
        peer.stream = stream;
        this._buildPeerGraph(peerId);
      }
    };

    // ICE candidate — relay to server for forwarding to the remote peer.
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this._send({
          type: "WebRtcIce",
          to: peerId,
          candidate: JSON.stringify(event.candidate),
        });
      }
    };

    this.peers.set(peerId, { pc, stream: null,
                             sourceNode: null, voiceFx: null,
                             wallMuffle: null, gainNode: null });

    // If we initiated the ProximityConnect, send the offer.
    if (initiator) {
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      this._send({ type: "WebRtcOffer", to: peerId, sdp: JSON.stringify(offer) });
    }
  }

  // -------------------------------------------------------------------------
  //  Incoming WebRTC signaling messages from the server.
  // -------------------------------------------------------------------------
  async handleWebRtcOffer(from, sdp) {
    // If we already have a connection, refuse (avoid duplicate offers).
    if (this.peers.has(from)) return;
    await this._createPeerConnection(from, /*initiator=*/false);
    const peer = this.peers.get(from);
    await peer.pc.setRemoteDescription(JSON.parse(sdp));
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    this._send({ type: "WebRtcAnswer", to: from, sdp: JSON.stringify(answer) });
  }

  async handleWebRtcAnswer(from, sdp) {
    const peer = this.peers.get(from);
    if (!peer) return;
    await peer.pc.setRemoteDescription(JSON.parse(sdp));
  }

  async handleWebRtcIce(from, candidate) {
    const peer = this.peers.get(from);
    if (!peer) return;
    try {
      await peer.pc.addIceCandidate(JSON.parse(candidate));
    } catch (e) {
      console.warn("ICE candidate add failed:", e);
    }
  }

  // -------------------------------------------------------------------------
  //  Tear down a peer connection (player walked out of voice range).
  // -------------------------------------------------------------------------
  disconnectPeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    try { peer.sourceNode?.disconnect(); } catch {}
    try { peer.voiceFx?.disconnect(); } catch {}
    try { peer.wallMuffle?.disconnect(); } catch {}
    try { peer.gainNode?.disconnect(); } catch {}
    try { peer.pc.close(); } catch {}
    this.peers.delete(peerId);
    this.peerMuffle.delete(peerId);
  }

  // -------------------------------------------------------------------------
  //  Scream detection loop. Reads AnalyserNode time-domain data, computes
  //  RMS amplitude in dBFS, and if it sustains above SCREAM_THRESHOLD_DB for
  //  SCREAM_HOLD_MS, fires a Scream packet + local canvas shockwave.
  // -------------------------------------------------------------------------
  _screamLoop() {
    const buf = new Uint8Array(this.localAnalyser.fftSize);
    const ctx2d = this.canvas.getContext("2d");

    const loop = () => {
      this.localAnalyser.getByteTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      // dBFS — clamp at -100 to avoid log(0).
      const db = 20 * Math.log10(Math.max(rms, 1e-5));

      const now = performance.now();
      if (db >= SCREAM_THRESHOLD_DB) {
        if (this.screamStart === null) this.screamStart = now;
        const heldMs = now - this.screamStart;
        if (heldMs >= SCREAM_HOLD_MS && (now - this.lastScreamAt) >= SCREAM_COOLDOWN_MS) {
          this.lastScreamAt = now;
          this.screamStart = null;
          this._fireScream(rms);
        }
      } else {
        this.screamStart = null;
      }

      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  _fireScream(volume) {
    // Tell the server — it will ragdoll nearby peers + broadcast shockwave.
    this._send({ type: "Scream", volume });

    // Optimistically render our own shockwave locally (server will also echo
    // it back via ScreamShockwave for other peers' clients to render).
    this._spawnShockwaveOnCanvas(this.myId, 0, 0); // local origin on canvas — game engine will translate.
  }

  // -------------------------------------------------------------------------
  //  Render a 3D shockwave particle ring on the canvas. Hook into the game's
  //  camera-project function to convert (worldX, worldZ) -> screen (sx, sy).
  //  For brevity we just draw a screen-centered expanding ring here.
  // -------------------------------------------------------------------------
  _spawnShockwaveOnCanvas(fromId, worldX, worldZ) {
    const ctx = this.canvas.getContext("2d");
    const start = performance.now();
    const DURATION = 600; // ms
    const draw = (now) => {
      const t = (now - start) / DURATION;
      if (t >= 1) return;
      const radius = 20 + t * 220;
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.lineWidth = 8 * (1 - t * 0.6);
      ctx.strokeStyle = "#ffe27a";
      ctx.beginPath();
      ctx.arc(this.canvas.width / 2, this.canvas.height / 2, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }

  // -------------------------------------------------------------------------
  //  WebSocket send helper.
  // -------------------------------------------------------------------------
  _send(msg) {
    const bytes = encodeClientMsg(msg);
    if (bytes && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(bytes);
    }
  }
}

// ===========================================================================
//  WEBSOCKET ENTRY POINT + DISPATCHER
// ===========================================================================

window.VaultClient = {
  /**
   * Call this from a "Join Heist" button tap (must be a user gesture for
   * mobile WebRTC + AudioContext policies).
   *
   * @param {string} wsUrl       e.g. "wss://thevault.local/ws"
   * @param {HTMLCanvasElement} canvas  Game canvas for shockwave overlay
   * @returns {Promise<VaultAudioEngine>}
   */
  async start(wsUrl, canvas) {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    const engine = new VaultAudioEngine(ws, canvas, null);
    await engine.initLocalAudio();

    ws.onmessage = (event) => {
      const bytes = new Uint8Array(event.data);
      const msg = parseServerMsg(bytes.buffer);
      switch (msg.type) {
        case "AssignId":
          engine.myId = msg.id;
          console.log("[vault] assigned id:", msg.id);
          // FIX: Tell the game engine to hide the join screen and set the ID
          if (window.onVaultAssignId) window.onVaultAssignId(msg.id);
          break;

        case "Snapshot":
          if (window.onVaultSnapshot) window.onVaultSnapshot(msg);
          break;

        case "ProximityConnect":
          engine._createPeerConnection(msg.with, initiator=(engine.myId < msg.with));
          break;

        case "ProximityDisconnect":
          engine.disconnectPeer(msg.with);
          break;

        case "WebRtcOffer":
          engine.handleWebRtcOffer(msg.from, msg.sdp);
          break;
        case "WebRtcAnswer":
          engine.handleWebRtcAnswer(msg.from, msg.sdp);
          break;
        case "WebRtcIce":
          engine.handleWebRtcIce(msg.from, msg.candidate);
          break;

        case "ScreamShockwave":
          engine._spawnShockwaveOnCanvas(msg.from, msg.x, msg.z);
          if (window.onVaultScream) window.onVaultScream(msg);
          break;

        case "ChaosChanged":
          engine.applyChaos(msg.chaos);
          if (window.onVaultChaosChanged) window.onVaultChaosChanged(msg.chaos);
          break;
      }
    };

    ws.onclose = () => console.warn("[vault] WS closed");
    ws.onerror = (e) => console.error("[vault] WS error", e);

    return engine;
  },

  /**
   * Helper to push the local player's state to the server at the game's
   * render frame rate (the engine will downsample internally if needed).
   */
  sendStateUpdate(engine, x, z, speedModifier, itemHeldWeight) {
    engine._send({
      type: "StateUpdate",
      x, z,
      speed_modifier: speedModifier,
      item_held_weight: itemHeldWeight,
    });
  },
};
