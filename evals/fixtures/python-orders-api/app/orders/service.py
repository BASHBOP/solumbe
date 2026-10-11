"""Order placement and cancellation."""

from app.billing.invoices import create_invoice
from app.orders.repository import OrderRepository
from app.shared.clock import utc_now


class OrderService:
    def __init__(self, repository=None):
        self.repository = repository or OrderRepository()

    def place_order(self, customer_id, lines):
        order = self.repository.save({"customer_id": customer_id, "lines": lines, "placed_at": utc_now()})
        create_invoice(order)
        return order

    def cancel_order(self, order_id):
        return self.repository.mark_cancelled(order_id, utc_now())
