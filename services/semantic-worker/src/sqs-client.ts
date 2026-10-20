import { SQSClient } from "@aws-sdk/client-sqs";

const region = process.env.AWS_REGION;
const endpoint = process.env.SQS_ENDPOINT;

// Interrompiamo l'avvio se manca la configurazione locale.
if (!region || !endpoint) {
    throw new Error("AWS_REGION e SQS_ENDPOINT sono obbligatorie");
}

// Questo oggetto verrà riutilizzato per inviare comandi a SQS.
export const sqsClient = new SQSClient({
    region,
    endpoint,
});