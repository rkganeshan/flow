import { z } from "zod";
export const RequestTenantHeaderSchema = z.object({
    "x-tenant-id": z.string().uuid(),
});
export function getTenantIdFromHeaders(headers) {
    const parsed = RequestTenantHeaderSchema.safeParse(headers);
    if (!parsed.success) {
        throw Object.assign(new Error("Missing/invalid x-tenant-id header"), {
            statusCode: 400,
        });
    }
    return parsed.data["x-tenant-id"];
}
export function toHttpError(e, log) {
    if (e && typeof e === "object" && "statusCode" in e) {
        const statusCode = Number(e.statusCode) || 500;
        return { statusCode, body: { error: e.message ?? "error" } };
    }
    // Postgres unique violation
    const pgCode = e?.code;
    if (pgCode === "23505") {
        return { statusCode: 409, body: { error: "conflict" } };
    }
    // Unexpected error: log details (including stack) to aid debugging in prod.
    try {
        log?.error({ err: e }, "Unhandled error");
    }
    catch { }
    return { statusCode: 500, body: { error: "internal_error" } };
}
