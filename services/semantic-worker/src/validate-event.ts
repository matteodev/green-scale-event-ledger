import { EventSchema } from "./event-schema.js";

// unknown significa: non sappiamo ancora se possiamo fidarci del dato.
const input: unknown = {
    eventId: "d37c70dd-841a-4fc3-a9f6-0c129e4ab932",
    timestamp: "2026-10-19T13:00:00Z",
    eventType: "telemetry",
    source: "demo-sensor",
    meta: {
        userId: "demo-user",
        ipAddress: "192.0.2.10",
    },
    data: {
        sensorId: "sensor-001",
        temperatureCelsius: 21.5,
    },
};

const result = EventSchema.safeParse(input);

if (result.success) {
  console.log("Evento valido:", result.data);
} else {
  console.log("Evento non valido:", result.error.issues);
}