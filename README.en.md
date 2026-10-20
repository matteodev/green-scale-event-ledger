# Green-Scale Event Ledger

**A demonstration project for understanding and building asynchronous event processing, one step at a time.**

[Italiano](README.md) · English

The project connects a Go HTTP gateway to an SQS queue emulated by LocalStack. The TypeScript program consumes messages and validates the event contract with Zod. An initial PostgreSQL table and insert function are present; the first insert and integration with consumption are still pending. Persistence and idempotency are the next milestones. Everything runs locally; no AWS account is required.

## Project status

An initial demonstration milestone, under active development.

| Component | Current state |
| --- | --- |
| Docker Compose environment | LocalStack, PostgreSQL with pgvector and Redis configured; availability verified |
| SQS queues | Main queue and DLQ provisioned automatically; policy configured and inspected |
| Go gateway | `POST /events` sends the body to SQS; HTTP tests and a LocalStack integration exercise completed |
| TypeScript contract | Reusable Zod schema, inferred type and runnable validation example |
| SQS consumer | Single long-poll request, JSON parsing and Zod validation; valid and nonconforming events verified |
| Application PostgreSQL access | Table and connection verified; `saveEvent` defined and compiled, first insert still pending |
| Idempotency and SQS deletion | Not implemented yet; primary key on `event_id` already present |
| Application use of Redis and vector search | Still to be designed and implemented |

SQS consumption is not yet connected to persistence: the consumer prints results and exits without deleting messages. Redis is not used by the code yet. Benchmarks and a CI pipeline are not available yet.

## Architecture

The currently verified flow is:

```text
HTTP client → Go gateway → local SQS → TypeScript receive → JSON parsing → Zod

TypeScript → connection verification query → PostgreSQL
```

The intended complete flow is:

```text
Client → Go gateway → SQS → TypeScript worker → PostgreSQL
                       │
                       └── DLQ, after repeated receives without completion
```

SQS separates ingestion from processing. `202 Accepted` means SQS acknowledged the send; it does not mean the event has been processed or saved in the database.

## Prerequisites

- Docker Engine and the Docker Compose plugin, with access to the daemon.
- Go compatible with the `go 1.26.9` directive in `services/ingestion-gateway/go.mod`.
- Node.js and npm; verified using Node `22.23.1` and npm `10.9.8`.
- `curl` and Bash or Zsh for the commands below.
- Local ports `4566`, `5432`, `6379` and `8080` available.

Go and Node run on the host. Compose starts the infrastructure only. Initial setup requires network access to download images and dependencies.

## Run the demonstration

### 1. Start the infrastructure

From the repository root:

```bash
docker compose -f infra/docker-compose.yaml config --quiet
docker compose -f infra/docker-compose.yaml up -d
docker compose -f infra/docker-compose.yaml ps
```

Wait for LocalStack to become ready, then inspect the queues:

```bash
docker compose -f infra/docker-compose.yaml exec -T localstack \
  awslocal sqs list-queues --region eu-west-1
```

Both `green-scale-events-queue` and `green-scale-events-dlq` should appear. If they are missing, inspect the logs:

```bash
docker compose -f infra/docker-compose.yaml logs localstack
```

### 2. Start the gateway

In a dedicated terminal, starting from the repository root:

```bash
cd services/ingestion-gateway
set -a
source .env.example
set +a
go run .
```

The example contains dummy LocalStack credentials. The application reads environment variables and listens on `127.0.0.1:8080`. It does not load a `.env` file automatically.

### 3. Send an event

In a second terminal, from the repository root:

```bash
curl -i http://127.0.0.1:8080/events \
  -H 'Content-Type: application/json' \
  --data-binary @examples/events/telemetry.json
```

Expected response, with a different identifier on each send:

```text
HTTP/1.1 202 Accepted
...
{"messageId":"<identifier assigned by SQS>"}
```

| Condition | HTTP response |
| --- | --- |
| JSON object sent with SQS acknowledgement | `202` |
| Malformed JSON or a value other than an object | `400` |
| Body larger than 64 KiB | `413` |
| Unsupported Content-Type | `415` |
| SQS send failure or timeout | `503` |

The gateway checks JSON structure and size, not the complete event contract: even `{}` passes its checks. The send timeout is 2 seconds. A network error does not prove that delivery failed; retries of the same event must retain its `eventId`.

To receive a message manually, from the repository root:

```bash
docker compose -f infra/docker-compose.yaml exec -T localstack \
  awslocal sqs receive-message \
  --queue-url http://sqs.eu-west-1.localhost.localstack.cloud:4566/000000000000/green-scale-events-queue \
  --region eu-west-1 --wait-time-seconds 5 --max-number-of-messages 1
```

Receiving does not delete the message; it temporarily hides it. Repeated receives without deletion may move it to the DLQ. If several messages exist, the returned message may be from an earlier experiment. The current policy uses `VisibilityTimeout=30` seconds and `maxReceiveCount=3`.

### 4. Run TypeScript validation

In another terminal, starting from the repository root:

```bash
cd services/semantic-worker
npm ci
npm run check
npm run build
npm start
```

`npm start` still runs the isolated experiment: it validates the object defined in `src/validate-event.ts` and prints `Evento valido` followed by the data. Use `npm run dev` to run it during development. SQS consumption uses the separate program below.

The current contract in `src/event-schema.ts` requires:

| Field | Rule |
| --- | --- |
| `eventId` | Valid UUID |
| `timestamp` | ISO date and time, in UTC with a `Z` suffix |
| `eventType` | `telemetry`, `transaction` or `audit` |
| `source` | Nonempty string after trimming |
| `meta.userId` | Nonempty string after trimming |
| `meta.ipAddress` | IPv4 or IPv6 format |
| `data` | Object containing at least one property |

Zod validates data at runtime; `EventPayload`, derived using `z.infer`, provides the static TypeScript type. Category-specific rules for the contents of `data` are not implemented yet. User identifiers and IP addresses are declared metadata, not proof of identity.

### 5. Receive and validate an SQS message

From `services/semantic-worker`, load the local configuration and run:

```bash
set -a
source .env.example
set +a
node dist/receive-event.js
```

The preceding build also generates this file. The program makes one request, waits up to 20 seconds and receives at most one message. If the body is readable JSON matching the schema, it prints `Evento validato`. Otherwise it distinguishes a missing body, malformed JSON and contract violations. If no message is returned, it prints `Nessun messaggio disponibile`.

To exercise the separation of responsibilities, send `{}` to the gateway: HTTP returns `202`, while the consumer rejects it for missing required fields. An earlier message may be returned instead; compare its `MessageId` with the HTTP response. No messages are deleted yet, including valid ones, so repeated receives can exhaust the DLQ policy's receive allowance. Actual transfer to the DLQ has not been verified yet.

### 6. Prepare PostgreSQL and verify connectivity

From the repository root, apply the first SQL script **once to a database without the `events` table**:

```bash
docker compose -f infra/docker-compose.yaml exec -T postgres \
  psql -U postgres -d green_scale_ledger -v ON_ERROR_STOP=1 \
  < infra/migrations/001_create_events.sql
```

Compose does not apply this script automatically. There is no migration management system yet: skip creation if the table already exists. To inspect it:

```bash
docker compose -f infra/docker-compose.yaml exec -T postgres \
  psql -U postgres -d green_scale_ledger -c '\d events'
```

The table contains the UUID primary key `event_id`, `event_type`, `source`, `occurred_at`, the complete validated event in JSONB `payload`, and `stored_at` with a `NOW()` default.

Then, from `services/semantic-worker`:

```bash
set -a
source .env.example
set +a
node dist/check-db.js
```

This program runs a read-only query and prints `Connessione riuscita` with the database name and server time. The `PG*` variables in `.env.example` match the local Compose configuration. The pool allows up to five connections with a two-second acquisition/connection timeout.

`src/event-repository.ts` exposes `saveEvent(event)` using a parameterized query. It passes type checking and compilation, but has not been exercised for a first insert or connected to `receive-event.ts` yet. Repeated insertion of the same `eventId` would produce a duplicate-key error; distinguishing identical redeliveries from conflicting events is upcoming work.

### 7. Stop the environment

Stop the gateway with `Ctrl+C`, then run from the repository root:

```bash
docker compose -f infra/docker-compose.yaml down
```

PostgreSQL and Redis volumes are retained. LocalStack persistence is disabled: messages should not be treated as durable across restarts, and the startup script recreates the queues.

## Verification and learning outcomes

From the Go service directory:

```bash
go test -race ./...
go vet ./...
```

Verified exercises include a real HTTP send to LocalStack, rejection of malformed JSON and a `503` response when targeting an unreachable SQS endpoint. Automated Go tests use a substitute SQS client. TypeScript checks, compilation, manual schema exercises and SQS consumption of valid and nonconforming events have been verified. PostgreSQL table structure and connectivity have also been checked. Malformed JSON through SQS, the first insert and actual DLQ transfer remain untested; there is no automated worker test suite yet.

The experiments highlight three distinctions:

- Accepting a message and processing it are separate operations.
- Receiving from SQS does not delete a message; idempotency is a requirement for the next increment.
- Well-formed JSON, TypeScript types and valid application data require different checks.

## Repository structure

```text
infra/                         Compose, SQS initialization and first SQL script
examples/events/               JSON event for exercising the gateway
services/ingestion-gateway/    Go gateway, example configuration and tests
services/semantic-worker/      Schema, SQS consumption and PostgreSQL modules
```

## Next steps

1. Exercise the first insert and connect persistence to SQS validation.
2. Handle identical redeliveries and conflicting payloads sharing an `eventId`.
3. Delete messages only after completion and introduce continuous consumption.
4. Verify the failure path through to the DLQ.
5. Add worker tests and automated checks before the complete demonstration.

Compose credentials and published ports are intended for local development. The original proposal in `green_scale_architecture.md` includes future features; this README describes the implemented state.
