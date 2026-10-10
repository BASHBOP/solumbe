package stock

import "errors"

// ErrInsufficientStock is returned when a reservation asks for more than is on hand.
var ErrInsufficientStock = errors.New("insufficient stock")

// Reserve holds quantity units of a SKU for an order.
func Reserve(store *Store, sku string, quantity int) error {
	if store.Available(sku) < quantity {
		return ErrInsufficientStock
	}
	return store.Adjust(sku, -quantity)
}

// Release returns previously reserved units to the store.
func Release(store *Store, sku string, quantity int) error {
	return store.Adjust(sku, quantity)
}
