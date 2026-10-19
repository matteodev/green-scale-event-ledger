import { z } from "zod";

// Descrive le regole da verificare durante l'esecuzione.
export const EventSchema = z.object({
    eventId: z.uuid(), // Deve essere un UUID valido
    timestamp: z.iso.datetime(), // ISO 8601 standard
    eventType: z.enum(["telemetry", "transaction", "audit"]), // Solo questi tre tipi di evento sono validi
    source: z.string().trim().min(1), // Deve essere una stringa non vuota
    meta: z.object({
        userId: z.string().trim().min(1), // Deve essere una stringa non vuota
        ipAddress: z.union([z.ipv4(), z.ipv6()]),// Deve essere un indirizzo IP valido (IPv4 o IPv6)
    }),
    data: z.record(z.string(), z.unknown()).refine(
        (value) => Object.keys(value).length > 0,// Deve contenere almeno una proprietà
        { message: "data deve contenere almeno una proprietà" }, // Messaggio di errore
    ),
});

// In TypeScript, possiamo usare `z.infer` per ottenere il tipo corrispondente allo schema Zod.
export type EventPayload = z.infer<typeof EventSchema>;