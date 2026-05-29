import pg from "pg";

const { Pool } = pg;

export type Db = {
  pool: pg.Pool;
  close: () => Promise<void>;
};

export function createDb(databaseUrl: string): Db {
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
