import { ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { sqsClient } from "./sqs-client.js";
import { EventSchema } from "./event-schema.js";

const queueUrl = process.env.SQS_QUEUE_URL;

if (!queueUrl) {
    throw new Error("SQS_QUEUE_URL è obbligatoria");
}

try {
    const command = new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
    });

    const response = await sqsClient.send(command);

    const messages = response.Messages ?? [];

    if (messages.length === 0) {
        console.log("Nessun messaggio disponibile");
    }

    for (const message of messages) {
        if (message.Body === undefined) {
            console.error("Corpo assente:", message.MessageId);
            continue;
        }

        let input: unknown;

        try {
            input = JSON.parse(message.Body);
        } catch (error) {
            console.error("JSON non leggibile:", message.MessageId, error);
            continue;
        }

        const result = EventSchema.safeParse(input);

        if (!result.success) {
            console.error(
                "Evento non valido:",
                message.MessageId,
                result.error.issues,
            );
            continue;
        }

        console.log("Evento validato:", result.data);
    }
} catch (error) {
    console.error("Lettura da SQS fallita:", error);
    process.exitCode = 1;
} finally {
    sqsClient.destroy();
}