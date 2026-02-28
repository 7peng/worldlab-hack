import * as THREE from "three";
import {
  FOG_COLOR,
  FOG_DENSITY,
  CAMERA_FOV,
  CAMERA_NEAR,
  CAMERA_FAR,
  CAMERA_START_Y,
} from "../utils/constants";

export interface SceneContext {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  clock: THREE.Clock;
}

export function createScene(): SceneContext {
  const canvas = document.getElementById("canvas3d") as HTMLCanvasElement;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);
  scene.background = new THREE.Color(FOG_COLOR);

  const camera = new THREE.PerspectiveCamera(
    CAMERA_FOV,
    window.innerWidth / window.innerHeight,
    CAMERA_NEAR,
    CAMERA_FAR
  );
  camera.position.set(0, CAMERA_START_Y, 0);
  scene.add(camera);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const clock = new THREE.Clock();

  return { canvas, renderer, scene, camera, clock };
}

/**
 * WebGL context loss / recovery handlers.
 * Returns callbacks so main.ts can wire them into the game loop.
 */
export function setupContextRecovery(
  ctx: SceneContext,
  onLost: () => void,
  onRestored: () => void
) {
  ctx.canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    console.warn("WebGL context lost");
    onLost();
  });

  ctx.canvas.addEventListener("webglcontextrestored", () => {
    console.log("WebGL context restored");
    onRestored();
  });
}
