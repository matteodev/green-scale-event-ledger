import { pool } from "./db.js";

try {
    const result = await pool.query(
        "SELECT current_database() AS database, NOW() AS server_time",
    );

    console.log("Connessione riuscita:", result.rows[0]);
} catch (error) {
    console.error("Connessione al database fallita:", error);
    process.exitCode = 1;
} finally {
    await pool.end();
}