import * as THREE from "three";
import {
  CHUNK_SIZE,
  WORST_CASE_LATENCY_S,
  MIN_PREDICT_DISTANCE,
  MAX_PREDICT_DISTANCE,
} from "../utils/constants";
import type { FlyController } from "../controls/FlyController";

interface ChunkCoord {
  x: number;
  y: number;
}

/**
 * Calculates which chunks to pre-fetch based on the player's velocity
 * and movement direction, accounting for the worst-case generation latency
 * of Marble 0.1-mini (~45 seconds).
 *
 * predictiveDistance = clamp(velocity * latency / chunkSize, MIN, MAX)
 *
 * Fetches in a cone along the forward direction and also includes neighbors
 * perpendicular to the movement to handle turning.
 */
export class PredictiveFetcher {
  private lastPrediction: ChunkCoord[] = [];
  private frameCounter = 0;

  /**
   * Returns the set of chunk coordinates that should be pre-fetched.
   * Only recalculates every 30 frames (~0.5s at 60fps) for efficiency.
   */
  getPredictedChunks(controller: FlyController): ChunkCoord[] {
    this.frameCounter++;
    if (this.frameCounter % 30 !== 0) return this.lastPrediction;

    const vel = controller.getVelocity();
    const speed = vel.length();
    const { x: cx, y: cy } = controller.getChunkCoords();

    if (speed < 0.1) {
      // Barely moving — fetch only direct neighbors (4 cardinal)
      this.lastPrediction = [
        { x: cx + 1, y: cy },
        { x: cx - 1, y: cy },
        { x: cx, y: cy + 1 },
        { x: cx, y: cy - 1 },
      ];
      return this.lastPrediction;
    }

    const predictDist = Math.ceil((speed * WORST_CASE_LATENCY_S) / CHUNK_SIZE);
    const clampedDist = Math.max(
      MIN_PREDICT_DISTANCE,
      Math.min(MAX_PREDICT_DISTANCE, predictDist)
    );

    const forward = controller.getForwardXZ();
    const results: ChunkCoord[] = [];
    const seen = new Set<string>();

    // Walk along the forward direction in chunk-grid steps
    for (let step = 1; step <= clampedDist; step++) {
      const worldX = cx * CHUNK_SIZE + forward.x * step * CHUNK_SIZE;
      const worldZ = cy * CHUNK_SIZE + forward.z * step * CHUNK_SIZE;

      const gx = Math.floor(worldX / CHUNK_SIZE + 0.5);
      const gy = Math.floor(worldZ / CHUNK_SIZE + 0.5);

      // Center chunk + perpendicular neighbors (cone spread)
      for (let spread = -1; spread <= 1; spread++) {
        const perpX = -forward.z;
        const perpZ = forward.x;
        const fx = Math.floor(gx + perpX * spread + 0.5);
        const fy = Math.floor(gy + perpZ * spread + 0.5);
        const key = `${fx},${fy}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ x: fx, y: fy });
        }
      }
    }

    this.lastPrediction = results;
    return results;
  }

  /** Simple ring of chunks at a given Chebyshev distance. */
  private ring(cx: number, cy: number, radius: number): ChunkCoord[] {
    const coords: ChunkCoord[] = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === radius) {
          coords.push({ x: cx + dx, y: cy + dy });
        }
      }
    }
    return coords;
  }
}
