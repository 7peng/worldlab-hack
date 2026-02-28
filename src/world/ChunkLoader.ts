import { SplatMesh } from "@sparkjsdev/spark";
import * as THREE from "three";
import { CHUNK_SIZE, CLIENT_POLL_INTERVAL_MS, CHUNK_OVERLAP_FACTOR } from "../utils/constants";

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

  // Apply overlap so adjacent chunks blend together (50% by default).
  splatMesh.scale.x *= CHUNK_OVERLAP_FACTOR;
  splatMesh.scale.z *= CHUNK_OVERLAP_FACTOR;

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

  // Inject an edge fading mask into each material to blend chunk borders.
  // CHUNK_HALF is half the scaled chunk extent; FADE_WIDTH controls the blending band.
  const CHUNK_HALF = CHUNK_SIZE * CHUNK_OVERLAP_FACTOR * 0.5;
  const FADE_WIDTH = Math.max(0.25, CHUNK_SIZE * 0.5);

  splatMesh.traverse((child: any) => {
    if (!(child?.isMesh && child.material)) return;
    const mat: any = child.material;
    if (mat.userData && mat.userData._edgeFadePatched) return;

    // Ensure material is prepared for transparency
    mat.transparent = true;
    mat.depthWrite = false;

    // Patch shader to include world-space position and edge fade
    mat.onBeforeCompile = (shader: any) => {
      shader.uniforms.chunkOrigin = { value: new THREE.Vector3(x * CHUNK_SIZE, 0, y * CHUNK_SIZE) };
      shader.uniforms.chunkHalf = { value: CHUNK_HALF };
      shader.uniforms.fadeWidth = { value: FADE_WIDTH };

      // Add varying for world position
      shader.vertexShader = 'varying vec3 vWorldPos;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        'gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );',
        'vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;\n\tgl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );'
      );

      // Inject uniforms and varying into fragment shader
      shader.fragmentShader = 'varying vec3 vWorldPos;\nuniform vec3 chunkOrigin;\nuniform float chunkHalf;\nuniform float fadeWidth;\n' + shader.fragmentShader;

      // Multiply final alpha by edge fade before writing out gl_FragColor
      shader.fragmentShader = shader.fragmentShader.replace(
        'gl_FragColor = vec4( outgoingLight, diffuseColor.a );',
        '\n  {\n    vec3 localPos = vWorldPos - chunkOrigin;\n    float edgeX = chunkHalf - abs(localPos.x);\n    float edgeZ = chunkHalf - abs(localPos.z);\n    float edgeDist = min(edgeX, edgeZ);\n    float fade = clamp(edgeDist / fadeWidth, 0.0, 1.0);\n    gl_FragColor = vec4( outgoingLight, diffuseColor.a * fade );\n  }'
      );
    };

    mat.userData._edgeFadePatched = true;
    mat.needsUpdate = true;
  });

  return {
    x,
    y,
    splatMesh,
    zone: "active",
    loading: false,
  };
}

export { chunkKey };
