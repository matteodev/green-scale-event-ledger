# Green-Scale Event Ledger

**Un proyecto demostrativo para comprender y construir un sistema de procesamiento asíncrono de eventos, paso a paso.**

[Italiano](README.md) · [English](README.en.md) · Español

El proyecto conecta una API HTTP en Go con una cola SQS emulada mediante LocalStack. El consumidor TypeScript valida los eventos con Zod, los guarda en PostgreSQL y solicita la eliminación del mensaje solo tras insertar el evento o reconocer uno idéntico ya guardado. El flujo se ha verificado con pruebas manuales locales; no se necesita una cuenta de AWS.

## Estado del proyecto

Primera etapa demostrativa, en desarrollo activo.

| Componente | Estado actual |
| --- | --- |
| Entorno Docker Compose | LocalStack, PostgreSQL con pgvector y Redis configurados; disponibilidad verificada |
| Colas SQS | Cola principal y DLQ creadas automáticamente; política configurada y comprobada |
| Gateway Go | `POST /events` envía el cuerpo a SQS; pruebas HTTP y prueba con LocalStack realizadas |
| Contrato TypeScript | Esquema Zod reutilizable, tipo inferido y ejemplo de validación ejecutable |
| Consumidor SQS | Una petición con long polling, análisis del JSON y validación Zod; verificados eventos válidos y no conformes |
| Acceso a PostgreSQL | Inserción, entrega repetida idéntica y conflicto de contenido verificados por separado de SQS |
| Idempotencia y eliminación en SQS | Inserción y entrega idéntica verificadas con confirmación de eliminación; conflictos probados por separado, concurrencia pendiente |
| Uso de Redis y búsqueda vectorial | Pendientes de diseño e implementación |

El consumidor realiza una sola petición de lectura y termina; todavía no es un servicio en escucha continua. El código aún no utiliza Redis. Todavía no hay pruebas de rendimiento ni un flujo de integración continua.

## Arquitectura

El flujo verificado actualmente es:

```text
Cliente HTTP → gateway Go → SQS local → TypeScript → Zod → PostgreSQL
                                                         ↓
                                         confirmación de eliminación SQS
```

El flujo completo previsto es:

```text
Cliente → gateway Go → SQS → worker TypeScript → PostgreSQL
                        │
                        └── DLQ, tras recepciones repetidas sin completar el trabajo
```

SQS separa la recepción del procesamiento. `202 Accepted` significa que SQS ha confirmado el envío; no significa que el evento se haya procesado ni guardado en la base de datos.

## Requisitos

- Docker Engine y el complemento Docker Compose, con acceso al daemon.
- Go compatible con la directiva `go 1.26.9` de `services/ingestion-gateway/go.mod`.
- Node.js y npm; entorno verificado con Node `22.23.1` y npm `10.9.8`.
- `curl` y una shell Bash o Zsh para ejecutar los comandos siguientes.
- Puertos locales `4566`, `5432`, `6379` y `8080` disponibles.

Go y Node se ejecutan en el equipo anfitrión. Compose inicia únicamente la infraestructura. La configuración inicial requiere conexión a Internet para descargar las imágenes y las dependencias.

## Probar el proyecto

### 1. Iniciar la infraestructura

Desde la raíz del repositorio:

```bash
docker compose -f infra/docker-compose.yaml config --quiet
docker compose -f infra/docker-compose.yaml up -d
docker compose -f infra/docker-compose.yaml ps
```

Esperar a que LocalStack esté listo y comprobar las colas:

```bash
docker compose -f infra/docker-compose.yaml exec -T localstack \
  awslocal sqs list-queues --region eu-west-1
```

Deben aparecer `green-scale-events-queue` y `green-scale-events-dlq`. Si no aparecen, consultar los registros:

```bash
docker compose -f infra/docker-compose.yaml logs localstack
```

### 2. Iniciar el gateway

En una terminal dedicada, partiendo de la raíz:

```bash
cd services/ingestion-gateway
set -a
source .env.example
set +a
go run .
```

El archivo contiene credenciales ficticias para LocalStack. La aplicación lee las variables de entorno y escucha en `127.0.0.1:8080`. No carga automáticamente un archivo `.env`.

### 3. Enviar un evento

En una segunda terminal, desde la raíz:

```bash
curl -i http://127.0.0.1:8080/events \
  -H 'Content-Type: application/json' \
  --data-binary @examples/events/telemetry.json
```

Respuesta esperada, con un identificador distinto en cada envío:

```text
HTTP/1.1 202 Accepted
...
{"messageId":"<identificador asignado por SQS>"}
```

| Condición | Respuesta HTTP |
| --- | --- |
| Objeto JSON enviado con confirmación de SQS | `202` |
| JSON mal formado o valor que no es un objeto | `400` |
| Cuerpo mayor de 64 KiB | `413` |
| Content-Type no admitido | `415` |
| Error o tiempo de espera agotado al enviar a SQS | `503` |

El gateway comprueba la estructura y el tamaño del JSON, no el contrato completo: incluso `{}` supera sus controles. El tiempo máximo de envío es de 2 segundos. Un error de red no demuestra que el mensaje no haya llegado; los reintentos del mismo evento deben conservar su `eventId`.

Para recibir un mensaje manualmente, desde la raíz:

```bash
docker compose -f infra/docker-compose.yaml exec -T localstack \
  awslocal sqs receive-message \
  --queue-url http://sqs.eu-west-1.localhost.localstack.cloud:4566/000000000000/green-scale-events-queue \
  --region eu-west-1 --wait-time-seconds 5 --max-number-of-messages 1
```

La lectura no elimina el mensaje: lo oculta temporalmente. Las recepciones repetidas sin eliminación pueden enviarlo a la DLQ. Si hay varios mensajes, el recibido puede proceder de una prueba anterior. La política actual utiliza `VisibilityTimeout=30` segundos y `maxReceiveCount=3`.

### 4. Ejecutar la validación TypeScript

En otra terminal, partiendo de la raíz:

```bash
cd services/semantic-worker
npm ci
npm run check
npm run build
npm start
```

`npm start` sigue ejecutando el ejemplo aislado: valida el objeto definido en `src/validate-event.ts` y muestra `Evento valido` seguido de los datos. Para ejecutarlo durante el desarrollo: `npm run dev`. El consumo de SQS utiliza el programa independiente del siguiente paso.

El contrato actual de `src/event-schema.ts` exige:

| Campo | Regla |
| --- | --- |
| `eventId` | UUID válido |
| `timestamp` | Fecha y hora ISO, en UTC con sufijo `Z` |
| `eventType` | `telemetry`, `transaction` o `audit` |
| `source` | Cadena no vacía después de eliminar los espacios de los extremos |
| `meta.userId` | Cadena no vacía después de eliminar los espacios de los extremos |
| `meta.ipAddress` | Formato IPv4 o IPv6 |
| `data` | Objeto con al menos una propiedad |

Zod valida los datos durante la ejecución; `EventPayload`, obtenido mediante `z.infer`, proporciona el tipo estático de TypeScript. Aún no existen reglas específicas por categoría para el contenido de `data`. El identificador de usuario y la dirección IP son metadatos declarados, no una prueba de identidad.

### 5. Preparar PostgreSQL y comprobar la conexión

Desde la raíz, aplicar el primer script SQL **una sola vez, en una base de datos sin la tabla `events`**:

```bash
docker compose -f infra/docker-compose.yaml exec -T postgres \
  psql -U postgres -d green_scale_ledger -v ON_ERROR_STOP=1 \
  < infra/migrations/001_create_events.sql
```

Compose no aplica el script automáticamente. Todavía no existe un sistema de gestión de migraciones: omitir la creación si la tabla ya existe. Para inspeccionarla:

```bash
docker compose -f infra/docker-compose.yaml exec -T postgres \
  psql -U postgres -d green_scale_ledger -c '\d events'
```

La tabla contiene `event_id` UUID como clave primaria, `event_type`, `source`, `occurred_at`, el evento validado completo en `payload` JSONB y `stored_at` con el valor predeterminado `NOW()`.

Después, desde `services/semantic-worker`:

```bash
set -a
source .env.example
set +a
node dist/check-db.js
```

El programa ejecuta una consulta de solo lectura y muestra `Connessione riuscita` con el nombre de la base de datos y la hora del servidor. Las variables `PG*` de `.env.example` coinciden con la configuración local de Compose. El pool permite hasta cinco conexiones y un tiempo máximo de espera de dos segundos para obtener o establecer una conexión.

`src/event-repository.ts` expone `saveEvent(event)` mediante consultas parametrizadas: devuelve `inserted` para un evento nuevo, `already_saved` para el mismo ID y contenido, y señala un conflicto si el mismo ID tiene datos distintos, sin sobrescribir el original. `src/save-example.ts` lee y valida el archivo de ejemplo, genera un nuevo UUID y guarda dos veces el mismo evento sintético. Después de compilar y cargar las variables, ejecutar desde el directorio del worker:

```bash
node dist/save-example.js
```

Este programa modifica la base de datos: cada ejecución genera un nuevo UUID y puede añadir una fila. Se esperan `Primo salvataggio: inserted` y después `Secondo salvataggio: already_saved`. Las llamadas son secuenciales; se ha verificado una sola fila para el UUID de la prueba. Un experimento anterior con el mismo ID y una temperatura distinta produjo un conflicto sin alterar los datos originales. La persistencia ya está conectada a `receive-event.ts`: se han verificado una nueva inserción y el reconocimiento de un evento idéntico guardado, seguidos de confirmación de eliminación. Todavía no se han probado ejecuciones concurrentes.

### 6. Recibir, guardar y completar un mensaje de SQS

Desde `services/semantic-worker`, cargar la configuración local y ejecutar:

```bash
set -a
source .env.example
set +a
node dist/receive-event.js
```

La compilación TypeScript también genera este archivo. El programa realiza una sola petición, espera hasta 20 segundos y recibe como máximo un mensaje. Tras interpretar el JSON y validarlo, guarda el evento y muestra `Evento elaborato` con MessageId, eventId y resultado `inserted` o `already_saved`. Después envía DeleteMessage con el ReceiptHandle de la recepción actual y muestra `Cancellazione confermata da SQS`. Distingue cuerpo ausente, JSON mal formado e incumplimiento del contrato. Si no recibe mensajes, muestra `Nessun messaggio disponibile`.

Para comprobar la separación de responsabilidades, enviar `{}` al gateway: HTTP devuelve `202`, pero el consumidor lo rechaza por los campos obligatorios ausentes y no lo elimina. Los fallos de persistencia o conflictos interrumpen el flujo antes de DeleteMessage. Si la eliminación falla después de guardar el evento, una entrega repetida puede reconocerse como `already_saved`. Puede recibirse un mensaje anterior; comparar los MessageId. El traslado efectivo a la DLQ y los fallos de persistencia/eliminación siguen pendientes de prueba.

Para probar otro evento, usar `examples/events/telemetry-second.json` en la petición curl del paso 3. El consumidor devuelve `inserted` si el ID es nuevo o `already_saved` si ya está guardado el contenido idéntico; en ambos casos solicita la eliminación del mensaje.

### 7. Detener el entorno

Interrumpir el gateway con `Ctrl+C` y ejecutar desde la raíz:

```bash
docker compose -f infra/docker-compose.yaml down
```

Se conservan los volúmenes de PostgreSQL y Redis. La persistencia de LocalStack está desactivada: no debe suponerse que los mensajes sobrevivan a los reinicios. El script de inicio vuelve a crear las colas.

## Verificaciones y aprendizajes

Desde el directorio del servicio Go:

```bash
go test -race ./...
go vet ./...
```

Se han verificado un envío HTTP real a LocalStack, el rechazo de JSON mal formado y una respuesta `503` al utilizar un endpoint SQS inaccesible. Las pruebas automáticas de Go sustituyen el cliente SQS. En TypeScript se han ejecutado comprobación de tipos, compilación, pruebas manuales del esquema y consumo de eventos válidos y no conformes. También se han comprobado la estructura y la conexión PostgreSQL. También se han verificado una nueva inserción y `already_saved` a través de SQS, ambos seguidos de confirmación DeleteMessage. El rechazo de conflictos sin sobrescritura se probó por separado del consumo. Quedan por probar un cuerpo JSON mal formado recibido desde SQS y el traslado efectivo a la DLQ; todavía no hay pruebas automatizadas del worker.

Los experimentos destacan tres diferencias:

- Aceptar un mensaje y procesarlo son operaciones separadas.
- Recibir un mensaje de SQS no lo elimina: el consumidor lo elimina solo después de confirmar la persistencia, incluyendo el reconocimiento de un evento idéntico guardado.
- Un JSON bien formado, los tipos TypeScript y los datos válidos para la aplicación requieren controles diferentes.

## Estructura del repositorio

```text
infra/                         Compose, inicialización SQS y primer script SQL
examples/events/               Evento JSON para probar el gateway
services/ingestion-gateway/    Gateway Go, configuración de ejemplo y pruebas
services/semantic-worker/      Esquema, consumo SQS y módulos PostgreSQL
```

## Próximos pasos

1. Verificar fallos de persistencia y eliminación, seguidos de una nueva entrega.
2. Probar conflictos a través de SQS, concurrencia y traslado efectivo a la DLQ.
3. Introducir consumo continuo y cierre controlado del worker.
4. Añadir pruebas del worker y comprobaciones automáticas antes de la demostración completa.

Las credenciales y los puertos publicados por Compose están destinados al desarrollo local. La propuesta inicial de `green_scale_architecture.md` incluye funcionalidades futuras; este README describe lo que está implementado.
