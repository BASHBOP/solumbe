import unittest

from app.orders.service import OrderService


class OrderServiceTest(unittest.TestCase):
    def test_cancel_order_marks_the_row_cancelled(self):
        service = OrderService()
        order = service.place_order("c1", [{"price": 10, "quantity": 2}])
        self.assertEqual(service.cancel_order(order["id"])["status"], "cancelled")
