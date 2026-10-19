#!/bin/bash
set -euo pipefail

echo "----------- INIZIALIZZAZIONE CODE AWS SQS (LOCALSTACK) -----------"

# 1. Creiamo la Dead Letter Queue (DLQ).
# Questa coda raccoglierà i messaggi falliti che non siamo riusciti a elaborare.
DLQ_URL=$(awslocal sqs create-queue --queue-name green-scale-events-dlq --region eu-west-1 \
  --query QueueUrl --output text)

# 2. Recuperiamo l'ARN (Amazon Resource Name) della DLQ appena creata.
# Ci serve l'ARN per poter dire alla coda principale dove spedire i messaggi scartati.
DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --query "Attributes.QueueArn" --output text --region eu-west-1)

echo "DLQ identificata con ARN: $DLQ_ARN"

# 3. Creiamo la Coda Principale associandogli la Redrive Policy.
# - VisibilityTimeout=30: Quando un worker prende un messaggio, questo sparisce per 30 secondi.
# - maxReceiveCount=3: Se il messaggio viene estratto per 3 volte senza essere rimosso, finisce nella DLQ.
awslocal sqs create-queue \
  --queue-name green-scale-events-queue \
  --region eu-west-1 \
  --attributes '{
    "VisibilityTimeout": "30",
    "RedrivePolicy": "{\"deadLetterTargetArn\":\"'"$DLQ_ARN"'\",\"maxReceiveCount\":3}"
  }'

echo "----------- CONFIGURAZIONE SQS COMPLETATA CON SUCCESSO -----------"
