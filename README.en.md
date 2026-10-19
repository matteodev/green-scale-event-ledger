# Green-Scale Event Ledger

**A demonstration project for understanding and building asynchronous event processing, one step at a time.**

[Italiano](README.md) · English

The project connects a Go HTTP gateway to an SQS queue emulated by LocalStack. A TypeScript module defines and validates the event contract with Zod. Message consumption, persistence and idempotency are the next milestones. Everything runs locally; no AWS account is required.

## Project status

An initial demonstration milestone, under active development.

| Component | Current state |
| --- | --- |
| Docker Compose environment | LocalStack, PostgreSQL with pgvector and Redis configured; availability verified |
| SQS queues | Main queue and DLQ provisioned automatically; policy configured and inspected |
| Go gateway | `POST /events` sends the body to SQS; HTTP tests and a LocalStack integration exercise completed |
| TypeScript contract | Reusable Zod schema, inferred type and runnable validation example |
| SQS consumer | Not implemented yet |
| Persistence and idempotency | Not implemented yet |
| Application use of Redis and vector search | Still to be designed and implemented |

Running PostgreSQL and Redis containers does not mean they are connected to the application yet. Benchmarks and a CI pipeline are not available yet.

## Architecture

The gateway and validation example currently run independently:

```text
HTTP client → Go gateway → local SQS

Sample object → Zod schema → validated data or validation errors
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

The program validates the object defined in `src/validate-event.ts` and prints `Evento valido` followed by the data. It does not consume SQS messages yet. Use `npm run dev` to run it during development.

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

### 5. Stop the environment

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

Verified exercises include a real HTTP send to LocalStack, rejection of malformed JSON and a `503` response when targeting an unreachable SQS endpoint. Automated Go tests use a substitute SQS client. TypeScript checks, compilation and manual exercises cover UUIDs, event categories and nested fields; there is no automated worker test suite yet.

The experiments highlight three distinctions:

- Accepting a message and processing it are separate operations.
- Receiving from SQS does not delete a message; idempotency is a requirement for the next increment.
- Well-formed JSON, TypeScript types and valid application data require different checks.

## Repository structure

```text
infra/                         Compose and SQS initialization
examples/events/               JSON event for exercising the gateway
services/ingestion-gateway/    Go gateway, example configuration and tests
services/semantic-worker/      Zod schema and TypeScript experiment
```

## Next steps

1. Consume SQS messages and apply the shared schema.
2. Persist events in PostgreSQL before deleting messages.
3. Handle identical redeliveries and conflicting payloads sharing an `eventId`.
4. Verify the failure path through to the DLQ.
5. Add worker tests and automated checks before the complete demonstration.

Compose credentials and published ports are intended for local development. The original proposal in `green_scale_architecture.md` includes future features; this README describes the implemented state.