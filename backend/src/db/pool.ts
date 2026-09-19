import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
});

pool.on("error", (err) => {
  // A background/idle client error should never crash the whole process.
  console.error("[db] unexpected error on idle client", err);
});
