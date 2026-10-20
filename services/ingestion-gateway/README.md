# Ingestion gateway

Primo servizio applicativo: `POST /events` → SQS. Usa `net/http` e l'SDK ufficiale AWS per Go v2. La versione Go richiesta e le versioni delle dipendenze sono registrate in `go.mod` e `go.sum`.

## Avvio

Avvia prima l'infrastruttura seguendo il README della root. Da questa directory:

```sh
cp .env.example .env
set -a
source .env
set +a
go run .
```

L'applicazione legge le variabili d'ambiente; non carica automaticamente `.env`. Le credenziali di esempio sono fittizie e destinate a LocalStack. `SQS_QUEUE_URL` è obbligatoria. `SQS_ENDPOINT` imposta l'endpoint locale del client; senza questa variabile l'SDK usa la risoluzione AWS standard. La regione e le credenziali sono lette dalla configurazione standard dell'SDK.

In un altro terminale, dalla root del repository:

```sh
curl -i http://127.0.0.1:8080/events \
  -H 'Content-Type: application/json' \
  --data-binary @examples/events/telemetry.json
```

La risposta prevista è `202 Accepted` con un `messageId` di SQS. Il messaggio resta nella coda finché non viene elaborato e cancellato: il programma TypeScript legge e valida, ma non salva né cancella ancora i messaggi. Non confondere `messageId` con `eventId`.

Per ispezionare un messaggio, dalla root:

```sh
docker compose -f infra/docker-compose.yaml exec -T localstack \
  awslocal sqs receive-message \
  --queue-url http://sqs.eu-west-1.localhost.localstack.cloud:4566/000000000000/green-scale-events-queue \
  --region eu-west-1 --wait-time-seconds 1
```

Questa lettura conta come ricezione e rende temporaneamente invisibile il messaggio. Ripeterla senza cancellare il messaggio può portarlo in DLQ secondo la policy configurata.

## Comportamento HTTP

| Caso | Risposta |
| --- | --- |
| Oggetto JSON inviato a SQS con successo | `202` con `messageId` |
| JSON malformato, `null`, array o valori multipli | `400` |
| Corpo oltre 64 KiB | `413` |
| Content-Type diverso da `application/json` | `415` |
| Invio SQS fallito o scaduto | `503` |

La validazione dei campi del contratto avviene nel consumatore TypeScript: `{}` viene quindi accettato dal gateway. Il timeout di invio è 2 secondi e include gli eventuali tentativi dell'SDK. Un errore o un timeout non prova che SQS non abbia ricevuto il messaggio: un retry del produttore deve conservare lo stesso `eventId`.

Il server ascolta su loopback per impostazione predefinita. `HTTP_ADDR` permette di cambiarlo. Su `SIGINT` o `SIGTERM` concede fino a 10 secondi alle richieste in corso per terminare.

## Verifiche

```sh
go test -race ./...
go vet ./...
go build -o bin/gateway .
```

I test HTTP usano un sostituto di SQS: verificano rifiuto degli input errati senza invio, conservazione del corpo e assenza di falsi `202` quando la dipendenza fallisce. La prova con LocalStack verifica separatamente il collegamento reale.

Questo incremento non include autenticazione, limitazione della concorrenza o misure di throughput. Il consumatore TypeScript legge e valida con Zod; la tabella PostgreSQL ha una chiave primaria su `event_id`. Il collegamento al salvataggio, la gestione dell'idempotenza e la cancellazione da SQS sono i prossimi passi.
