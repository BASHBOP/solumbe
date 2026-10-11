// Command server starts the inventory HTTP API.
package main

import (
	"net/http"

	"example.com/inventory/internal/httpapi"
	"example.com/inventory/internal/stock"
)

func main() {
	store := stock.NewStore()
	_ = http.ListenAndServe(":8080", httpapi.NewHandler(store))
}
