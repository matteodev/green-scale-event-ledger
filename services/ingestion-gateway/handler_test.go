package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// I file *_test.go vengono eseguiti da go test, non inclusi nell'eseguibile.
// fakeSender sostituisce SQS: registra le chiamate e può simulare un errore.
// Questi test non richiedono Docker e non verificano il collegamento reale a SQS.
type fakeSender struct {
	calls int
	body  string
	err   error
}

// La firma coincide con messageSender. Il receiver *fakeSender permette di
// modificare il fake originale. _ indica parametri richiesti ma qui non usati.
func (f *fakeSender) SendMessage(_ context.Context, input *sqs.SendMessageInput, _ ...func(*sqs.Options)) (*sqs.SendMessageOutput, error) {
	f.calls++
	f.body = aws.ToString(input.MessageBody)
	return &sqs.SendMessageOutput{MessageId: aws.String("test-message")}, f.err
}

// Un test guidato da una tabella: lo stesso percorso viene eseguito con input
// ed esiti attesi diversi. t fornisce gli strumenti di verifica del package testing.
func TestEvents(t *testing.T) {
	// Ogni riga definisce input, errore simulato, stato HTTP e numero di invii.
	// "demo" non è un UUID: il caso conferma che il gateway controlla il JSON,
	// mentre la validazione completa del contratto spetterà al worker.
	for _, tc := range []struct {
		name, body, contentType string
		sendErr                 error
		status, sends           int
	}{
		{"accepted", `{"eventId":"demo"}`, "application/json", nil, 202, 1},
		{"queue failure", `{}`, "application/json", errors.New("offline"), 503, 1},
		{"malformed", `{"eventId":`, "application/json", nil, 400, 0},
		{"array", `[]`, "application/json", nil, 400, 0},
		{"null", `null`, "application/json", nil, 400, 0},
		{"multiple values", `{} {}`, "application/json", nil, 400, 0},
		{"wrong media type", `{}`, "text/plain", nil, 415, 0},
		{"too large", `{"data":"` + strings.Repeat("x", maxBodyBytes) + `"}`, "application/json", nil, 413, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Ogni sottotest ha un fake nuovo, senza stato dei casi precedenti.
			sender := &fakeSender{err: tc.sendErr}
			// Costruiamo richiesta e risposta in memoria, senza aprire una porta.
			req := httptest.NewRequest(http.MethodPost, "/events", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", tc.contentType)
			res := httptest.NewRecorder()
			// Eseguiamo lo stesso handler usato dal server reale, in modo diretto.
			newHandler(sender, "test-queue").ServeHTTP(res, req)
			// Controlliamo sia la risposta sia l'effetto: gli input rifiutati
			// devono produrre zero chiamate a SQS; un errore SQS deve dare 503.
			if res.Code != tc.status || sender.calls != tc.sends {
				t.Fatalf("status=%d sends=%d; want status=%d sends=%d", res.Code, sender.calls, tc.status, tc.sends)
			}
			// Quando inviamo, il contenuto deve rimanere quello del produttore.
			if tc.sends > 0 && sender.body != tc.body {
				t.Fatal("event body changed before send")
			}
		})
	}
}
