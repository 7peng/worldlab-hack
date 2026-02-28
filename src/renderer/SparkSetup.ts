import { SparkRenderer } from "@sparkjsdev/spark";
import type * as THREE from "three";

/**
 * Create and mount a SparkRenderer.
 *
 * Attached as a child of the camera so that splat center float16 coordinates
 * stay high-precision relative to the viewer even when the camera moves far
 * from the world origin.
 */
export function createSpark(
  renderer: THREE.WebGLRenderer,
  camera: THREE.Camera
): SparkRenderer {
  const spark = new SparkRenderer({ renderer });
  camera.add(spark);
  return spark;
}
