import { Queue } from "bullmq";

export const QUEUE_RUN_REQUESTS = "run_requests";
export const QUEUE_NODE_EXECUTE = "node_execute";
export const QUEUE_ENGINE_ADVANCE = "engine_advance";

export function getQueues(connection: unknown) {
  return {
    runRequests: new Queue(QUEUE_RUN_REQUESTS, {
      connection: connection as any,
    }),
    nodeExecute: new Queue(QUEUE_NODE_EXECUTE, {
      connection: connection as any,
    }),
    engineAdvance: new Queue(QUEUE_ENGINE_ADVANCE, {
      connection: connection as any,
    }),
  };
}
