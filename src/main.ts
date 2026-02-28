import { createScene, setupContextRecovery, type SceneContext } from "./renderer/SceneSetup";
import { createSpark } from "./renderer/SparkSetup";
import { FlyController } from "./controls/FlyController";
import { ChunkManager } from "./world/ChunkManager";
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
      li.innerHTML = `<span class="past-prompt-text">${escapeHtml(p.prompt)}</span><span class="chunk-count">${p.chunk_count} chunk${p.chunk_count !== 1 ? "s" : ""}</span>`;
      li.addEventListener("click", () => {
        (document.getElementById("prompt-input") as HTMLInputElement).value = p.prompt;
        start(p.prompt);
      });
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
