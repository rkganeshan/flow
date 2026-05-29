import { Redis } from "ioredis";

export function createRedis(redisUrl: string) {
  return new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}
