// Package httpapi exposes stock reservations over HTTP.
package httpapi

import (
	"net/http"
	"strconv"

	"example.com/inventory/internal/pricing"
	"example.com/inventory/internal/stock"
)

// NewHandler routes reservation requests to the stock package.
func NewHandler(store *stock.Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /reservations", func(w http.ResponseWriter, r *http.Request) {
		quantity, _ := strconv.Atoi(r.URL.Query().Get("quantity"))
		if err := stock.Reserve(store, r.URL.Query().Get("sku"), quantity); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		_, _ = w.Write([]byte(strconv.Itoa(pricing.ApplyDiscount(quantity*100, quantity))))
	})
	return mux
}
