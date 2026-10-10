package stock

import "testing"

func TestReserveRejectsMoreThanOnHand(t *testing.T) {
	store := NewStore()
	_ = store.Adjust("sku-1", 2)
	if err := Reserve(store, "sku-1", 3); err != ErrInsufficientStock {
		t.Fatalf("got %v, want ErrInsufficientStock", err)
	}
}
