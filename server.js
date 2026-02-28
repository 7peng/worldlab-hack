import "dotenv/config";
import express from "express";
import cors from "cors";
import initSqlJs from "sql.js";
import axios from "axios";
import sharp from "sharp";
import crypto from "node:crypto";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "3001", 10);
const API_KEY = process.env.WORLDLABS_API_KEY;
const WORLDLABS_BASE = "https://api.worldlabs.ai";
const CHUNKS_DIR = path.resolve("chunks");
const DATA_DIR = path.resolve("data");
const DB_PATH = path.join(DATA_DIR, "chunks.db");
const POLL_INTERVAL_MS = 3000;

if (!API_KEY || API_KEY === "your_key_here") {
  console.warn("WARNING: WORLDLABS_API_KEY not set in .env — chunk generation will fail.");
  console.warn("The server will still start so the frontend loads. Set your API key to enable generation.");
}

fs.mkdirSync(CHUNKS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

function promptHash(prompt) {
  return crypto.createHash("md5").update(prompt).digest("hex").slice(0, 8);
}

// ---------------------------------------------------------------------------
// SQLite via sql.js (pure WASM, no native build required)
// ---------------------------------------------------------------------------

let db;

async function initDB() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Migrate: if old schema lacks `prompt` column, drop and recreate
  const tableInfo = db.exec("PRAGMA table_info(chunks)");
  const hasPrompt = tableInfo.length > 0 && tableInfo[0].values.some((col) => col[1] === "prompt");
  if (tableInfo.length > 0 && !hasPrompt) {
    console.log("[db] Migrating: old schema detected, recreating chunks table");
    db.run("DROP TABLE IF EXISTS chunks");
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS chunks (
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      operation_id TEXT,
      world_id TEXT,
      spz_path TEXT,
      pano_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (x, y, prompt)
    )
  `);
  saveDB();
}

function saveDB() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function dbGet(x, y, prompt) {
  const stmt = db.prepare("SELECT * FROM chunks WHERE x = ? AND y = ? AND prompt = ?");
  stmt.bind([x, y, prompt]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function dbInsertIfAbsent(x, y, prompt) {
  const existing = dbGet(x, y, prompt);
  if (existing) return false;
  db.run("INSERT INTO chunks (x, y, prompt, status) VALUES (?, ?, ?, 'generating')", [x, y, prompt]);
  saveDB();
  return true;
}

function dbUpdate(x, y, prompt, status, operationId, worldId, spzPath, panoUrl) {
  const safe = (v) => (v === undefined ? null : v);
  db.run(
    "UPDATE chunks SET status = ?, operation_id = ?, world_id = ?, spz_path = ?, pano_url = ? WHERE x = ? AND y = ? AND prompt = ?",
    [safe(status), safe(operationId), safe(worldId), safe(spzPath), safe(panoUrl), x, y, prompt]
  );
  saveDB();
}

function dbDelete(x, y, prompt) {
  db.run("DELETE FROM chunks WHERE x = ? AND y = ? AND prompt = ?", [x, y, prompt]);
  saveDB();
}

function dbGetNeighbor(x, y, prompt) {
  const stmt = db.prepare(
    "SELECT * FROM chunks WHERE x = ? AND y = ? AND prompt = ? AND status = 'completed' AND pano_url IS NOT NULL"
  );
  stmt.bind([x, y, prompt]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function dbGetAll(prompt) {
  const results = [];
  let stmt;
  if (prompt) {
    stmt = db.prepare("SELECT x, y, status FROM chunks WHERE prompt = ?");
    stmt.bind([prompt]);
  } else {
    stmt = db.prepare("SELECT x, y, status FROM chunks");
  }
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function dbGetPrompts() {
  const results = [];
  const stmt = db.prepare(
    "SELECT prompt, COUNT(*) as chunk_count, MAX(created_at) as last_used FROM chunks WHERE status = 'completed' GROUP BY prompt ORDER BY last_used DESC"
  );
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

// ---------------------------------------------------------------------------
// World Labs API helpers
// ---------------------------------------------------------------------------

function wlHeaders() {
  return {
    "Content-Type": "application/json",
    "WLT-Api-Key": API_KEY,
  };
}

async function startGeneration(prompt, edgeImageBase64) {
  let worldPrompt;

  if (edgeImageBase64) {
    worldPrompt = {
      type: "image",
      image_prompt: {
        source: "data_base64",
        data_base64: edgeImageBase64,
        extension: "png",
      },
      text_prompt: prompt,
    };
  } else {
    worldPrompt = {
      type: "text",
      text_prompt: prompt,
    };
  }

  const body = {
    display_name: `chunk_${Date.now()}`,
    model: "Marble 0.1-mini",
    world_prompt: worldPrompt,
  };

  const res = await axios.post(
    `${WORLDLABS_BASE}/marble/v1/worlds:generate`,
    body,
    { headers: wlHeaders() }
  );

  return res.data;
}

async function pollOperation(operationId) {
  while (true) {
    const res = await axios.get(
      `${WORLDLABS_BASE}/marble/v1/operations/${operationId}`,
      { headers: wlHeaders() }
    );
    const op = res.data;

    if (op.done) {
      if (op.error) {
        throw new Error(
          `Generation failed: ${op.error.message || JSON.stringify(op.error)}`
        );
      }
      return op;
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

async function downloadFile(url, destPath) {
  const res = await axios.get(url, { responseType: "arraybuffer" });
  fs.writeFileSync(destPath, Buffer.from(res.data));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Edge-Image Continuity (using sharp for image processing)
// ---------------------------------------------------------------------------

const NEIGHBOR_OFFSETS = [
  { dx: -1, dy: 0, label: "left" },
  { dx: 1, dy: 0, label: "right" },
  { dx: 0, dy: -1, label: "below" },
  { dx: 0, dy: 1, label: "above" },
];

/**
 * Extract a border strip from a neighbor's equirectangular panorama
 * using sharp (no native canvas dependency).
 */
async function extractEdgeImage(panoUrl, direction) {
  const response = await axios.get(panoUrl, { responseType: "arraybuffer" });
  const imgBuffer = Buffer.from(response.data);
  const metadata = await sharp(imgBuffer).metadata();
  const w = metadata.width;
  const h = metadata.height;

  let left, top, width, height;

  switch (direction) {
    case "left":
      left = Math.floor(w * 0.75);
      top = 0;
      width = w - Math.floor(w * 0.75);
      height = h;
      break;
    case "right":
      left = 0;
      top = 0;
      width = Math.floor(w * 0.25);
      height = h;
      break;
    case "below":
      left = 0;
      top = 0;
      width = w;
      height = Math.floor(h * 0.3);
      break;
    case "above":
      left = 0;
      top = Math.floor(h * 0.7);
      width = w;
      height = h - Math.floor(h * 0.7);
      break;
    default:
      return null;
  }

  const cropped = await sharp(imgBuffer)
    .extract({ left, top, width, height })
    .png()
    .toBuffer();

  return cropped.toString("base64");
}

async function getEdgeImageForChunk(x, y, prompt) {
  for (const { dx, dy, label } of NEIGHBOR_OFFSETS) {
    const neighbor = dbGetNeighbor(x + dx, y + dy, prompt);
    if (neighbor && neighbor.pano_url) {
      try {
        const b64 = await extractEdgeImage(neighbor.pano_url, label);
        if (b64) {
          console.log(
            `  Edge image extracted from neighbor (${x + dx},${y + dy}) [${label}]`
          );
          return b64;
        }
      } catch (err) {
        console.warn(
          `  Failed to extract edge from (${x + dx},${y + dy}):`,
          err.message
        );
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Background generation pipeline with concurrency queue
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_GENERATIONS = 1;
let activeGenerations = 0;
const generationQueue = [];
let rateLimitBackoffUntil = 0;
let apiError = null; // persistent error (402 billing, etc.) that halts all generation

function enqueueGeneration(x, y, prompt) {
  const key = `${x},${y},${prompt}`;
  if (generationQueue.some((job) => `${job.x},${job.y},${job.prompt}` === key)) {
    return;
  }
  generationQueue.push({ x, y, prompt });
  drainQueue();
}

function drainQueue() {
  if (apiError) {
    console.log(`[queue] Halted — ${apiError}. ${generationQueue.length} jobs discarded.`);
    generationQueue.length = 0;
    return;
  }

  while (activeGenerations < MAX_CONCURRENT_GENERATIONS && generationQueue.length > 0) {
    const now = Date.now();
    if (now < rateLimitBackoffUntil) {
      const waitMs = rateLimitBackoffUntil - now;
      console.log(`[queue] Rate-limited, waiting ${Math.ceil(waitMs / 1000)}s before next generation`);
      setTimeout(drainQueue, waitMs);
      return;
    }
    const job = generationQueue.shift();
    activeGenerations++;
    generateChunk(job.x, job.y, job.prompt).finally(() => {
      activeGenerations--;
      drainQueue();
    });
  }
  if (generationQueue.length > 0) {
    console.log(`[queue] ${generationQueue.length} jobs waiting, ${activeGenerations} active`);
  }
}

async function generateChunk(x, y, prompt) {
  const hash = promptHash(prompt);
  try {
    console.log(
      `[gen] Starting generation for chunk (${x},${y}) [${hash}] prompt="${prompt}"`
    );

    const edgeImage = await getEdgeImageForChunk(x, y, prompt);

    const genResponse = await startGeneration(prompt, edgeImage);
    const operationId = genResponse.operation_id;
    console.log(`[gen] Chunk (${x},${y}) [${hash}] operation: ${operationId}`);

    dbUpdate(x, y, prompt, "generating", operationId, null, null, null);

    const completed = await pollOperation(operationId);
    const world = completed.response;
    const worldId = world?.id ?? null;

    const spzUrl =
      world?.assets?.splats?.spz_urls?.["500k"] ||
      world?.assets?.splats?.spz_urls?.full_res;
    if (!spzUrl) {
      throw new Error("No SPZ URL returned from API");
    }

    const spzFilename = `chunk_${hash}_${x}_${y}.spz`;
    const spzPath = path.join(CHUNKS_DIR, spzFilename);
    await downloadFile(spzUrl, spzPath);
    console.log(`[gen] Downloaded SPZ -> ${spzFilename}`);

    const panoUrl = world?.assets?.imagery?.pano_url ?? null;

    dbUpdate(x, y, prompt, "completed", operationId ?? null, worldId, `/chunks/${spzFilename}`, panoUrl);
    console.log(`[gen] Chunk (${x},${y}) [${hash}] complete!`);
  } catch (err) {
    const msg = err?.message ?? String(err);
    const status = err?.response?.status;
    const is429 = msg.includes("429") || status === 429;
    const is402 = msg.includes("402") || status === 402;

    if (is402) {
      apiError = "HTTP 402 — Payment Required (out of API credits)";
      console.error(`[gen] FATAL: ${apiError}. All generation halted.`);
    } else if (is429) {
      const backoffSec = 60;
      rateLimitBackoffUntil = Date.now() + backoffSec * 1000;
      console.warn(`[gen] 429 rate-limited! Backing off ${backoffSec}s. Queue paused.`);
    }

    console.error(`[gen] Chunk (${x},${y}) [${hash}] failed:`, msg);
    try {
      // Use "billing_error" for 402 so it isn't auto-retried
      const errStatus = is402 ? "billing_error" : "error";
      dbUpdate(x, y, prompt, errStatus, null, null, null, null);
    } catch (dbErr) {
      console.error(`[gen] Failed to update DB for error state:`, dbErr);
    }
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

app.use("/chunks", express.static(CHUNKS_DIR));

app.get("/api/chunk", (req, res) => {
  const x = parseInt(req.query.x, 10);
  const y = parseInt(req.query.y, 10);
  const prompt = req.query.prompt || "A beautiful natural landscape";

  if (isNaN(x) || isNaN(y)) {
    return res.status(400).json({ error: "x and y must be integers" });
  }

  if (!API_KEY || API_KEY === "your_key_here") {
    return res.status(503).json({ error: "WORLDLABS_API_KEY not configured", status: "error" });
  }

  if (apiError) {
    return res.status(402).json({ error: apiError, status: "billing_error" });
  }

  const existing = dbGet(x, y, prompt);

  if (existing) {
    if (existing.status === "completed") {
      return res.json({
        status: "completed",
        spzUrl: existing.spz_path,
      });
    }
    if (existing.status === "generating") {
      return res.json({ status: "generating" });
    }
    if (existing.status === "billing_error") {
      return res.status(402).json({ error: "API billing error — out of credits", status: "billing_error" });
    }
    if (existing.status === "error") {
      dbDelete(x, y, prompt);
    }
  }

  const inserted = dbInsertIfAbsent(x, y, prompt);
  if (!inserted) {
    return res.json({ status: "generating" });
  }

  enqueueGeneration(x, y, prompt);

  return res.json({ status: "started" });
});

app.get("/api/chunks/status", (req, res) => {
  const prompt = req.query.prompt || null;
  const rows = dbGetAll(prompt);
  res.json(rows);
});

app.get("/api/prompts", (_req, res) => {
  const prompts = dbGetPrompts();
  res.json(prompts);
});

app.post("/api/chunks/reset", (req, res) => {
  const { prompt } = req.body || {};

  if (prompt) {
    const hash = promptHash(prompt);
    console.log(`[reset] Clearing chunks for prompt [${hash}]: "${prompt}"`);
    db.run("DELETE FROM chunks WHERE prompt = ?", [prompt]);
    saveDB();

    // Remove SPZ files for this prompt
    const prefix = `chunk_${hash}_`;
    try {
      for (const file of fs.readdirSync(CHUNKS_DIR)) {
        if (file.startsWith(prefix)) {
          fs.unlinkSync(path.join(CHUNKS_DIR, file));
        }
      }
    } catch (err) {
      console.warn("[reset] Failed to clean chunk files:", err.message);
    }
  } else {
    console.log("[reset] Clearing ALL chunks");
    db.run("DELETE FROM chunks");
    saveDB();
    try {
      for (const file of fs.readdirSync(CHUNKS_DIR)) {
        fs.unlinkSync(path.join(CHUNKS_DIR, file));
      }
    } catch (err) {
      console.warn("[reset] Failed to clean chunk files:", err.message);
    }
  }

  res.json({ ok: true });
});

app.post("/api/clear-error", (_req, res) => {
  if (apiError) {
    console.log(`[server] Clearing API error: ${apiError}`);
    apiError = null;
    // Also clear billing_error rows so they can be retried
    db.run("DELETE FROM chunks WHERE status = 'billing_error'");
    saveDB();
  }
  res.json({ ok: true, apiError: null });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  await initDB();

  // Clear any stale "generating" or "error" rows left from a previous crash
  db.run("DELETE FROM chunks WHERE status IN ('generating', 'error', 'pending')");
  saveDB();
  console.log("[db] Cleared stale in-progress chunk records");

  const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use. Kill the old process first:`);
      console.error(`  Windows: npx kill-port ${PORT}`);
      console.error(`  Or:      netstat -ano | findstr :${PORT}  then  taskkill /PID <pid> /F`);
    } else {
      console.error("Server error:", err);
    }
    process.exit(1);
  });

  // Graceful shutdown — release the port on any exit signal
  function shutdown(signal) {
    console.log(`\n[server] ${signal} received, shutting down...`);
    server.close(() => {
      saveDB();
      console.log("[server] Closed.");
      process.exit(0);
    });
    // Force exit if close hangs for more than 3s
    setTimeout(() => process.exit(1), 3000);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
