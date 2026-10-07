/**
 * PM2 process file for the Axiomatic app on the aaPanel server (deploy/README.md).
 *
 * deploy.sh, rollback.sh and restart.sh run `pm2 startOrReload <this file> --update-env` as the app user, from a
 * minimal environment (deploy/common.sh pm2_clean), then `pm2 save` so `pm2 startup` brings the app back after a
 * reboot. Do not add the app as an aaPanel "Node project" as well: that would start a second copy on the same port.
 *
 * What runs: `next start -H 127.0.0.1 -p 3000` in /www/wwwroot/axiomatic/current, the symlink deploy.sh switches, so
 * every (re)start runs the release `current` points at, with its full node_modules (no standalone output). Next.js
 * reads .env.production from that folder itself (a symlink to shared/.env.production): no secret is written here or
 * into PM2's dump file. Only Nginx on the same server can reach 127.0.0.1:3000.
 *
 * Settings come from the environment of the pm2 command (the deploy scripts read them from shared/deploy.env):
 *   AXS_BASE        deployment root (/www/wwwroot/axiomatic)
 *   AXS_PORT        local port (3000; Nginx proxies to it)
 *   AXS_INSTANCES   1 = one process in fork mode (default). 2 or more = PM2 cluster mode: the processes share the
 *                   port and `pm2 reload` restarts them one at a time (no gap). Each process has its own database
 *                   pool (DATABASE_POOL_MAX, 10) and about 300-500 MB of memory; rate limits are shared through Redis.
 *                   Switching between 1 and 2+ needs `deploy/restart.sh --recreate`.
 *   AXS_MAX_MEMORY  restart a process whose memory (RSS) passes this (1G; fits 2-4 GB servers)
 *   AXS_HEAP_MB     V8 heap cap per process, --max-old-space-size (512 for 2-4 GB servers, 768 for 8 GB with
 *                   AXS_MAX_MEMORY=1500M). Uncapped, V8 grows a busy process to about 1.15 GB and PM2 restarts it at
 *                   AXS_MAX_MEMORY; capped at 512 it stays near 0.5 GB at the same load (docs/performance.md).
 *                   Changing it needs `deploy/restart.sh --recreate` (PM2 keeps node_args across reloads).
 *   AXS_NODE        node binary (fork mode; cluster mode uses the Node.js that runs PM2)
 */
"use strict";

// Plain string paths (POSIX; no require, so the repository lint rules hold for this file too).
const base = (process.env.AXS_BASE || "/www/wwwroot/axiomatic").replace(/[/]+$/, "");
const port = process.env.AXS_PORT || "3000";
const instances = Math.min(16, Math.max(1, Number.parseInt(process.env.AXS_INSTANCES || "1", 10) || 1));
const heapMb = /^[0-9]{3,5}$/.test(process.env.AXS_HEAP_MB || "") ? process.env.AXS_HEAP_MB : "512";
const logs = `${base}/shared/logs`;

module.exports = {
  apps: [
    {
      name: process.env.AXS_APP_NAME || "axiomatic",
      cwd: `${base}/current`,
      script: "node_modules/next/dist/bin/next",
      args: ["start", "-H", "127.0.0.1", "-p", port],
      ...(process.env.AXS_NODE ? { interpreter: process.env.AXS_NODE } : {}),
      node_args: [`--max-old-space-size=${heapMb}`],
      exec_mode: instances > 1 ? "cluster" : "fork",
      instances,
      env: {
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      // Restarts: on a crash (with an exponential back-off, so a broken env cannot spin the CPU), when memory passes
      // the limit, and never on file changes. After 15 crashes within 20 s of starting PM2 stops trying ("errored").
      autorestart: true,
      watch: false,
      min_uptime: "20s",
      max_restarts: 15,
      exp_backoff_restart_delay: 200,
      max_memory_restart: process.env.AXS_MAX_MEMORY || "1G",
      // Graceful stop: SIGINT first, SIGKILL only after 15 s (requests in flight finish; Next.js closes its server).
      kill_timeout: 15000,
      // Logs in shared/logs (kept across releases), one file per stream for all instances, ISO timestamps.
      // Rotation: pm2-logrotate (deploy/README.md "Logs").
      out_file: `${logs}/app-out.log`,
      error_file: `${logs}/app-error.log`,
      merge_logs: true,
      time: true,
    },
  ],
};
