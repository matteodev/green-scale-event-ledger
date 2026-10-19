import { z } from "zod";

// Descrive le regole da verificare durante l'esecuzione.
const EventSchema = z.object({
  eventId: z.uuid(),
  timestamp: z.iso.datetime(),
});

// unknown significa: non sappiamo ancora se possiamo fidarci del dato.
const input: unknown = {
    eventId: "d37c70dd-841a-4fc3-a9f6-0c129e4ab932",
    timestamp: "2026-10-19T13:00:00Z",
};

const result = EventSchema.safeParse(input);

if (result.success) {
  console.log("Evento valido:", result.data);
} else {
  console.log("Evento non valido:", result.error.issues);
}