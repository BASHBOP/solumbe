"""HTTP routes for orders."""

from .service import OrderService


def register_order_routes(router):
    service = OrderService()
    router.add("POST", "/orders", service.place_order)
    router.add("DELETE", "/orders/{order_id}", service.cancel_order)
