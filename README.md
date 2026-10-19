# Green-Scale Event Ledger

**Un progetto dimostrativo per comprendere e costruire un sistema di elaborazione asincrona degli eventi, un passo alla volta.**

Italiano · [English](README.en.md)

Il progetto collega un gateway HTTP in Go a una coda SQS emulata con LocalStack. Il modulo TypeScript definisce e verifica il contratto degli eventi con Zod. Il percorso prosegue con consumo dei messaggi, persistenza e idempotenza, interamente in locale: non è richiesto un account AWS.

## Stato del progetto

Prima tappa dimostrativa, in sviluppo attivo.

| Componente | Stato attuale |
| --- | --- |
| Ambiente Docker Compose | LocalStack, PostgreSQL con pgvector e Redis configurati; disponibilità verificata |
| Code SQS | Coda principale e DLQ create automaticamente; policy configurata e verificata |
| Gateway Go | `POST /events` invia il corpo a SQS; test HTTP e prova con LocalStack completati |
| Contratto TypeScript | Schema Zod riutilizzabile, tipo derivato e programma dimostrativo eseguibile |
| Consumatore SQS | Da implementare |
| Persistenza e idempotenza | Da implementare |
| Redis applicativo e ricerca vettoriale | Da progettare e implementare |

La presenza dei container PostgreSQL e Redis non implica che siano già collegati al codice applicativo. Non sono ancora disponibili benchmark o una pipeline CI.

## Architettura

Il gateway e il programma di validazione sono attualmente eseguibili separatamente:

```text
Client HTTP → gateway Go → SQS locale

Oggetto di esempio → schema Zod → dati validati oppure errori
```

Il flusso completo previsto è:

```text
Client → gateway Go → SQS → worker TypeScript → PostgreSQL
                      │
                      └── DLQ, dopo ripetute ricezioni senza completamento
```

SQS separa la ricezione dall'elaborazione. `202 Accepted` significa che la coda ha confermato l'invio; non significa che l'evento sia stato elaborato o salvato nel database.

## Prerequisiti

- Docker Engine e plugin Docker Compose, con accesso al daemon.
- Go compatibile con la direttiva `go 1.26.9` in `services/ingestion-gateway/go.mod`.
- Node.js e npm; ambiente verificato con Node `22.23.1` e npm `10.9.8`.
- `curl` e una shell Bash o Zsh per i comandi riportati.
- Porte locali `4566`, `5432`, `6379` e `8080` disponibili.

Go e Node vengono eseguiti sull'host. Il Compose avvia soltanto l'infrastruttura. Il primo avvio richiede accesso alla rete per scaricare immagini e dipendenze.

## Provare il progetto

### 1. Avviare l'infrastruttura

Dalla root del repository:

```bash
docker compose -f infra/docker-compose.yaml config --quiet
docker compose -f infra/docker-compose.yaml up -d
docker compose -f infra/docker-compose.yaml ps
```

Attendere che LocalStack sia pronto, poi verificare le code:

```bash
docker compose -f infra/docker-compose.yaml exec -T localstack   awslocal sqs list-queues --region eu-west-1
```

Devono comparire `green-scale-events-queue` e `green-scale-events-dlq`. Se mancano, consultare i log:

```bash
docker compose -f infra/docker-compose.yaml logs localstack
```

### 2. Avviare il gateway

In un terminale dedicato, partendo dalla root:

```bash
cd services/ingestion-gateway
set -a
source .env.example
set +a
go run .
```

Il file contiene credenziali fittizie per LocalStack. Il processo legge le variabili d'ambiente e resta in ascolto su `127.0.0.1:8080`. Non carica automaticamente un file `.env`.

### 3. Inviare un evento

In un secondo terminale, dalla root:

```bash
curl -i http://127.0.0.1:8080/events   -H 'Content-Type: application/json'   --data-binary @examples/events/telemetry.json
```

Risposta attesa, con identificativo variabile:

```text
HTTP/1.1 202 Accepted
...
{"messageId":"<identificativo assegnato da SQS>"}
```

| Condizione | Risposta HTTP |
| --- | --- |
| Oggetto JSON inviato con conferma SQS | `202` |
| JSON malformato o valore diverso da un oggetto | `400` |
| Corpo maggiore di 64 KiB | `413` |
| Content-Type non accettato | `415` |
| Errore o timeout nell'invio a SQS | `503` |

Il gateway verifica formato e dimensione del JSON, non il contratto completo: anche `{}` supera i suoi controlli. Il timeout di invio è 2 secondi. Un errore di rete non prova che il messaggio non sia arrivato: i retry del medesimo evento devono conservarne l'`eventId`.

Per leggere un messaggio manualmente, dalla root:

```bash
docker compose -f infra/docker-compose.yaml exec -T localstack   awslocal sqs receive-message   --queue-url http://sqs.eu-west-1.localhost.localstack.cloud:4566/000000000000/green-scale-events-queue   --region eu-west-1 --wait-time-seconds 5 --max-number-of-messages 1
```

La lettura non cancella il messaggio: lo rende temporaneamente invisibile. Letture ripetute senza cancellazione possono portarlo in DLQ. Se sono presenti più messaggi, quello restituito può provenire da una prova precedente. La policy attuale usa `VisibilityTimeout=30` secondi e `maxReceiveCount=3`.

### 4. Eseguire la validazione TypeScript

In un altro terminale, partendo dalla root:

```bash
cd services/semantic-worker
npm ci
npm run check
npm run build
npm start
```

Il programma valida l'oggetto definito in `src/validate-event.ts` e stampa `Evento valido` con i dati. Non legge ancora da SQS. Per eseguirlo durante lo sviluppo: `npm run dev`.

Il contratto attuale in `src/event-schema.ts` richiede:

| Campo | Regola |
| --- | --- |
| `eventId` | UUID valido |
| `timestamp` | Data e ora ISO, in UTC con suffisso `Z` |
| `eventType` | `telemetry`, `transaction` oppure `audit` |
| `source` | Stringa non vuota dopo trim |
| `meta.userId` | Stringa non vuota dopo trim |
| `meta.ipAddress` | Formato IPv4 oppure IPv6 |
| `data` | Oggetto con almeno una proprietà |

Zod verifica i dati a runtime; `EventPayload`, ricavato con `z.infer`, serve al controllo statico TypeScript. Il contenuto di `data` non ha ancora regole specifiche per categoria. Identificativo utente e IP sono metadati dichiarati, non una prova d'identità.

### 5. Arrestare l'ambiente

Interrompere il gateway con `Ctrl+C`, poi dalla root:

```bash
docker compose -f infra/docker-compose.yaml down
```

I volumi PostgreSQL e Redis vengono mantenuti. La persistenza LocalStack è disabilitata: i messaggi non vanno considerati durevoli tra riavvii e lo script ricrea le code all'avvio.

## Verifiche e apprendimenti

Dal servizio Go:

```bash
go test -race ./...
go vet ./...
```

Sono stati verificati invio HTTP reale a LocalStack, rifiuto di JSON malformato e risposta `503` verso un endpoint SQS irraggiungibile. I test automatici Go usano un sostituto del client SQS. In TypeScript sono stati eseguiti controllo statico, build e prove manuali su UUID, categorie e campi annidati; non esiste ancora una suite automatizzata del worker.

Gli esperimenti hanno evidenziato tre distinzioni centrali:

- Accettare un messaggio ed elaborarlo sono operazioni separate.
- Ricevere da SQS non cancella il messaggio: l'idempotenza è un requisito del prossimo incremento.
- JSON ben formato, tipi TypeScript e dati applicativi validi sono controlli differenti.

## Struttura

```text
infra/                         Compose e inizializzazione SQS
examples/events/               Evento JSON per provare il gateway
services/ingestion-gateway/    Gateway Go, configurazione di esempio e test
services/semantic-worker/      Schema Zod ed esperimento TypeScript
```

## Prossimi passi

1. Leggere da SQS con il worker e applicare lo schema condiviso.
2. Salvare su PostgreSQL prima di cancellare il messaggio.
3. Gestire riconsegne identiche e conflitti sullo stesso `eventId`.
4. Verificare il percorso di fallimento fino alla DLQ.
5. Aggiungere test del worker e controlli automatici prima della demo completa.

Le credenziali e le porte del Compose sono destinate allo sviluppo locale. La proposta iniziale in `green_scale_architecture.md` contiene anche funzionalità future: questo README descrive lo stato implementato. Materiale editoriale e diario personale restano fuori dalla pubblicazione GitHub.
