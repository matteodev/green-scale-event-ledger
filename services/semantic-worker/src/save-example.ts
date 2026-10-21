import { readFile } from "node:fs/promises";
import { EventSchema } from "./event-schema.js";
import { saveEvent } from "./event-repository.js";
import { pool } from "./db.js";
import { randomUUID } from "node:crypto";

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
        //const outcome = await saveEvent(result.data);
        //console.log("Esito salvataggio:", outcome, result.data.eventId);

        // Evento sintetico di prova con un nuovo identificativo.
        const newEvent = {
            ...result.data,
            eventId: randomUUID(),
        };

        console.log("ID della prova:", newEvent.eventId);

        const firstOutcome = await saveEvent(newEvent);
        console.log("Primo salvataggio:", firstOutcome);

        const secondOutcome = await saveEvent(newEvent);
        console.log("Secondo salvataggio:", secondOutcome);
    }
} catch (error) {
    console.error("Salvataggio fallito:", error);
    process.exitCode = 1;
} finally {
    await pool.end();
}