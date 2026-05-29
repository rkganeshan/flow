import { z } from "zod";
import { authenticateRequest, createApiKeyRecord, loginTenantUser, registerTenantUser, roleAtLeast, } from "../auth.js";
import { toHttpError } from "../http.js";
const RegisterBody = z.object({
    tenant: z.object({
        slug: z.string().min(1),
        name: z.string().min(1),
    }),
    user: z.object({
        name: z.string().min(1),
        email: z.string().email(),
        password: z.string().min(8),
    }),
});
const LoginBody = z.object({
    tenant_slug: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(1),
});
const CreateApiKeyBody = z.object({
    name: z.string().min(1).default("cli"),
});
export async function registerAuthRoutes(app) {
    const db = app.db;
    app.post("/register", async (req, reply) => {
        try {
            const parsed = RegisterBody.safeParse(req.body ?? {});
            if (!parsed.success) {
                return reply
                    .code(400)
                    .send({ error: "invalid_body", details: parsed.error.flatten() });
            }
            const result = await registerTenantUser({
                db,
                tenantSlug: parsed.data.tenant.slug,
                tenantName: parsed.data.tenant.name,
                userName: parsed.data.user.name,
                email: parsed.data.user.email,
                password: parsed.data.user.password,
            });
            return reply.code(201).send({
                tenant: result.tenant,
                user: result.user,
                role: "owner",
                api_key: result.apiKey,
            });
        }
        catch (e) {
            const { statusCode, body } = toHttpError(e, app.log);
            return reply.code(statusCode).send(body);
        }
    });
    app.post("/login", async (req, reply) => {
        try {
            const parsed = LoginBody.safeParse(req.body ?? {});
            if (!parsed.success) {
                return reply
                    .code(400)
                    .send({ error: "invalid_body", details: parsed.error.flatten() });
            }
            const result = await loginTenantUser({
                db,
                tenantSlug: parsed.data.tenant_slug,
                email: parsed.data.email,
                password: parsed.data.password,
            });
            return reply.code(200).send({
                tenant: result.tenant,
                user: result.user,
                role: result.role,
                api_key: result.apiKey,
            });
        }
        catch (e) {
            const { statusCode, body } = toHttpError(e, app.log);
            return reply.code(statusCode).send(body);
        }
    });
    app.get("/me", async (req, reply) => {
        try {
            const auth = await authenticateRequest({ db, request: req });
            if (!auth)
                return reply.code(401).send({ error: "unauthorized" });
            return {
                tenant_id: auth.tenantId,
                user_id: auth.userId,
                email: auth.email,
                name: auth.name,
                role: auth.role,
            };
        }
        catch (e) {
            const { statusCode, body } = toHttpError(e, app.log);
            return reply.code(statusCode).send(body);
        }
    });
    app.post("/api-keys", async (req, reply) => {
        try {
            const auth = req.auth;
            if (!auth)
                return reply.code(401).send({ error: "unauthorized" });
            if (!roleAtLeast(auth.role, "editor")) {
                return reply.code(403).send({ error: "forbidden" });
            }
            const parsed = CreateApiKeyBody.safeParse(req.body ?? {});
            if (!parsed.success) {
                return reply
                    .code(400)
                    .send({ error: "invalid_body", details: parsed.error.flatten() });
            }
            const apiKey = await createApiKeyRecord({
                db,
                tenantId: auth.tenantId,
                userId: auth.userId,
                name: parsed.data.name,
            });
            return reply.code(201).send({ api_key: apiKey });
        }
        catch (e) {
            const { statusCode, body } = toHttpError(e, app.log);
            return reply.code(statusCode).send(body);
        }
    });
}
