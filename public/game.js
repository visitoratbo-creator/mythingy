import * as THREE from 'three';

// ============================================================================
//  THE VAULT: ULTIMATE HEIST HAVOC - 3D CLIENT ENGINE
// ----------------------------------------------------------------------------
//  Features:
//  - 3D Isometric WebGL rendering (Three.js)
//  - Client-side prediction & interpolation for remote players
//  - Wacky physics: Momentum sliding, heavy-lift tilting
//  - Touch Joystick + Keyboard support
//  - Audio Engine integration (Wall muffle raycasts, scream shockwaves)
// ============================================================================

class VaultGame {
  constructor() {
    this.engine = null; // VaultAudioEngine instance
    this.myId = null;
    
    // Three.js Core
    this.scene = new THREE.Scene();
    this.renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('game-canvas'), antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Cap at 2 for perf
    
    // Game State
    this.players = new Map(); // id -> { mesh, targetState, currentState, lastUpdate }
    this.loot = [];
    this.walls = [];
    this.shockwaves = [];
    this.chaos = "Normal";
    
    // Input
    this.input = { x: 0, z: 0, sprint: false };
    this.keys = {};
    
    // Clocks
    this.lastStateSent = 0;
    this.clock = new THREE.Clock();
  }

  // --------------------------------------------------------------------------
  //  INITIALIZATION
  // --------------------------------------------------------------------------
  async init() {
    document.getElementById('join-btn').addEventListener('click', async () => {
      // FIX: Hardcode port 8787 to match the Rust binary, bypassing Python http port
      const wsUrl = `ws://${location.hostname}:8787/ws`;
      this.engine = await VaultClient.start(wsUrl, document.getElementById('game-canvas'));
      this.setupNetworkHooks();
    });

    this.setupScene();
    this.setupInput();
    window.addEventListener('resize', () => this.onResize());
    this.onResize();
    
    // Start render loop
    this.renderer.setAnimationLoop(() => this.update());
  }

  setupScene() {
    // Isometric Orthographic Camera
    const aspect = window.innerWidth / window.innerHeight;
    const d = 15; // Zoom distance
    this.camera = new THREE.OrthographicCamera(-d * aspect, d * aspect, d, -d, 1, 1000);
    this.camera.position.set(20, 20, 20);
    this.camera.lookAt(0, 0, 0);

    // Lighting
    const ambient = new THREE.AmbientLight(0x404040, 1.5);
    this.scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(10, 20, 10);
    this.scene.add(dirLight);

    // Floor
    const floorGeo = new THREE.PlaneGeometry(50, 50);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.8 });
    this.floor = new THREE.Mesh(floorGeo, floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.scene.add(this.floor);

    // Extraction Zone (Center Elevator)
    const elevGeo = new THREE.CylinderGeometry(4, 4, 0.2, 32);
    const elevMat = new THREE.MeshStandardMaterial({ color: 0xffe27a, emissive: 0xffae00, transparent: true, opacity: 0.6 });
    this.elevator = new THREE.Mesh(elevGeo, elevMat);
    this.elevator.position.y = 0.1;
    this.scene.add(this.elevator);

    // Interior Walls (for muffle raycast testing)
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x884444 });
    for(let i=0; i<4; i++) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 10), wallMat);
      wall.position.set(i % 2 === 0 ? -8 : 8, 2, i < 2 ? -6 : 6);
      wall.userData.isWall = true;
      this.scene.add(wall);
      this.walls.push(wall);
    }

    // Loot generation
    for(let i=0; i<5; i++) {
      const weight = Math.floor(Math.random() * 3) + 1; // 1 to 3
      const size = 0.5 + weight * 0.3;
      const loot = new THREE.Mesh(
        new THREE.BoxGeometry(size, size, size),
        new THREE.MeshStandardMaterial({ color: weight === 3 ? 0xffd700 : 0x8b4513 })
      );
      loot.position.set((Math.random()-0.5)*20, size/2, (Math.random()-0.5)*20);
      loot.userData.weight = weight;
      this.scene.add(loot);
      this.loot.push(loot);
    }
  }

  setupInput() {
    // Keyboard
    window.addEventListener('keydown', e => this.keys[e.code] = true);
    window.addEventListener('keyup', e => this.keys[e.code] = false);

    // Touch Joystick
    const zone = document.getElementById('joystick-zone');
    const base = document.getElementById('joystick-base');
    const thumb = document.getElementById('joystick-thumb');
    let touchId = null;

    zone.addEventListener('touchstart', e => {
      e.preventDefault();
      touchId = e.changedTouches[0].identifier;
      const rect = zone.getBoundingClientRect();
      const x = e.changedTouches[0].clientX - rect.left;
      const y = e.changedTouches[0].clientY - rect.top;
      base.style.left = (x - 60) + 'px';
      base.style.top = (y - 60) + 'px';
      thumb.style.left = (x - 30) + 'px';
      thumb.style.top = (y - 30) + 'px';
      base.style.display = 'block';
      thumb.style.display = 'block';
    });

    zone.addEventListener('touchmove', e => {
      e.preventDefault();
      for(let touch of e.changedTouches) {
        if(touch.identifier === touchId) {
          const rect = zone.getBoundingClientRect();
          let dx = touch.clientX - rect.left - (parseFloat(base.style.left) + 60);
          let dy = touch.clientY - rect.top - (parseFloat(base.style.top) + 60);
          let dist = Math.sqrt(dx*dx + dy*dy);
          const maxDist = 40;
          if(dist > maxDist) { dx = (dx/dist)*maxDist; dy = (dy/dist)*maxDist; }
          
          thumb.style.left = (parseFloat(base.style.left) + 60 + dx - 30) + 'px';
          thumb.style.top = (parseFloat(base.style.top) + 60 + dy - 30) + 'px';
          
          this.input.x = dx / maxDist;
          this.input.z = dy / maxDist;
        }
      }
    });

    const endTouch = e => {
      if(touchId !== null) {
        touchId = null;
        base.style.display = 'none';
        thumb.style.display = 'none';
        this.input.x = 0; this.input.z = 0;
      }
    };
    zone.addEventListener('touchend', endTouch);
    zone.addEventListener('touchcancel', endTouch);
  }

  setupNetworkHooks() {
    window.onVaultSnapshot = (msg) => this.onSnapshot(msg);
    window.onVaultScream = (msg) => this.onScream(msg);
    window.onVaultChaosChanged = (chaos) => this.onChaosChanged(chaos);
  }

  // --------------------------------------------------------------------------
  //  STATE & NETWORKING
  // --------------------------------------------------------------------------
  onSnapshot(msg) {
    document.getElementById('ui-tick').innerText = msg.tick;
    
    let localState = null;
    const now = performance.now();

    msg.players.forEach(p => {
      if (!this.players.has(p.id)) {
        this.createPlayerMesh(p.id);
      }
      const player = this.players.get(p.id);
      player.targetState = p;
      player.lastUpdate = now;

      if (p.id === this.myId) {
        localState = p;
        // Sync ragdoll state immediately if server says we fell
        if (p.is_ragdolled && !player.currentState.is_ragdolled) {
          this.triggerLocalRagdoll();
        }
      }
    });

    // Clean up disconnected players
    for (const [id, player] of this.players) {
      if (!msg.players.find(p => p.id === id)) {
        this.scene.remove(player.mesh);
        this.players.delete(id);
      }
    }
  }

  onScream(msg) {
    // Spawn 3D shockwave ring
    const ringGeo = new THREE.RingGeometry(0.1, 0.5, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xff4d6d, transparent: true, opacity: 1, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(msg.x, 0.2, msg.z);
    ring.rotation.x = -Math.PI / 2;
    this.scene.add(ring);
    this.shockwaves.push({ mesh: ring, life: 1.0 });

    // If I am near the scream, get knocked over
    const me = this.players.get(this.myId);
    if (me && msg.from !== this.myId) {
      const dx = me.currentState.x - msg.x;
      const dz = me.currentState.z - msg.z;
      const distSq = dx*dx + dz*dz;
      if (distSq <= 6.0 * 6.0) { // SCREAM_RADIUS squared
        me.knockback = new THREE.Vector3(dx, 0, dz).normalize().multiplyScalar(15);
      }
    }
  }

  onChaosChanged(chaos) {
    this.chaos = chaos;
    document.getElementById('ui-chaos').innerText = chaos;
    
    const banner = document.getElementById('chaos-banner');
    banner.innerText = chaos.replace(/([A-Z])/g, ' $1').trim().toUpperCase() + "!";
    banner.style.opacity = 1;
    setTimeout(() => banner.style.opacity = 0, 2500);

    // Change floor color based on chaos
    switch(chaos) {
      case 'SlipperyFloors': this.floor.material.color.setHex(0x88ccff); break;
      case 'LowGravity': this.floor.material.color.setHex(0x2a1a3a); break;
      case 'HeliumVoices': this.floor.material.color.setHex(0xffddff); break;
      default: this.floor.material.color.setHex(0x333333);
    }
  }

  createPlayerMesh(id) {
    const group = new THREE.Group();
    const color = id === this.myId ? 0x00ff00 : 0xff0000;
    
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.5, 1, 4, 8),
      new THREE.MeshStandardMaterial({ color })
    );
    body.position.y = 1;
    group.add(body);
    
    // Add eyes for direction facing
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.1), eyeMat);
    leftEye.position.set(-0.2, 1.2, 0.5);
    const rightEye = new THREE.Mesh(new THREE.SphereGeometry(0.1), eyeMat);
    rightEye.position.set(0.2, 1.2, 0.5);
    group.add(leftEye, rightEye);

    this.scene.add(group);
    this.players.set(id, {
      mesh: group,
      body: body,
      currentState: { x: 0, z: 0, speed_modifier: 1, item_held_weight: 0, is_ragdolled: false, velocity: new THREE.Vector3() },
      targetState: null,
      lastUpdate: 0,
      knockback: new THREE.Vector3()
    });
  }

  // --------------------------------------------------------------------------
  //  MAIN UPDATE LOOP
  // --------------------------------------------------------------------------
  update() {
    const dt = Math.min(this.clock.getDelta(), 0.05); // Clamp dt to 50ms
    this.handleLocalInput(dt);
    this.interpolatePlayers(dt);
    this.updateShockwaves(dt);
    this.updateAudioMuffle(); // Raycast for WebRTC audio walls
    this.renderer.render(this.scene, this.camera);
  }

  handleLocalInput(dt) {
    if (!this.myId || !this.players.has(this.myId)) return;
    const me = this.players.get(this.myId);

    if (me.currentState.is_ragdolled) {
      me.ragdollTimer -= dt;
      if (me.ragdollTimer <= 0) {
        me.currentState.is_ragdolled = false;
        me.body.material.color.setHex(0x00ff00);
      } else {
        // Spin wildly while ragdolled
        me.mesh.rotation.y += dt * 15;
        me.mesh.rotation.x += dt * 8;
        return;
      }
    }

    // Keyboard overrides joystick if pressed
    let inX = this.input.x, inZ = this.input.z;
    if (this.keys['KeyW']) inZ = -1;
    if (this.keys['KeyS']) inZ = 1;
    if (this.keys['KeyA']) inX = -1;
    if (this.keys['KeyD']) inX = 1;

    const moveVec = new THREE.Vector3(inX, 0, inZ);
    if (moveVec.lengthSq() > 1) moveVec.normalize();

    // Apply Chaos Physics
    let speed = 5.0;
    let friction = 10.0;
    if (this.chaos === 'SlipperyFloors') friction = 0.5;
    if (this.chaos === 'LowGravity') speed *= 1.2;

    // Heavy item physics
    const weight = me.currentState.item_held_weight;
    speed *= me.currentState.speed_modifier; // Server tells us our modifier based on held item
    
    // Add momentum
    me.currentState.velocity.x += moveVec.x * speed * dt * (weight > 0 ? 0.5 : 1.0);
    me.currentState.velocity.z += moveVec.z * speed * dt * (weight > 0 ? 0.5 : 1.0);

    // Apply knockback decay
    if (me.knockback.lengthSq() > 0) {
      me.currentState.velocity.add(me.knockback.clone().multiplyScalar(dt));
      me.knockback.multiplyScalar(0.9);
    }

    // Friction
    me.currentState.velocity.x -= me.currentState.velocity.x * friction * dt;
    me.currentState.velocity.z -= me.currentState.velocity.z * friction * dt;

    // Move
    me.currentState.x += me.currentState.velocity.x * dt;
    me.currentState.z += me.currentState.velocity.z * dt;

    // Clamp to arena
    me.currentState.x = THREE.MathUtils.clamp(me.currentState.x, -24, 24);
    me.currentState.z = THREE.MathUtils.clamp(me.currentState.z, -24, 24);

    // Update visual mesh
    me.mesh.position.x = me.currentState.x;
    me.mesh.position.z = me.currentState.z;

    // Wacky Tilt based on momentum and weight
    const velMag = me.currentState.velocity.length();
    if (velMag > 0.1) {
      const tilt = Math.min(0.4, velMag * 0.05 * (1 + weight * 0.5));
      me.mesh.rotation.x = -me.currentState.velocity.z * tilt;
      me.mesh.rotation.z = me.currentState.velocity.x * tilt;
    } else {
      me.mesh.rotation.x *= 0.9;
      me.mesh.rotation.z *= 0.9;
    }

    // Network Send Rate (15Hz to save mobile battery, server interpolates)
    if (performance.now() - this.lastStateSent > 66) {
      this.lastStateSent = performance.now();
      VaultClient.sendStateUpdate(
        this.engine,
        me.currentState.x,
        me.currentState.z,
        me.currentState.speed_modifier,
        me.currentState.item_held_weight
      );
    }
  }

  triggerLocalRagdoll() {
    const me = this.players.get(this.myId);
    me.currentState.is_ragdolled = true;
    me.ragdollTimer = 2.0; // matches server RAGDOLL_DURATION
    me.body.material.color.setHex(0xffff00);
  }

  interpolatePlayers(dt) {
    const now = performance.now();
    for (const [id, player] of this.players) {
      if (id === this.myId) continue;
      if (!player.targetState) continue;

      const t = Math.min(1, dt * 10); // Lerp factor
      player.mesh.position.x = THREE.MathUtils.lerp(player.mesh.position.x, player.targetState.x, t);
      player.mesh.position.z = THREE.MathUtils.lerp(player.mesh.position.z, player.targetState.z, t);

      // Tilt
      if (player.targetState.is_ragdolled) {
        player.mesh.rotation.y += dt * 10;
      } else {
        player.mesh.rotation.x *= 0.9;
        player.mesh.rotation.z *= 0.9;
      }
    }
  }

  updateShockwaves(dt) {
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const sw = this.shockwaves[i];
      sw.life -= dt * 1.5;
      sw.mesh.scale.set(1 + (1 - sw.life) * 15, 1 + (1 - sw.life) * 15, 1);
      sw.mesh.material.opacity = Math.max(0, sw.life);
      
      if (sw.life <= 0) {
        this.scene.remove(sw.mesh);
        sw.mesh.geometry.dispose();
        sw.mesh.material.dispose();
        this.shockwaves.splice(i, 1);
      }
    }
  }

  // --------------------------------------------------------------------------
  //  AUDIO / WEBRTC MUFFLE LOGIC
  //  Raycasts from local player camera to remote players. If a wall is hit,
  //  tell the VaultAudioEngine to apply the low-pass muffle filter.
  // --------------------------------------------------------------------------
  updateAudioMuffle() {
    if (!this.engine || !this.myId) return;
    
    const localPlayer = this.players.get(this.myId);
    if (!localPlayer) return;

    const origin = new THREE.Vector3(localPlayer.mesh.position.x, 1.5, localPlayer.mesh.position.z);
    
    for (const [id, player] of this.players) {
      if (id === this.myId) continue;

      const target = new THREE.Vector3(player.mesh.position.x, 1.5, player.mesh.position.z);
      const direction = target.clone().sub(origin);
      const distance = direction.length();
      direction.normalize();

      // Simple raycast against wall meshes
      this.raycaster = new THREE.Raycaster(origin, direction, 0.5, distance);
      const intersects = this.raycaster.intersectObjects(this.walls, false);
      
      // If we hit a wall before reaching the target, muffle them
      const isMuffled = intersects.length > 0;
      this.engine.setPeerMuffled(id, isMuffled);
    }
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}

// Boot the game
const game = new VaultGame();
game.init();

// Expose globally so audio.js hooks can trigger AssignId
window.VaultGame = game;
window.onVaultAssignId = (id) => {
  game.myId = id;
  document.getElementById('ui-id').innerText = id;
  document.getElementById('join-screen').classList.add('hidden');
};
