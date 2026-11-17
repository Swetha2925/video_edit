import "./harness/workflows";
import { startWorker } from "./harness/jobs";

/**
 * Server bootstrap: registers workflow handlers and starts the background worker.
 * Called ONLY from instrumentation.ts in the main Next.js server process — never from
 * route modules, which Next.js may also evaluate in short-lived helper processes.
 */
export function bootstrapServer() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  startWorker();
}
