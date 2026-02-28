import { createScene, setupContextRecovery, type SceneContext } from "./renderer/SceneSetup";
import { createSpark } from "./renderer/SparkSetup";
import { FlyController } from "./controls/FlyController";
import { ChunkManager } from "./world/ChunkManager";
import { CHUNK_SIZE } from "./utils/constants";
import type { SparkRenderer } from "@sparkjsdev/spark";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let ctx: SceneContext;
let spark: SparkRenderer;
let controller: FlyController;
let chunkManager: ChunkManager;
let gameLoopRunning = false;
let animFrameId = 0;
let initialized = false;
let minimapCanvas: HTMLCanvasElement | null = null;
let minimapCtx: CanvasRenderingContext2D | null = null;

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function showOverlay(msg?: string) {
  const overlay = document.getElementById("overlay")!;
  overlay.classList.remove("hidden");
  if (msg) {
    const h1 = overlay.querySelector("h1");
    if (h1) h1.textContent = msg;
  }
  fetchPastPrompts();
}

function hideOverlay() {
  document.getElementById("overlay")!.classList.add("hidden");
}

async function fetchPastPrompts() {
  const container = document.getElementById("past-prompts")!;
  const list = document.getElementById("past-prompts-list")!;

  try {
    const res = await fetch("/api/prompts");
    if (!res.ok) throw new Error("fetch failed");
    const prompts: { prompt: string; chunk_count: number }[] = await res.json();

    if (prompts.length === 0) {
      container.classList.add("hidden");
      return;
    }

    list.innerHTML = "";
    for (const p of prompts) {
      const li = document.createElement("li");
      li.className = "past-prompt-item";
      li.innerHTML = `<span class="past-prompt-text">${escapeHtml(p.prompt)}</span><span style="display:flex;align-items:center"><span class="chunk-count">${p.chunk_count} chunk${p.chunk_count !== 1 ? "s" : ""}</span><button class="delete-btn">Delete</button></span>`;
      li.addEventListener("click", () => {
        (document.getElementById("prompt-input") as HTMLInputElement).value = p.prompt;
        start(p.prompt);
      });

      // Delete handler
      const delBtn = li.querySelector(".delete-btn") as HTMLButtonElement | null;
      if (delBtn) {
        delBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete world and all chunks for:\n\n${p.prompt}\n\nThis cannot be undone.`)) return;
          try {
            await fetch("/api/chunks/reset", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ prompt: p.prompt }),
            });
            // Refresh the list
            fetchPastPrompts();
          } catch (err) {
            console.error("Failed to delete prompt:", err);
            alert("Failed to delete world. See console for details.");
          }
        });
      }

      list.appendChild(li);
    }
    container.classList.remove("hidden");
  } catch {
    container.classList.add("hidden");
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function updateHUD(dt: number) {
  const el = document.getElementById("hud");
  if (!el) return;

  const pos = controller.camera.position;
  const chunk = controller.getChunkCoords();
  const vel = controller.getVelocity();
  const fps = dt > 0 ? (1 / dt).toFixed(0) : "—";

  el.innerHTML = [
    `fps: ${fps}`,
    `pos: ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`,
    `chunk: (${chunk.x}, ${chunk.y})`,
    `vel: ${vel.length().toFixed(2)}`,
    `loaded: ${chunkManager.getLoadedCount()} | pending: ${chunkManager.getPendingCount()}`,
  ].join("<br>");
}

function updateMinimap() {
  if (!minimapCanvas || !minimapCtx || !chunkManager || !controller) return;

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const size = Math.min(220, Math.max(120, Math.min(window.innerWidth, window.innerHeight) * 0.18));
  minimapCanvas.style.width = `${size}px`;
  minimapCanvas.style.height = `${size}px`;
  minimapCanvas.width = Math.floor(size * dpr);
  minimapCanvas.height = Math.floor(size * dpr);
  minimapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Clear background
  minimapCtx.fillStyle = "#000";
  minimapCtx.fillRect(0, 0, size, size);

  // Grid params
  const radius = 6; // how many chunks from center to show
  const gridSize = radius * 2 + 1;
  const cell = size / gridSize;

  // Center chunk is at middle
  const centerX = Math.floor(gridSize / 2);
  const centerY = Math.floor(gridSize / 2);

  // Draw loaded chunks
  const loaded = chunkManager.getLoadedChunkCoords();
  const playerChunk = controller.getChunkCoords();

  minimapCtx.fillStyle = "#fff";
  for (const c of loaded) {
    const dx = c.x - playerChunk.x;
    const dy = c.y - playerChunk.y;
    if (Math.abs(dx) > radius || Math.abs(dy) > radius) continue;
    const sx = (centerX + dx) * cell;
    const sy = (centerY + dy) * cell;
    minimapCtx.fillRect(sx + 1, sy + 1, cell - 2, cell - 2);
  }

  // Draw continuous player marker (red dot) according to fractional world position
  const playerPos = controller.camera.position;
  const pxWorld = playerPos.x;
  const pzWorld = playerPos.z;
  const playerChunkX = playerChunk.x * CHUNK_SIZE;
  const playerChunkZ = playerChunk.y * CHUNK_SIZE;

  // Fractional offset from the center chunk in chunk-space (-0.5..0.5)
  const fracX = (pxWorld - playerChunkX) / CHUNK_SIZE;
  const fracY = (pzWorld - playerChunkZ) / CHUNK_SIZE; // note: z maps to vertical on minimap

  const dotX = centerX * cell + (0.5 + fracX) * cell - cell * 0.5;
  const dotY = centerY * cell + (0.5 + fracY) * cell - cell * 0.5;

  minimapCtx.fillStyle = "#ff4444";
  const dotR = Math.max(2, cell * 0.12);
  minimapCtx.beginPath();
  minimapCtx.arc(dotX + cell * 0.5, dotY + cell * 0.5, dotR, 0, Math.PI * 2);
  minimapCtx.fill();

  // Draw view direction line from the continuous dot
  const fwd = controller.getForwardXZ();
  const len = cell * 0.6;
  const sx = fwd.x * len;
  const sy = -fwd.z * len;
  minimapCtx.strokeStyle = "#ff4444";
  minimapCtx.lineWidth = 2;
  minimapCtx.beginPath();
  minimapCtx.moveTo(dotX + cell * 0.5, dotY + cell * 0.5);
  minimapCtx.lineTo(dotX + cell * 0.5 + sx, dotY + cell * 0.5 + sy);
  minimapCtx.stroke();

  // Draw border
  minimapCtx.strokeStyle = "rgba(255,255,255,0.06)";
  minimapCtx.lineWidth = 1;
  minimapCtx.strokeRect(0.5, 0.5, size - 1, size - 1);
}

// ---------------------------------------------------------------------------
// Game loop
// ---------------------------------------------------------------------------

function gameLoop() {
  if (!gameLoopRunning) return;
  animFrameId = requestAnimationFrame(gameLoop);

  const dt = ctx.clock.getDelta();

  controller.update(dt);
  chunkManager.update(controller);
  updateHUD(dt);
  updateMinimap();

  ctx.renderer.render(ctx.scene, ctx.camera);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function start(prompt: string) {
  hideOverlay();

  if (!initialized) {
    ctx = createScene();
    spark = createSpark(ctx.renderer, ctx.camera);
    controller = new FlyController(ctx.camera, ctx.canvas);
    chunkManager = new ChunkManager(ctx.scene, prompt);

    // Minimap setup
    minimapCanvas = document.getElementById("minimap") as HTMLCanvasElement;
    minimapCtx = minimapCanvas.getContext("2d");

    setupContextRecovery(
      ctx,
      () => {
        gameLoopRunning = false;
        cancelAnimationFrame(animFrameId);
        showOverlay("Rebuilding World...");
      },
      () => {
        ctx.renderer.setSize(window.innerWidth, window.innerHeight);
        spark = createSpark(ctx.renderer, ctx.camera);
        chunkManager.reloadActiveChunks();
        hideOverlay();
        gameLoopRunning = true;
        gameLoop();
      }
    );

    initialized = true;
  } else {
    chunkManager.changePrompt(prompt);
    controller.camera.position.set(0, 0, 0);
    controller.velocity.set(0, 0, 0);
  }

  document.getElementById("click-hint")?.classList.remove("hidden");

  gameLoopRunning = true;
  ctx.clock.start();
  gameLoop();
}

// ---------------------------------------------------------------------------
// Entry-point UI wiring
// ---------------------------------------------------------------------------

const promptInput = document.getElementById("prompt-input") as HTMLInputElement;
const startBtn = document.getElementById("start-btn") as HTMLButtonElement;

function onStart() {
  const prompt = promptInput.value.trim() || "A beautiful natural landscape with mountains and a river";
  start(prompt);
}

startBtn.addEventListener("click", onStart);
promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") onStart();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && initialized) {
    gameLoopRunning = false;
    cancelAnimationFrame(animFrameId);
    document.exitPointerLock();
    showOverlay("Enter a new prompt");
    promptInput.focus();
  }
});

// Fetch past prompts on initial page load (overlay is already visible)
fetchPastPrompts();
