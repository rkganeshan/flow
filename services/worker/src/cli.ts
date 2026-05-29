import "dotenv/config";

import { loadEnv } from "../../api/src/env.js";
import { createDb } from "../../api/src/db.js";
import { createRedis } from "./redis.js";
import { registerNodeWorker } from "./nodeWorker.js";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL);

const { shutdown } = await registerNodeWorker({
  db,
  redis,
  env: {
    HTTP_NODE_ALLOWED_HOSTS: env.HTTP_NODE_ALLOWED_HOSTS,
    HTTP_NODE_TIMEOUT_MS: env.HTTP_NODE_TIMEOUT_MS,
    HTTP_NODE_MAX_RESPONSE_BYTES: env.HTTP_NODE_MAX_RESPONSE_BYTES,
    SMTP_HOST: env.SMTP_HOST,
    SMTP_PORT: env.SMTP_PORT,
  },
});

const onSig = async (signal: string) => {
  console.log(`[worker] received ${signal}, shutting down`);
  await shutdown();
  await db.close();
  await redis.quit();
  process.exit(0);
};

process.on("SIGINT", () => void onSig("SIGINT"));
process.on("SIGTERM", () => void onSig("SIGTERM"));
