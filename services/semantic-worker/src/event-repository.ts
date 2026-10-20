import { pool } from "./db.js";
import type { EventPayload } from "./event-schema.js";

// Riceve i dati dopo la validazione Zod.
export async function saveEvent(event: EventPayload): Promise<void> {
    await pool.query(
        `INSERT INTO events (
            event_id,
            event_type,
            source,
            occurred_at,
            payload
        ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
            event.eventId,
            event.eventType,
            event.source,
            event.timestamp,
            JSON.stringify(event),
        ],
    );
}