/**
 * Next.js start-up hook: register() runs once per server process before the first request is handled.
 *
 * Node.js runtime only (the edge runtime that runs middleware has no TCP sockets): when REDIS_URL is set, the Redis
 * rate-limit store is created and registered with setRateLimitStore(), so every rate limit in the app shares one
 * Redis across all app servers. Without REDIS_URL the Postgres buckets stay in use (development only).
 *
 * In production getEnv() validates the whole environment here, and an invalid one (a missing REDIS_URL, any other bad
 * setting) ends the process with exit status 1 after printing "Invalid environment configuration" and the variable
 * names (never values). Throwing is not enough: `next start` only logs "Failed to prepare server" and answers 500 to
 * every request while the process stays "online". Exiting lets PM2 count the restarts and stop at max_restarts
 * ("errored", deploy/ecosystem.config.cjs); `next start` runs this hook when it prepares its first request, which
 * deploy.sh's health check makes right after a (re)start. During `next build` nothing happens.
 * The store connects lazily in the background; while Redis is unreachable it follows the fail-closed / degraded
 * policy documented in lib/auth/rate-limit-redis.ts.
 */
export async function register(): Promise<void> {
  // Written as one `if` on NEXT_RUNTIME so the edge bundle drops the dynamic imports (and ioredis) entirely.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    const [{ getEnv, isProduction }, { log }] = await Promise.all([import("@/lib/env"), import("@/lib/log")]);
    let redisUrl: string | undefined;
    try {
      redisUrl = getEnv().REDIS_URL;
    } catch (e) {
      // Production refuses to run with an invalid environment; development keeps serving and reports it per request.
      if (isProduction()) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
      log.warn("instrumentation_env_invalid", { hint: "fix .env.local; rate limits use Postgres buckets" });
      return;
    }
    if (!redisUrl) return;
    const { installRedisRateLimitStore } = await import("@/lib/auth/rate-limit-redis");
    installRedisRateLimitStore(redisUrl);
    log.info("rate_limit_store_registered", { store: "redis" });
  }
}
