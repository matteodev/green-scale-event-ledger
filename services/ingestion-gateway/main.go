// I file main.go e handler.go appartengono allo stesso programma (package main).
// Percorso di avvio: main → run → creazione del client SQS → creazione del
// server HTTP → attesa delle richieste gestite dalle rotte in handler.go.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// run prepara le dipendenze e gestisce la vita del server. Restituire gli errori
// a main ci permette di tenere in un solo punto la decisione di uscire.
func run() error {
	// L'URL indica la coda di destinazione. Leggiamo la configurazione
	// dall'ambiente: questo codice non carica automaticamente un file .env.
	queueURL := os.Getenv("SQS_QUEUE_URL")
	if queueURL == "" {
		return errors.New("SQS_QUEUE_URL is required")
	}
	// Un context trasporta un segnale di cancellazione e, quando presente,
	// una scadenza. Qui viene cancellato su Ctrl+C (SIGINT) o SIGTERM.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	// defer esegue la chiamata quando run termina: libera la registrazione
	// dei segnali anche se usciamo prima a causa di un errore.
	defer stop()
	// L'SDK cerca regione e credenziali nelle sue fonti standard, incluse
	// le variabili AWS_REGION, AWS_ACCESS_KEY_ID e AWS_SECRET_ACCESS_KEY.
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return err
	}
	// Creiamo un solo client e lo riutilizziamo tra le richieste HTTP.
	// Crearlo non invia messaggi e non verifica che la coda esista.
	client := sqs.NewFromConfig(cfg, func(o *sqs.Options) {
		// BaseEndpoint indirizza le chiamate verso LocalStack, se configurato.
		// È l'indirizzo del servizio; queueURL identifica invece la coda.
		if endpoint := os.Getenv("SQS_ENDPOINT"); endpoint != "" {
			o.BaseEndpoint = aws.String(endpoint)
		}
	})
	addr := os.Getenv("HTTP_ADDR")
	if addr == "" {
		// Il valore predefinito espone il server solo sul computer locale.
		addr = "127.0.0.1:8080"
	}
	// newHandler registra le rotte; non elabora ancora nessuna richiesta.
	// I timeout limitano rispettivamente lettura degli header, lettura della
	// richiesta, scrittura della risposta e attesa su connessioni inattive.
	server := &http.Server{
		Addr: addr, Handler: newHandler(client, queueURL),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
		WriteTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second,
	}
	// Il canale permette al server di comunicare il proprio errore a run.
	// Il buffer di un elemento evita di bloccare l'invio durante lo shutdown.
	serverErrors := make(chan error, 1)
	// ListenAndServe resta in attesa di richieste. Lo avviamo in una goroutine
	// (esecuzione concorrente) per poter attendere anche i segnali di arresto.
	go func() { serverErrors <- server.ListenAndServe() }()
	// select attende che uno dei due canali sia pronto.
	select {
	case err := <-serverErrors:
		// Per esempio: la porta è già occupata e il server non può partire.
		return err
	case <-ctx.Done():
		slog.Info("shutting down gateway")
		// Il contesto dei segnali è già cancellato: ne creiamo uno indipendente
		// per concedere fino a 10 secondi alle richieste attive per terminare.
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		// Shutdown smette di accettare connessioni e attende quelle attive.
		if err := server.Shutdown(shutdownCtx); err != nil {
			// Se l'attesa fallisce, chiudiamo anche le connessioni rimaste.
			_ = server.Close()
			return err
		}
		return nil
	}
}

// main è il punto d'ingresso dell'eseguibile Go.
func main() {
	if err := run(); err != nil {
		slog.Error("gateway stopped", "error", err)
		// Un codice diverso da zero segnala il fallimento alla shell.
		os.Exit(1)
	}
}
