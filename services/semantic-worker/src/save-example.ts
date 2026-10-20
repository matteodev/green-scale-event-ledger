import { readFile } from "node:fs/promises";
import { EventSchema } from "./event-schema.js";
import { saveEvent } from "./event-repository.js";
import { pool } from "./db.js";

try {
    // Il percorso è relativo a questo modulo, non alla directory della shell.
    const fileUrl = new URL(
        "../../../examples/events/telemetry.json",
        import.meta.url,
    );

    const body = await readFile(fileUrl, "utf8");
    const input: unknown = JSON.parse(body);

    const result = EventSchema.safeParse(input);

    if (!result.success) {
        console.error("Evento non valido:", result.error.issues);
        process.exitCode = 1;
    } else {
        // Attendiamo il completamento dell'INSERT prima di stampare successo.
        await saveEvent(result.data);
        console.log("Evento salvato:", result.data.eventId);
    }
} catch (error) {
    console.error("Salvataggio fallito:", error);
    process.exitCode = 1;
} finally {
    await pool.end();
}