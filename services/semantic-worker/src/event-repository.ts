import { pool } from "./db.js";
import type { EventPayload } from "./event-schema.js";

export async function saveEvent(
    event: EventPayload,
): Promise<"inserted" | "already_saved"> {
    const payload = JSON.stringify(event);

    const insertion = await pool.query(
        `INSERT INTO events (
            event_id, event_type, source, occurred_at, payload
        ) VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_id`,
        [
            event.eventId,
            event.eventType,
            event.source,
            event.timestamp,
            payload,
        ],
    );

    if (insertion.rowCount === 1) {
        return "inserted";
    }

    // L'ID esiste: controlliamo se descrive lo stesso evento.
    const existing = await pool.query<{ same_payload: boolean }>(
        `SELECT payload = $2::jsonb AS same_payload
         FROM events
         WHERE event_id = $1`,
        [event.eventId, payload],
    );

    const row = existing.rows[0];

    if (!row) {
        throw new Error("Impossibile verificare l'evento esistente");
    }

    if (row.same_payload) {
        return "already_saved";
    }

    throw new Error(`Contenuto diverso per eventId ${event.eventId}`);
}