// Package stock tracks how many units of each SKU are on hand.
package stock

import (
	"sync"

	"example.com/inventory/internal/platform"
)

// Store is the on-hand quantity per SKU.
type Store struct {
	mu     sync.Mutex
	onHand map[string]int
}

// NewStore returns an empty store.
func NewStore() *Store {
	return &Store{onHand: map[string]int{}}
}

// Adjust changes the on-hand quantity, retrying when the write is contended.
func (s *Store) Adjust(sku string, delta int) error {
	return platform.WithBackoff(3, func() error {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.onHand[sku] += delta
		return nil
	})
}

// Available reports the on-hand quantity for a SKU.
func (s *Store) Available(sku string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.onHand[sku]
}
