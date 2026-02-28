import { SplatMesh } from "@sparkjsdev/spark";
import * as THREE from "three";
import { CHUNK_SIZE, CLIENT_POLL_INTERVAL_MS } from "../utils/constants";

export interface ChunkState {
  x: number;
  y: number;
  splatMesh: SplatMesh | null;
  zone: "active" | "cached" | "purged";
  loading: boolean;
}

export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingError";
  }
}

function chunkKey(x: number, y: number): string {
  return `${x},${y}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll the server until the chunk is completed, then return the SPZ URL.
 * Throws after ~10 minutes if still not ready (safety valve).
 */
async function pollUntilReady(
  x: number,
  y: number,
  prompt: string,
  maxAttempts = 200
): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(CLIENT_POLL_INTERVAL_MS);

    try {
      const res = await fetch(
        `/api/chunk?x=${x}&y=${y}&prompt=${encodeURIComponent(prompt)}`
      );
      const data = await res.json().catch(() => null);

      if (data?.status === "billing_error") {
        throw new BillingError(data.error || "API billing error");
      }
      if (!res.ok) continue;

      if (data?.status === "completed" && data.spzUrl) {
        return data.spzUrl;
      }
      if (data?.status === "error") {
        throw new Error(`Chunk (${x},${y}) generation failed on server`);
      }
    } catch (err) {
      if (err instanceof BillingError) throw err;
      if ((err as Error).message.includes("generation failed")) throw err;
    }
  }
  throw new Error(`Chunk (${x},${y}) timed out waiting for generation`);
}

/**
 * Request a chunk from the server and load its SPZ into a Spark SplatMesh.
 *
 * - If the chunk is already generated, returns immediately.
 * - If the chunk is generating, polls until ready.
 * - If the chunk doesn't exist, triggers generation and polls.
 *
 * The SplatMesh is positioned in world-space at (x * CHUNK_SIZE, 0, y * CHUNK_SIZE).
 */
export async function loadChunk(
  x: number,
  y: number,
  prompt: string,
  scene: THREE.Scene
): Promise<ChunkState> {
  let res: Response;
  try {
    res = await fetch(
      `/api/chunk?x=${x}&y=${y}&prompt=${encodeURIComponent(prompt)}`
    );
  } catch {
    throw new Error(`Network error fetching chunk (${x},${y})`);
  }

  const data = await res.json();

  if (data.status === "billing_error") {
    throw new BillingError(data.error || "API billing error — out of credits");
  }

  if (!res.ok) {
    throw new Error(`Server returned ${res.status} for chunk (${x},${y})`);
  }

  let spzUrl: string;

  if (data.status === "completed" && data.spzUrl) {
    spzUrl = data.spzUrl;
  } else {
    spzUrl = await pollUntilReady(x, y, prompt);
  }

  const splatMesh = new SplatMesh({ url: spzUrl });
  await splatMesh.initialized;

  // World Labs splats are Y-flipped relative to Three.js
  splatMesh.scale.set(1, -1, 1);

  // Apply a small X/Z overlap so adjacent chunks slightly blend together
  // (helps hide seams when moving across chunk borders).
  const OVERLAP_FACTOR = 1.02;
  splatMesh.scale.x *= OVERLAP_FACTOR;
  splatMesh.scale.z *= OVERLAP_FACTOR;

  // Prevent frustum culling glitches at borders
  (splatMesh as any).frustumCulled = false;

  // Tweak underlying materials/textures to clamp edges and enable blending
  splatMesh.traverse((child: any) => {
    if (child?.isMesh && child.material) {
      const mat: any = child.material;
      mat.transparent = true;
      mat.side = THREE.DoubleSide;
      mat.depthWrite = false;
      if (mat.map) {
        mat.map.wrapS = THREE.ClampToEdgeWrapping;
        mat.map.wrapT = THREE.ClampToEdgeWrapping;
        mat.map.minFilter = THREE.LinearMipMapLinearFilter;
        mat.map.magFilter = THREE.LinearFilter;
        mat.map.needsUpdate = true;
      }
      mat.needsUpdate = true;
    }
  });

  splatMesh.position.set(x * CHUNK_SIZE, 0, y * CHUNK_SIZE);
  scene.add(splatMesh);

  return {
    x,
    y,
    splatMesh,
    zone: "active",
    loading: false,
  };
}

export { chunkKey };
