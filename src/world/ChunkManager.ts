import * as THREE from "three";
import type { SplatMesh } from "@sparkjsdev/spark";
import { CHUNK_SIZE, ZONE_ACTIVE, ZONE_CACHED, MAX_PENDING_LOADS, PRELOAD_RADIUS } from "../utils/constants";
import { loadChunk, chunkKey, BillingError, type ChunkState } from "./ChunkLoader";
import { PredictiveFetcher } from "./PredictiveFetcher";
import type { FlyController } from "../controls/FlyController";

const RETRY_COOLDOWN_MS = 10_000;

const WIRE_COLOR = 0x00ccff;
const WIRE_OPACITY = 0.35;
const WIRE_PULSE_SPEED = 2.5;

const wireGeo = new THREE.BoxGeometry(CHUNK_SIZE, CHUNK_SIZE * 0.6, CHUNK_SIZE);
const wireEdges = new THREE.EdgesGeometry(wireGeo);

function createWireframe(x: number, y: number): THREE.LineSegments {
  const mat = new THREE.LineBasicMaterial({
    color: WIRE_COLOR,
    transparent: true,
    opacity: WIRE_OPACITY,
    depthWrite: false,
  });
  const mesh = new THREE.LineSegments(wireEdges, mat);
  mesh.position.set(x * CHUNK_SIZE, CHUNK_SIZE * 0.3, y * CHUNK_SIZE);
  mesh.renderOrder = 999;
  return mesh;
}

/**
 * ChunkManager owns the lifecycle of all loaded chunks.
 *
 * Each frame it:
 *  1. Reads the player's current chunk position
 *  2. Ensures all chunks in the active zone are loaded
 *  3. Applies the 3-zone hysteresis (active / cached / purged)
 *  4. Delegates to PredictiveFetcher for look-ahead requests
 */
export class ChunkManager {
  private chunks = new Map<string, ChunkState>();
  private pendingLoads = new Set<string>();
  private failedLoads = new Map<string, number>();
  private wireframes = new Map<string, THREE.LineSegments>();
  private scene: THREE.Scene;
  private prompt: string;
  private fetcher: PredictiveFetcher;
  private billingHalted = false;
  private lastUpdateTime = performance.now() / 1000;

  constructor(scene: THREE.Scene, prompt: string) {
    this.scene = scene;
    this.prompt = prompt;
    this.fetcher = new PredictiveFetcher();
  }

  /** Preload a square grid of chunks centered on the player's current chunk. */
  preloadGrid(controller: any, radius = 1) {
    const { x: cx, y: cy } = controller.getChunkCoords();
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        this.requestChunk(cx + dx, cy + dy);
      }
    }
  }

  /** Chebyshev (chessboard) distance between two chunk coords. */
  private dist(ax: number, ay: number, bx: number, by: number): number {
    return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
  }

  /**
   * Main update — call every frame.
   */
  update(controller: FlyController) {
    const t = performance.now() / 1000;
    const dt = Math.min(0.1, t - this.lastUpdateTime);
    this.lastUpdateTime = t;

    const { x: cx, y: cy } = controller.getChunkCoords();

    // 1. Always request the chunk the player is standing on first
    this.requestChunk(cx, cy);

    // 2. Only expand to neighbors once at least one chunk is loaded
    // Use PRELOAD_RADIUS to control how many chunks to spawn/preload around the player.
    if (this.chunks.size > 0) {
      for (let dx = -PRELOAD_RADIUS; dx <= PRELOAD_RADIUS; dx++) {
        for (let dy = -PRELOAD_RADIUS; dy <= PRELOAD_RADIUS; dy++) {
          if (dx === 0 && dy === 0) continue;
          this.requestChunk(cx + dx, cy + dy);
        }
      }

      // 3. Predictive fetching only when we have loaded chunks
      const predictedChunks = this.fetcher.getPredictedChunks(controller);
      for (const { x, y } of predictedChunks) {
        this.requestChunk(x, y);
      }
    }

    // 3. Pulse wireframe opacity so loading chunks feel alive
    for (const wire of this.wireframes.values()) {
      const mat = wire.material as THREE.LineBasicMaterial;
      mat.opacity = WIRE_OPACITY + 0.2 * Math.sin(t * WIRE_PULSE_SPEED);
    }

    // 4. Hysteresis zone management with smooth fade to avoid popping/seams
    const FADE_SPEED = 6.0; // alpha units per second
    for (const [key, chunk] of this.chunks) {
      if (!chunk.splatMesh || chunk.loading) continue;

      const d = this.dist(chunk.x, chunk.y, cx, cy);

      if (d > ZONE_CACHED) {
        // Purge: free VRAM
        this.purgeChunk(key, chunk);
        continue;
      }

      // Desired alpha: 1 when active, 0 when cached
      const desiredAlpha = d <= ZONE_ACTIVE ? 1 : 0;

      // Ensure userData fade state exists on the splatMesh
      const mesh: any = chunk.splatMesh as any;
      if (mesh.userData.fade == null) mesh.userData.fade = 1;

      // Smoothly approach desired alpha
      if (mesh.userData.fade < desiredAlpha) {
        mesh.userData.fade = Math.min(desiredAlpha, mesh.userData.fade + FADE_SPEED * dt);
      } else if (mesh.userData.fade > desiredAlpha) {
        mesh.userData.fade = Math.max(desiredAlpha, mesh.userData.fade - FADE_SPEED * dt);
      }

      // Apply opacity to all child materials
      mesh.traverse((child: any) => {
        if (child?.isMesh && child.material) {
          const m: any = child.material;
          if (typeof m.opacity === "number") {
            m.opacity = mesh.userData.fade;
            m.transparent = m.opacity < 1;
            m.needsUpdate = true;
          }
        }
      });

      // Visibility: keep in scene while fading, hide only when fully transparent
      mesh.visible = mesh.userData.fade > 0.001;

      // Update zone state once settled
      const newZone = mesh.userData.fade >= 0.999 ? "active" : mesh.userData.fade <= 0.001 ? "cached" : chunk.zone;
      chunk.zone = newZone as any;
    }
  }

  /**
   * Request a chunk. If `opts.forceParallel` is true this will bypass the
   * usual MAX_PENDING_LOADS throttle so multiple chunks (eg. a 3x3 preload)
   * can be loaded in parallel for a fast startup.
   */
  private requestChunk(x: number, y: number) {
    if (this.billingHalted) return;

    const key = chunkKey(x, y);
    if (this.chunks.has(key) || this.pendingLoads.has(key)) return;

    const failedAt = this.failedLoads.get(key);
    if (failedAt && Date.now() - failedAt < RETRY_COOLDOWN_MS) return;

    if (this.pendingLoads.size >= MAX_PENDING_LOADS) return;

    this.pendingLoads.add(key);
    this.failedLoads.delete(key);

    const wire = createWireframe(x, y);
    this.scene.add(wire);
    this.wireframes.set(key, wire);

    loadChunk(x, y, this.prompt, this.scene)
      .then((state) => {
        this.removeWireframe(key);
        this.chunks.set(key, state);
        this.pendingLoads.delete(key);
        this.updateChunkStatusUI();
      })
      .catch((err) => {
        this.removeWireframe(key);
        this.pendingLoads.delete(key);

        if (err instanceof BillingError) {
          this.billingHalted = true;
          this.showBillingError(err.message);
          return;
        }

        console.error(`Failed to load chunk (${x},${y}):`, err.message);
        this.failedLoads.set(key, Date.now());
      });
  }

  private removeWireframe(key: string) {
    const wire = this.wireframes.get(key);
    if (wire) {
      this.scene.remove(wire);
      (wire.material as THREE.Material).dispose();
      this.wireframes.delete(key);
    }
  }

  private purgeChunk(key: string, chunk: ChunkState) {
    if (chunk.splatMesh) {
      this.scene.remove(chunk.splatMesh);
      chunk.splatMesh.dispose();
      chunk.splatMesh = null;
    }
    chunk.zone = "purged";
    this.chunks.delete(key);
  }

  /** Re-load chunks in the active zone (used after WebGL context recovery). */
  reloadActiveChunks() {
    const keys = [...this.chunks.keys()];
    for (const key of keys) {
      const chunk = this.chunks.get(key)!;
      if (chunk.zone === "active" || chunk.zone === "cached") {
        this.purgeChunk(key, chunk);
      }
    }
  }

  /** Destroy every loaded chunk and reset all state. */
  purgeAll() {
    for (const [key, chunk] of this.chunks) {
      this.purgeChunk(key, chunk);
    }
    for (const key of [...this.wireframes.keys()]) {
      this.removeWireframe(key);
    }
    this.chunks.clear();
    this.pendingLoads.clear();
    this.failedLoads.clear();
  }

  /**
   * Switch to a different prompt.
   * Purges client-side 3D objects but preserves server-side cached chunks
   * so past worlds can be loaded instantly.
   */
  changePrompt(newPrompt: string) {
    this.purgeAll();
    this.prompt = newPrompt;
    if (this.billingHalted) {
      this.billingHalted = false;
      fetch("/api/clear-error", { method: "POST" }).catch(() => {});
      const el = document.getElementById("chunk-status");
      if (el) {
        el.style.color = "";
        el.textContent = "";
      }
    }
  }

  /** Update the on-screen chunk status indicator. */
  private updateChunkStatusUI() {
    const el = document.getElementById("chunk-status");
    if (!el) return;

    const active = [...this.chunks.values()].filter((c) => c.zone === "active").length;
    const cached = [...this.chunks.values()].filter((c) => c.zone === "cached").length;
    const loading = this.pendingLoads.size;

    el.textContent = `chunks: ${active} active / ${cached} cached / ${loading} loading`;
  }

  private showBillingError(msg: string) {
    console.error(`[billing] ${msg}`);
    const el = document.getElementById("chunk-status");
    if (el) {
      el.textContent = `API ERROR: ${msg}`;
      el.style.color = "#ff4444";
    }
  }

  getLoadedCount(): number {
    return this.chunks.size;
  }

  getPendingCount(): number {
    return this.pendingLoads.size;
  }

  /** Return an array of loaded chunk coordinates for UI/debugging (minimap). */
  getLoadedChunkCoords(): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.splatMesh && chunk.zone !== "purged") {
        out.push({ x: chunk.x, y: chunk.y });
      }
    }
    return out;
  }
}
