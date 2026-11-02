import {
    ReceiveMessageCommand,
    DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { sqsClient } from "./sqs-client.js";
import { EventSchema } from "./event-schema.js";
import { saveEvent } from "./event-repository.js";
import { pool } from "./db.js";

const queueUrl = process.env.SQS_QUEUE_URL;

if (!queueUrl) {
    throw new Error("SQS_QUEUE_URL è obbligatoria");
}

try {
    // Una singola richiesta riceve al massimo un messaggio. Il long polling
    // attende fino a 20 secondi e può terminare prima se un messaggio è disponibile.
    const command = new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
    });

    // Inviamo il comando al client SQS e attendiamo la risposta.
    const response = await sqsClient.send(command);

    // Estraiamo i messaggi dalla risposta, se presenti.
    const messages = response.Messages ?? [];

    // Nessun messaggio restituito da questa richiesta: non è un errore
    // e non dimostra che la coda sia vuota (alcuni messaggi possono essere invisibili).
    if (messages.length === 0) {
        console.log("Nessun messaggio disponibile");
    }

    // Iteriamo sui messaggi ricevuti per elaborarli uno alla volta.
    for (const message of messages) {
        // Se manca il corpo, interrompiamo solo questo giro del ciclo.
        // Il messaggio non viene cancellato e può essere riconsegnato.
        if (message.Body === undefined) {
            console.error("Corpo assente:", message.MessageId);
            continue;
        }

        let input: unknown;

        // Il Body SQS è una stringa. JSON.parse verifica la sintassi JSON,
        // mentre unknown ci impedisce di presumere già la struttura dell'evento.
        try {
            input = JSON.parse(message.Body);
        } catch (error) {
            console.error("JSON non leggibile:", message.MessageId, error);
            continue;
        }

        // Validiamo l'input rispetto allo schema dell'evento.
        const result = EventSchema.safeParse(input);

        // Se il contratto non è rispettato, stampiamo gli errori e proseguiamo
        // senza cancellare il messaggio: la policy SQS potrà indirizzarlo alla DLQ.
        if (!result.success) {
            console.error(
                "Evento non valido:",
                message.MessageId,
                result.error.issues,
            );
            continue;
        }

        // Attendiamo l'inserimento oppure il riconoscimento di un evento identico
        // già salvato. Un conflitto o un errore del database interrompe il flusso
        // e porta al catch esterno, prima di raggiungere la cancellazione.
        const outcome = await saveEvent(result.data);

        console.log("Evento elaborato:", {
            messageId: message.MessageId,
            eventId: result.data.eventId,
            outcome,
        });

        // Interruzione volontaria per verificare la riconsegna dopo il salvataggio.
        // Attiva soltanto quando la variabile vale esattamente "1".
        if (process.env.SIMULATE_FAILURE_BEFORE_DELETE === "1") {
            throw new Error("Guasto simulato dopo il salvataggio e prima della cancellazione");
        }

        // Qui la persistenza è confermata, ma la cancellazione non è ancora avvenuta.
        // Serve l'handle di questa ricezione, non il MessageId o l'eventId.
        if (!message.ReceiptHandle) {
            throw new Error("ReceiptHandle assente: impossibile cancellare il messaggio");
        }

        // Cancelliamo soltanto dopo saveEvent riuscita, anche con already_saved.
        // Se questa richiesta fallisce, il dato rimane nel database: una futura
        // riconsegna potrà essere riconosciuta senza inserire una seconda riga.
        await sqsClient.send(
            new DeleteMessageCommand({
                QueueUrl: queueUrl,
                ReceiptHandle: message.ReceiptHandle,
            }),
        );

        console.log("Cancellazione confermata da SQS:", message.MessageId);
    }
} catch (error) {
    // Gestiamo gli errori di ricezione, persistenza o cancellazione.
    // Gli input non validi sono invece gestiti sopra con continue.
    console.error("Elaborazione del messaggio fallita:", error);
    process.exitCode = 1;
} finally {
    // Questo programma termina dopo una sola richiesta di lettura:
    // rilasciamo le risorse SQS e chiudiamo tutte le connessioni del pool PostgreSQL.
    sqsClient.destroy();
    await pool.end();
}
