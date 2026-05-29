import Redis from "ioredis";
export function createRedis(redisUrl) {
    return new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
    });
}
