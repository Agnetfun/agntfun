// Runs the website and the orchestrator together for local testing. Ctrl+C stops both.
import { spawn } from "node:child_process";
import { setTimeout } from "node:timers";

const shell = process.platform === "win32";
const procs = [
  ["web", ["tsx", "--env-file=.env", "apps/web/src/main.ts"]],
  ["orchestrator", ["tsx", "--env-file=.env", "apps/orchestrator/src/main.ts"]],
].map(([name, args]) => {
  const p = spawn("pnpm", ["exec", ...args], { stdio: ["ignore", "pipe", "pipe"], shell });
  const tag = (s) =>
    s
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((l) => console.log(`[${name}] ${l}`));
  p.stdout.on("data", tag);
  p.stderr.on("data", tag);
  p.on("exit", (code) => {
    console.log(`[${name}] exited with ${code}`);
    stop();
  });
  return p;
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill();
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log("Website: http://127.0.0.1:" + (process.env.WEB_PORT || 3000));
