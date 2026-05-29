import { registerAuthRoutes } from "./auth.js";
import { registerTenantsRoutes } from "./tenants.js";
import { registerWorkflowsRoutes } from "./workflows.js";
import { registerRunsRoutes } from "./runs.js";
import { registerTriggersRoutes } from "./triggers.js";
import { registerEngineRoutes } from "./engine.js";
import { registerWorkersRoutes } from "./workers.js";
import { registerDlqRoutes } from "./dlq.js";
export async function registerV1Routes(app) {
    await app.register(registerAuthRoutes, { prefix: "/auth" });
    await app.register(registerTenantsRoutes, { prefix: "/tenants" });
    await app.register(registerWorkflowsRoutes, { prefix: "/workflows" });
    await app.register(registerRunsRoutes, { prefix: "/runs" });
    await app.register(registerTriggersRoutes, { prefix: "/triggers" });
    await app.register(registerEngineRoutes, { prefix: "/engine" });
    await app.register(registerWorkersRoutes, { prefix: "/workers" });
    await app.register(registerDlqRoutes, { prefix: "/dlq" });
}
