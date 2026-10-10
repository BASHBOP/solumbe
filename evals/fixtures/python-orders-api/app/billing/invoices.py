"""Invoice creation for placed orders."""

from .tax import compute_tax


def create_invoice(order):
    subtotal = sum(line["price"] * line["quantity"] for line in order["lines"])
    return {"order_id": order.get("id"), "subtotal": subtotal, "tax": compute_tax(subtotal)}
