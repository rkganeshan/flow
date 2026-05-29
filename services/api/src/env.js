import { z } from "zod";
const EnvSchema = z.object({
    NODE_ENV: z.string().optional(),
    PORT: z.coerce.number().default(3000),
    DATABASE_URL: z
        .string()
        .min(1)
        .describe("Postgres connection string, e.g. postgresql://flow:flow@localhost:55432/flow"),
    // Redis (BullMQ)
    REDIS_URL: z
        .string()
        .min(1)
        .default("redis://localhost:6379")
        .describe("Redis connection string for BullMQ"),
    CORS_ORIGIN: z.string().optional(),
    // Worker/connector safety (MVP)
    HTTP_NODE_ALLOWED_HOSTS: z
        .string()
        .optional()
        .describe("Comma-separated allowlist of hosts for http_request node (e.g. example.com,api.github.com). If unset, all hosts are allowed (not recommended)."),
    HTTP_NODE_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(100)
        .max(60000)
        .default(5000)
        .describe("Timeout for http_request node"),
    HTTP_NODE_MAX_RESPONSE_BYTES: z.coerce
        .number()
        .int()
        .min(1024)
        .max(2_000_000)
        .default(100_000)
        .describe("Max bytes to read from http_request response"),
});
export function loadEnv() {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
        // Keep it simple and explicit for early-stage debugging.
        const issues = parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("\n");
        throw new Error(`Invalid environment:\n${issues}`);
    }
    return parsed.data;
}
