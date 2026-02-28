export const CHUNK_SIZE = 20; // increased to reduce API calls (larger chunks)

// Hysteresis zone thresholds (Chebyshev distance in chunk units)
export const ZONE_ACTIVE = 1;
export const ZONE_CACHED = 3;

// Max chunks that can be loading/generating at once (client-side cap)
export const MAX_PENDING_LOADS = 1;

// Fog hides chunk boundaries and load-in popping
export const FOG_COLOR = 0x000000;
export const FOG_DENSITY = 0.04;

// Camera defaults
export const CAMERA_FOV = 75;
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 200;
export const CAMERA_START_Y = 0;

// Fly controller
export const FLY_MOVE_SPEED = 4.8;
export const FLY_LOOK_SENSITIVITY = 0.002;
export const FLY_DAMPING = 0.92;

// Predictive fetching
export const WORST_CASE_LATENCY_S = 45;
export const MIN_PREDICT_DISTANCE = 1;
export const MAX_PREDICT_DISTANCE = 2;

// Radius (in chunks) to pre-load around the player when spawning/loading
export const PRELOAD_RADIUS = 1;

// How much larger each splat should be relative to the chunk spacing.
// 1.5 => 50% overlap between adjacent chunks.
export const CHUNK_OVERLAP_FACTOR = 1.5;

// Polling
export const CLIENT_POLL_INTERVAL_MS = 3000;
