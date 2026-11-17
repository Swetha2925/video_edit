import path from "node:path";

// Isolated storage + database for tests (never touches development data).
process.env.STORAGE_ROOT = path.resolve(process.cwd(), ".test-storage");
process.env.DATABASE_URL = "file:./test.db";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
process.env.RENDER_PRESET = "ultrafast";
process.env.ANTHROPIC_API_KEY = process.env.RUN_LIVE_AI === "1" ? process.env.ANTHROPIC_API_KEY ?? "" : "";
