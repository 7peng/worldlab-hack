import * as THREE from "three";
import {
  FLY_MOVE_SPEED,
  FLY_LOOK_SENSITIVITY,
  FLY_DAMPING,
  CHUNK_SIZE,
  CAMERA_START_Y,
} from "../utils/constants";

/**
 * Pointer-lock fly-through camera controller.
 * No physics engine — pure kinematic camera with velocity damping.
 */
export class FlyController {
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;

  velocity = new THREE.Vector3();
  moveSpeed: number;
  lookSensitivity: number;
  damping: number;

  private pitch = 0;
  private yaw = 0;
  private keys = new Set<string>();
  private locked = false;

  constructor(
    camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
    opts?: { moveSpeed?: number; lookSensitivity?: number; damping?: number }
  ) {
    this.camera = camera;
    this.canvas = canvas;
    this.moveSpeed = opts?.moveSpeed ?? FLY_MOVE_SPEED;
    this.lookSensitivity = opts?.lookSensitivity ?? FLY_LOOK_SENSITIVITY;
    this.damping = opts?.damping ?? FLY_DAMPING;

    // Extract initial yaw/pitch from camera quaternion
    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
    this.yaw = euler.y;
    this.pitch = euler.x;

    this.bindEvents();
  }

  private bindEvents() {
    // Pointer lock
    this.canvas.addEventListener("click", () => {
      if (!this.locked) this.canvas.requestPointerLock();
    });

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.canvas;
      const crosshair = document.getElementById("crosshair");
      const clickHint = document.getElementById("click-hint");
      if (this.locked) {
        crosshair?.classList.remove("hidden");
        clickHint?.classList.add("hidden");
      } else {
        crosshair?.classList.add("hidden");
        clickHint?.classList.remove("hidden");
      }
    });

    // Mouse look
    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.lookSensitivity;
      this.pitch -= e.movementY * this.lookSensitivity;
      this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
    });

    // Keyboard
    document.addEventListener("keydown", (e) => this.keys.add(e.code));
    document.addEventListener("keyup", (e) => this.keys.delete(e.code));
  }

  /**
   * Call every frame with deltaTime.
   * Applies acceleration from key input, damping, and updates camera transform.
   */
  update(dt: number) {
    // Build local-space movement direction
    const input = new THREE.Vector3();

    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) input.z += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) input.z -= 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) input.x -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) input.x += 1;
    if (this.keys.has("Space")) input.y += 1;
    if (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")) input.y -= 1;

    if (input.lengthSq() > 0) {
      input.normalize();

      // Rotate input by camera's yaw (horizontal direction only for XZ)
      const forward = new THREE.Vector3(0, 0, -1).applyAxisAngle(
        new THREE.Vector3(0, 1, 0),
        this.yaw
      );
      const right = new THREE.Vector3(1, 0, 0).applyAxisAngle(
        new THREE.Vector3(0, 1, 0),
        this.yaw
      );

      const accel = new THREE.Vector3();
      // Ignore vertical input to restrict movement to XZ plane
      accel.addScaledVector(right, input.x);
      accel.addScaledVector(forward, input.z);

      this.velocity.addScaledVector(accel, this.moveSpeed * dt);
    }

    // Damping
    this.velocity.multiplyScalar(this.damping);

    // Zero-out vertical velocity and integrate position only on XZ
    this.velocity.y = 0;
    const deltaPos = new THREE.Vector3().copy(this.velocity).multiplyScalar(dt);
    this.camera.position.add(deltaPos);

    // Prevent moving up/down: clamp camera Y
    this.camera.position.y = CAMERA_START_Y;

    // Apply rotation
    const quat = new THREE.Quaternion();
    quat.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
    this.camera.quaternion.copy(quat);
  }

  getVelocity(): THREE.Vector3 {
    return this.velocity.clone();
  }

  /** Returns the chunk grid coordinates the camera is currently in. */
  getChunkCoords(): { x: number; y: number } {
    return {
      x: Math.floor(this.camera.position.x / CHUNK_SIZE + 0.5),
      y: Math.floor(this.camera.position.z / CHUNK_SIZE + 0.5),
    };
  }

  /** Camera forward direction projected onto the XZ plane (normalized). */
  getForwardXZ(): THREE.Vector3 {
    const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      this.yaw
    );
    fwd.y = 0;
    fwd.normalize();
    return fwd;
  }
}
