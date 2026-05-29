import "dotenv/config";
import { loadEnv } from "../../api/src/env.js";
import { createDb } from "../../api/src/db.js";
import { createRedis } from "./redis.js";
import { registerEngineWorker } from "./engineWorker.js";
const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const redis = createRedis(process.env.REDIS_URL ?? "redis://localhost:6379");
const { shutdown } = await registerEngineWorker({ db, redis });
const onSig = async (signal) => {
    console.log(`[engine] received ${signal}, shutting down`);
    await shutdown();
    await db.close();
    await redis.quit();
    process.exit(0);
};
process.on("SIGINT", () => void onSig("SIGINT"));
process.on("SIGTERM", () => void onSig("SIGTERM"));
