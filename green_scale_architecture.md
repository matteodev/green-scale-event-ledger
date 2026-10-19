# The Green-Scale Event Ledger: Technical Architecture & Initial Configuration

This document outlines the technical specification and initial configuration files for **The Green-Scale Event Ledger**, an asynchronous, decoupled, high-throughput event ingestion system designed to build senior-level expertise in Distributed Systems, Cloud Architecture, and Semantic Analytics.

---

## 1. Local Infrastructure: `docker-compose.yml`

This setup orchestrates **LocalStack** (for AWS SQS emulation), **PostgreSQL** with native vector extensions via `ankane/pgvector`, and **Redis** for state tracking or rate limiting. 

```yaml
version: '3.8'

services:
  localstack:
    image: localstack/localstack:latest
    container_name: green_scale_localstack
    ports:
      - "4566:4566"
    environment:
      - SERVICES=sqs
      - AWS_DEFAULT_REGION=eu-west-1
    volumes:
      - "./init-scripts:/etc/localstack/init/ready.d"
      - "localstack_data:/var/lib/localstack"
    networks:
      - green_scale_network

  postgres:
    image: ankane/pgvector:latest
    container_name: green_scale_postgres
    ports:
      - "5432:5432"
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=postgres_secure_pass
      - POSTGRES_DB=event_ledger
    volumes:
      - "postgres_data:/var/lib/postgresql/data"
    networks:
      - green_scale_network

  redis:
    image: redis:7-alpine
    container_name: green_scale_redis
    ports:
      - "6379:6379"
    command: redis-server --appendonly yes
    volumes:
      - "redis_data:/data"
    networks:
      - green_scale_network

volumes:
  localstack_data:
  postgres_data:
  redis_data:

networks:
  green_scale_network:
    driver: bridge
```

---

## 2. Queue Provisioning Script: `init-sqs.sh`

This script runs automatically when LocalStack is ready, creating a Dead Letter Queue (DLQ) and binding it to the main processing queue via a Redrive Policy.

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "########### Initializing SQS Queues ###########"

# 1. Create Dead Letter Queue (DLQ)
echo "Creating green-scale-events-dlq..."
DLQ_URL=$(awslocal sqs create-queue \
    --queue-name green-scale-events-dlq \
    --region eu-west-1 \
    --query 'QueueUrl' --output text)

# Extract DLQ ARN to map inside the RedrivePolicy
DLQ_ARN="arn:aws:sqs:eu-west-1:000000000000:green-scale-events-dlq"

# 2. Create Main Ingestion Queue linked to DLQ
echo "Creating green-scale-events-queue with Redrive Policy..."
MAIN_QUEUE_URL=$(awslocal sqs create-queue \
    --queue-name green-scale-events-queue \
    --region eu-west-1 \
    --attributes '{
        "VisibilityTimeout": "30",
        "RedrivePolicy": "{\"maxReceiveCount\":\"3\", \"deadLetterTargetArn\":\""'"$DLQ_ARN"'"\"}"
    }' \
    --query 'QueueUrl' --output text)

echo "########### SQS Configuration Completed Successfully ###########"
echo "Main Queue URL: $MAIN_QUEUE_URL"
echo "DLQ URL: $DLQ_URL"
```

---

## 3. Semantic Engine Runtime Validation: `schema.ts`

Using **TypeScript** and **Zod**, this module handles strict structural and contextual validation of incoming data models in the Worker microservice before internal handling or vector generation.

```typescript
import { z } from 'zod';

export const EventTypeEnum = z.enum(['telemetry', 'transaction', 'audit']);
export type EventType = z.infer<typeof EventTypeEnum>;

export const EventPayloadSchema = z.object({
  eventId: z.string().uuid({ message: "eventId must be a valid RFC4122 UUID" }),
  timestamp: z.string().datetime({ message: "timestamp must be a valid ISO 8601 string" }),
  source: z.string().min(1, { message: "source context cannot be empty" }),
  eventType: EventTypeEnum,
  meta: z.object({
    userId: z.string().min(1, { message: "meta.userId is mandatory for tracing" }),
    ipAddress: z.string().ip({ version: ['v4', 'v6'], message: "meta.ipAddress must be a valid IP format" }),
  }),
  data: z.record(z.any()).refine(
    (obj) => Object.keys(obj).length > 0, 
    { message: "data block must be a non-empty payload object" }
  ),
});

export type EventPayload = z.infer<typeof EventPayloadSchema>;
```

---

## 4. Database Schema and Vector Indices: `schema.sql`

PostgreSQL DDL creating the persistence schema. It leverages standard relational mechanisms coupled with an **HNSW (Hierarchical Navigable Small World)** vector index optimized for high-throughput semantic similarity queries.

```sql
-- Enable pgvector extension explicitly within the database context
CREATE EXTENSION IF NOT EXISTS pgvector;

-- Master Event Ledger table definition
CREATE TABLE IF NOT EXISTS events (
    id BIGSERIAL PRIMARY KEY,
    event_id UUID NOT NULL UNIQUE,
    event_type VARCHAR(32) NOT NULL,
    source VARCHAR(128) NOT NULL,
    user_id VARCHAR(128) NOT NULL,
    payload_raw JSONB NOT NULL,
    embedding VECTOR(1536), -- Designed for OpenAI text-embedding-3-small or similar 1536-dim models
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- Optimize core transactional access paths
CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);
-- JSONB functional index for fast deep payload lookups
CREATE INDEX IF NOT EXISTS idx_events_payload_meta ON events USING gin (payload_raw);

-- Construct Hierarchical Navigable Small World (HNSW) index for Cosine Distance operator (<=>)
-- m=16, ef_construction=64 represents an optimal trade-off between build velocity and recall precision
CREATE INDEX IF NOT EXISTS idx_events_embedding_hnsw 
ON events USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

---

## 5. Senior-Level Architectural & Implementation Guidelines

To transform this blueprint into a robust production-ready artifact for your `matcode.dev` portfolio, avoid naive implementations. Follow these strict patterns:

### A. Ingestion Gateway (Go + Fiber)
* **Zero-Blocking Architecture:** The endpoint must strictly parse JSON metadata without deep structural evaluation, push the payload to SQS within a **10ms deadline context**, and immediately return a `202 Accepted` status code. 
* **Worker Pools for Network Sinks:** Maintain a highly optimized global connection pool for SQS clients. Utilize Go channels (`chan`) and worker pools to avoid spawning unlimited goroutines under severe request spikes, protecting system memory exhaustion.
* **Graceful Shutdown:** Trap system interrupts (`SIGINT`, `SIGTERM`). Block exit procedures to allow pending in-flight HTTP payloads and SQS network transfers to flush completely before terminating.

### B. Semantic Processor & Worker (TypeScript + Node.js)
* **True Long Polling Configuration:** Configure your AWS SDK SQS client parameter `WaitTimeSeconds` to exactly `20`. This keeps network connections open up to 20 seconds waiting for messages, significantly reducing empty response overheads and lowering costs.
* **Resilient Circuit Breaker Pattern:** Wrap external dependencies (such as AI Vector Embedding Generators or the main PostgreSQL Instance) inside a structured State Machine (`Closed`, `Open`, `Half-Open`). If the external AI service rate-limits or crashes, trip the breaker instantly, stop polling SQS to prevent backpressure build-up, and fail gracefully.
* **Idempotency & Partial Failure Isolation:** SQS exhibits at-least-once delivery. You must utilize **Redis** as a distributed lock/deduplication layer using `eventId` as a unique key. If processing an event fails *after* a database state change but *before* SQS acknowledgment, the retried action must not corrupt application states.
