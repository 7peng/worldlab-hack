import { execSync } from "node:child_process";

const ports = [3001, 5173];

for (const port of ports) {
  try {
    execSync(
      `powershell -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
      { stdio: "ignore" },
    );
  } catch {
    // port not in use — nothing to kill
  }
}

console.log("Cleared ports 3001, 5173");
