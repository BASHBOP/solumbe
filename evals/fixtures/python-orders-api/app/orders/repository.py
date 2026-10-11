"""In-memory persistence for orders."""


class OrderRepository:
    def __init__(self):
        self._rows = {}

    def save(self, order):
        order_id = len(self._rows) + 1
        self._rows[order_id] = {**order, "id": order_id, "status": "placed"}
        return self._rows[order_id]

    def find(self, order_id):
        return self._rows.get(order_id)

    def mark_cancelled(self, order_id, cancelled_at):
        row = self._rows[order_id]
        row.update(status="cancelled", cancelled_at=cancelled_at)
        return row
