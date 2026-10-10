"""Sales tax calculation."""

STANDARD_RATE = 0.2


def compute_tax(subtotal, rate=STANDARD_RATE):
    return round(subtotal * rate, 2)
