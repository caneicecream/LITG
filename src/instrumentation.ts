/**
 * Optional in-process monitoring scheduler. Off unless MONITOR_SCHEDULER=on
 * and DATABASE_URL is set. For production, prefer an external scheduler
 * (cron calling `npm run monitor` or POST /api/monitoring/run).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.MONITOR_SCHEDULER === "on" && process.env.DATABASE_URL) {
    const { startScheduler } = await import("./monitoring/scheduler");
    startScheduler();
  }
}
