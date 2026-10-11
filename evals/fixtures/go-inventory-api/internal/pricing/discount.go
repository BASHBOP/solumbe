// Package pricing holds price rules.
package pricing

// ApplyDiscount takes 10% off a total, in cents, for ten or more units.
func ApplyDiscount(totalCents, quantity int) int {
	if quantity >= 10 {
		return totalCents * 90 / 100
	}
	return totalCents
}
