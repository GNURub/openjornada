package laborcalendar

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestClientFiltersInvalidSpanishProvinceAndCachesCatalog(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{
          "provinces": [
            {"code":"04","slug":"almeria","name":"Almería"},
            {"code":"AD","slug":"andorra","name":"Andorra"}
          ]
        }`)
	}))
	defer server.Close()

	client, err := NewClient(server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		items, err := client.Provinces(context.Background(), 2026, "and")
		if err != nil {
			t.Fatal(err)
		}
		if len(items) != 1 || items[0].Slug != "almeria" {
			t.Fatalf("unexpected filtered provinces: %#v", items)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("provider calls = %d, want 1 cached call", calls.Load())
	}
}

func TestClientRejectsUnsafeLocationBeforeRequest(t *testing.T) {
	client, err := NewClient("https://example.com", http.DefaultClient)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Provinces(context.Background(), 2026, "../madrid"); err == nil {
		t.Fatal("expected unsafe slug to be rejected")
	}
}

func TestClientValidatesAndSortsMunicipalCalendar(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{
          "year": 2026,
          "generatedAt": "2025-10-28T00:00:00Z",
          "confidence": "verified",
          "region": {"code":"MAD","slug":"mad","name":"Comunidad de Madrid"},
          "province": {"code":"28","slug":"madrid","name":"Madrid"},
          "municipality": {"ine":"28079","slug":"madrid","name":"Madrid"},
          "holidays": {"calendar": [
            {"date":"2026-05-02","name":"Fiesta local","scope":"local","source":"BOCM","sourceUrl":"https://www.bocm.es/"},
            {"date":"2026-01-01","name":"Año Nuevo","scope":"nacional","source":"BOE","sourceUrl":"https://www.boe.es/"}
          ]},
          "warnings": [],
          "disclaimer": "Consulta las fuentes oficiales."
        }`)
	}))
	defer server.Close()

	client, err := NewClient(server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	calendar, err := client.Calendar(context.Background(), 2026, "mad", "madrid", "madrid")
	if err != nil {
		t.Fatal(err)
	}
	if got := calendar.Holidays.Calendar[0].Date; got != "2026-01-01" {
		t.Fatalf("first holiday = %q, want sorted date", got)
	}
}

func TestClientRejectsCalendarForAnotherYear(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{
          "year": 2026,
          "holidays": {"calendar": [
            {"date":"2027-01-01","name":"Año Nuevo","scope":"nacional","source":"BOE","sourceUrl":"https://www.boe.es/"}
          ]}
        }`)
	}))
	defer server.Close()
	client, err := NewClient(server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Calendar(context.Background(), 2026, "mad", "madrid", "madrid"); err == nil {
		t.Fatal("expected invalid holiday year to be rejected")
	}
}
