// Package platform holds helpers shared by every domain package.
package platform

import "time"

// WithBackoff runs fn up to attempts times, doubling the wait between tries.
func WithBackoff(attempts int, fn func() error) error {
	wait := 10 * time.Millisecond
	var err error
	for i := 0; i < attempts; i++ {
		if err = fn(); err == nil {
			return nil
		}
		time.Sleep(wait)
		wait *= 2
	}
	return err
}
