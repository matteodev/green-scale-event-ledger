import pg from "pg";

const { Pool } = pg;

// Le impostazioni di connessione vengono lette dalle variabili PG*.
export const pool = new Pool({
    max: 5,
    connectionTimeoutMillis: 2000,
});