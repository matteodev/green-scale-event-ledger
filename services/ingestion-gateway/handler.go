package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// Un limite applicativo di 64 KiB evita di leggere corpi arbitrariamente grandi
// in memoria. Non è il limite massimo del servizio SQS.
const maxBodyBytes = 64 * 1024

// messageSender descrive solo l'operazione che serve all'handler.
// In Go un tipo soddisfa un'interfaccia se possiede i metodi richiesti:
// sia il client SQS sia il fake dei test espongono questa firma.
// I puntatori (*) permettono di passare le strutture senza copiarle interamente;
// ...func(*sqs.Options) indica zero o più funzioni opzionali di configurazione.
type messageSender interface {
	SendMessage(context.Context, *sqs.SendMessageInput, ...func(*sqs.Options)) (*sqs.SendMessageOutput, error)
}

// newHandler riceve le dipendenze dall'esterno: non crea il client SQS.
// Percorso di ogni richiesta: rotta → controlli HTTP/JSON → SendMessage → risposta.
func newHandler(client messageSender, queueURL string) http.Handler {
	// Il mux associa metodo e percorso alla funzione che gestirà la richiesta.
	mux := http.NewServeMux()
	// La funzione anonima viene registrata ora ed eseguita all'arrivo di POST /events.
	// r contiene la richiesta; w permette di scrivere la risposta al client.
	mux.HandleFunc("POST /events", func(w http.ResponseWriter, r *http.Request) {
		// ParseMediaType separa il tipo dagli eventuali parametri: accettiamo
		// anche application/json; charset=utf-8. _ ignora i parametri estratti.
		mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mediaType != "application/json" {
			// Scrivere l'errore non interrompe la funzione: serve anche return
			// per evitare che una richiesta rifiutata prosegua fino a SQS.
			http.Error(w, "Content-Type must be application/json", http.StatusUnsupportedMediaType)
			return
		}
		// Avvolgiamo il flusso con un limite prima di leggerlo. Il controllo
		// vale anche se il client non dichiara la dimensione del corpo.
		r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			var limit *http.MaxBytesError
			// errors.As distingue l'errore di dimensione dagli altri errori
			// di lettura: rispondiamo rispettivamente con 413 oppure 400.
			if errors.As(err, &limit) {
				http.Error(w, "body exceeds 64 KiB", http.StatusRequestEntityTooLarge)
			} else {
				http.Error(w, "cannot read body", http.StatusBadRequest)
			}
			return
		}
		// Verifichiamo che il corpo sia un unico oggetto JSON. RawMessage
		// conserva i valori come JSON senza imporre ancora tipi ai campi.
		// Unmarshal rifiuta anche più valori consecutivi, come {} {}.
		var object map[string]json.RawMessage
		// null non produce un errore di parsing, ma lascia la mappa nil:
		// lo escludiamo esplicitamente. {} invece è accettato a questo livello.
		if err := json.Unmarshal(body, &object); err != nil || object == nil {
			http.Error(w, "body must contain one JSON object", http.StatusBadRequest)
			return
		}

		// Qui termina la validazione del gateway: UUID, timestamp e altri
		// campi del contratto saranno verificati dal futuro worker.

		// Il contesto deriva dalla richiesta: una sua cancellazione si propaga
		// all'invio. La scadenza di 2 secondi limita anche i retry dell'SDK.
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		// Rilasciamo le risorse del contesto anche se l'invio termina prima.
		defer cancel()
		// Attendiamo l'esito dell'invio prima di rispondere. aws.String
		// converte una stringa in *string, come richiesto dai campi dell'SDK.
		// Usiamo il corpo originale, non una versione ricostruita dalla mappa.
		result, err := client.SendMessage(ctx, &sqs.SendMessageInput{
			QueueUrl: aws.String(queueURL), MessageBody: aws.String(string(body)),
		})
		if err != nil {
			// Non abbiamo conferma dell'accettazione: niente falso 202.
			// Un errore di rete non dimostra che il messaggio non sia arrivato:
			// il produttore deve mantenere eventId negli eventuali retry.
			slog.Error("SQS send failed", "error", err)
			http.Error(w, "queue unavailable; acceptance not confirmed", http.StatusServiceUnavailable)
			return
		}
		// Ordine importante: header → stato HTTP → corpo. Il 202 conferma
		// la presa in carico da SQS, non l'elaborazione o il salvataggio.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		// MessageId appartiene al trasporto SQS e non sostituisce eventId.
		// aws.ToString legge *string gestendo anche nil. Ignoriamo l'errore
		// di scrittura: a questo punto l'invio è avvenuto e lo stato è già scritto;
		// non possiamo annullarlo se il client si è disconnesso.
		_ = json.NewEncoder(w).Encode(map[string]string{"messageId": aws.ToString(result.MessageId)})
	})
	// Il mux soddisfa http.Handler; il server lo userà per smistare le richieste.
	return mux
}
