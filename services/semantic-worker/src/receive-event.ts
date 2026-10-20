import { ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { sqsClient } from "./sqs-client.js";

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

    console.log("Messaggi ricevuti:", response.Messages ?? []);
} catch (error) {
    console.error("Lettura da SQS fallita:", error);
    process.exitCode = 1;
} finally {
    sqsClient.destroy();
}