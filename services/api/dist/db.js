import pg from "pg";
const { Pool } = pg;
export function createDb(databaseUrl) {
    const pool = new Pool({
        connectionString: databaseUrl,
        max: 10,
    });
    return {
        pool,
        close: async () => {
            await pool.end();
        },
    };
}
