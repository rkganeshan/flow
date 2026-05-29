import "dotenv/config";
import { loadEnv } from "./env.js";
import { buildApp } from "./app.js";
const env = loadEnv();
const { app, db } = await buildApp(env);
const port = env.PORT;
await app.listen({ host: "0.0.0.0", port });
const shutdown = async (signal) => {
    app.log.info({ signal }, "shutting down");
    try {
        await app.close();
    }
    finally {
        await db.close();
    }
    process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
