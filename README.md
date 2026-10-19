# Green-Scale Event Ledger

Progetto didattico per costruire e comprendere un sistema di elaborazione asincrona degli eventi, documentando implementazione, verifiche ed errori.

Il percorso previsto è: client → gateway Go → SQS → worker TypeScript → PostgreSQL. Redis e ricerca vettoriale saranno introdotti quando avremo definito e verificato il loro ruolo.

## Stato attuale

- Configurazione Docker Compose per LocalStack (SQS), PostgreSQL e Redis.
- Script di inizializzazione della coda principale e della dead letter queue (DLQ).
- Gateway e worker ancora da implementare.
- Nessuna misura di prestazioni o garanzia di produzione ancora verificata.

## Avvio locale

Prerequisiti: Docker Engine e plugin Docker Compose, con accesso al daemon.

```sh
docker compose -f infra/docker-compose.yaml config --quiet
docker compose -f infra/docker-compose.yaml up -d
docker compose -f infra/docker-compose.yaml ps
docker compose -f infra/docker-compose.yaml logs localstack
docker compose -f infra/docker-compose.yaml exec localstack awslocal sqs list-queues --region eu-west-1
```

La verifica delle code deve mostrare `green-scale-events-queue` e `green-scale-events-dlq`. Lo stato del container, da solo, non dimostra che lo script di inizializzazione sia riuscito.

Per arrestare l'ambiente mantenendo i volumi di PostgreSQL e Redis:

```sh
docker compose -f infra/docker-compose.yaml down
```

Le credenziali presenti nel Compose sono per sviluppo locale. Le porte pubblicate vanno considerate prima di usare l'ambiente su un host esposto. Le code LocalStack vengono ricreate all'avvio; la persistenza è disabilitata.

## Percorso e documentazione

- [Roadmap](docs/roadmap.md): fasi e criteri di completamento.
- [Diario tecnico](docs/diario.md): problemi, decisioni e verifiche.
- [Contratto evento](docs/contratto-evento.md): campi e responsabilità di gateway e worker.
- [Proposta architetturale](green_scale_architecture.md): ipotesi iniziali, da confrontare con il codice e gli esperimenti.
- [Articoli](blog-posts/README.md): bozze in italiano per matcode.dev.

Ogni fase segue questo ciclo: spiegare il concetto, fare una modifica piccola, verificarne il risultato, documentare ciò che abbiamo imparato. Le caratteristiche avanzate verranno aggiunte dopo un primo flusso completo funzionante.
