import crypto from "node:crypto";
const ROLE_ORDER = {
    viewer: 1,
    editor: 2,
    owner: 3,
};
export function roleAtLeast(role, minimum) {
    return ROLE_ORDER[role] >= ROLE_ORDER[minimum];
}
export function hashPassword(password, salt = randomToken(16)) {
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    return { salt, hash };
}
export function verifyPassword(password, salt, expectedHash) {
    const actualHash = crypto.scryptSync(password, salt, 64).toString("hex");
    const actual = Buffer.from(actualHash, "hex");
    const expected = Buffer.from(expectedHash, "hex");
    if (actual.length !== expected.length)
        return false;
    return crypto.timingSafeEqual(actual, expected);
}
export function randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString("base64url");
}
export function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}
export function createApiKeyToken() {
    return `flow_${randomToken(32)}`;
}
export async function createApiKeyRecord(args) {
    const token = createApiKeyToken();
    const tokenHash = hashToken(token);
    const r = await args.db.pool.query(`insert into api_keys (tenant_id, user_id, name, token_hash)
     values ($1, $2, $3, $4)
     returning id`, [args.tenantId, args.userId, args.name, tokenHash]);
    return { id: r.rows[0].id, token };
}
export async function registerTenantUser(args) {
    const client = await args.db.pool.connect();
    try {
        await client.query("begin");
        const tenant = await client.query(`insert into tenants (slug, name)
       values ($1, $2)
       returning id, slug, name, created_at`, [args.tenantSlug, args.tenantName]);
        const { salt, hash } = hashPassword(args.password);
        const user = await client.query(`insert into users (tenant_id, email, name, password_salt, password_hash)
       values ($1, $2, $3, $4, $5)
       returning id, tenant_id, email, name, created_at, updated_at`, [tenant.rows[0].id, args.email.toLowerCase(), args.userName, salt, hash]);
        await client.query(`insert into tenant_memberships (tenant_id, user_id, role)
       values ($1, $2, 'owner')`, [tenant.rows[0].id, user.rows[0].id]);
        const token = createApiKeyToken();
        const tokenHash = hashToken(token);
        const apiKey = await client.query(`insert into api_keys (tenant_id, user_id, name, token_hash)
       values ($1, $2, $3, $4)
       returning id`, [tenant.rows[0].id, user.rows[0].id, "bootstrap", tokenHash]);
        const starterGraph = {
            trigger: {
                enabled: true,
                webhook_secret: "",
                schedule_cron: "",
            },
            entry_node_id: "delay-1",
            nodes: [
                {
                    id: "delay-1",
                    type: "delay",
                    config: { seconds: 2 },
                },
                {
                    id: "notify-1",
                    type: "notify",
                    config: {
                        provider: "email",
                        to: args.email.toLowerCase(),
                        subject: "Welcome to Flow",
                    },
                },
            ],
            edges: [{ from: "delay-1", to: "notify-1" }],
        };
        const workflow = await client.query(`insert into workflows (tenant_id, name, draft_graph)
       values ($1, $2, $3::jsonb)
       returning id`, [tenant.rows[0].id, "Getting started", JSON.stringify(starterGraph)]);
        await client.query(`insert into workflow_versions (tenant_id, workflow_id, version, graph)
       values ($1, $2, 1, $3::jsonb)`, [tenant.rows[0].id, workflow.rows[0].id, JSON.stringify(starterGraph)]);
        await client.query("commit");
        return {
            tenant: tenant.rows[0],
            user: user.rows[0],
            apiKey: { id: apiKey.rows[0].id, token },
        };
    }
    catch (e) {
        await client.query("rollback");
        throw e;
    }
    finally {
        client.release();
    }
}
export async function loginTenantUser(args) {
    const r = await args.db.pool.query(`select u.id as user_id, u.tenant_id, u.email, u.name, u.password_salt, u.password_hash,
            t.slug as tenant_slug, t.name as tenant_name, tm.role
       from users u
       join tenants t on t.id = u.tenant_id
       join tenant_memberships tm on tm.user_id = u.id and tm.tenant_id = u.tenant_id
      where t.slug = $1 and u.email = $2
      limit 1`, [args.tenantSlug, args.email.toLowerCase()]);
    if (r.rowCount === 0) {
        throw Object.assign(new Error("invalid_credentials"), { statusCode: 401 });
    }
    const row = r.rows[0];
    if (!verifyPassword(args.password, row.password_salt, row.password_hash)) {
        throw Object.assign(new Error("invalid_credentials"), { statusCode: 401 });
    }
    const apiKey = await createApiKeyRecord({
        db: args.db,
        tenantId: row.tenant_id,
        userId: row.user_id,
        name: args.apiKeyName ?? "login",
    });
    return {
        tenant: { id: row.tenant_id, slug: row.tenant_slug, name: row.tenant_name },
        user: {
            id: row.user_id,
            tenant_id: row.tenant_id,
            email: row.email,
            name: row.name,
        },
        role: row.role,
        apiKey,
    };
}
export async function authenticateRequest(args) {
    const authorization = String(args.request.headers.authorization ?? "").trim();
    const apiKeyHeader = String(args.request.headers["x-api-key"] ?? "").trim();
    const token = authorization.toLowerCase().startsWith("bearer ")
        ? authorization.slice(7).trim()
        : apiKeyHeader;
    if (!token)
        return null;
    const tokenHash = hashToken(token);
    const r = await args.db.pool.query(`select k.id as api_key_id, k.tenant_id, u.id as user_id, u.email, u.name, tm.role
       from api_keys k
       join users u on u.id = k.user_id
       join tenant_memberships tm on tm.user_id = u.id and tm.tenant_id = u.tenant_id
      where k.token_hash = $1
        and k.revoked_at is null
      limit 1`, [tokenHash]);
    if (r.rowCount === 0)
        return null;
    const row = r.rows[0];
    await args.db.pool.query(`update api_keys set last_used_at = now() where id = $1`, [row.api_key_id]);
    return {
        tenantId: row.tenant_id,
        userId: row.user_id,
        email: row.email,
        name: row.name,
        role: row.role,
        apiKeyId: row.api_key_id,
    };
}
export function getRequiredRoleFromRoute(request) {
    const config = request.routeOptions?.config ?? {};
    return config.requiredRole ?? null;
}
export function publicRoute(request) {
    const url = request.url;
    return (url.startsWith("/healthz") ||
        url.startsWith("/readyz") ||
        url === "/v1/auth/register" ||
        url === "/v1/auth/login" ||
        url.startsWith("/v1/triggers/webhooks") ||
        url === "/v1/tenants" ||
        url.startsWith("/v1/tenants/"));
}
export async function enforceRateLimit(args) {
    if (!args.redis || !Number.isFinite(args.limit) || args.limit <= 0)
        return;
    const windowSeconds = Math.max(1, Math.floor(args.windowSeconds ?? 60));
    const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
    const key = `rate:${args.scope}:${args.key}:${bucket}`;
    const count = await args.redis.incr(key);
    if (count === 1) {
        await args.redis.expire(key, windowSeconds);
    }
    if (count > args.limit) {
        throw Object.assign(new Error("rate_limit_exceeded"), { statusCode: 429 });
    }
}
