"""Application entrypoint: wires the order routes onto the HTTP router."""

from app.orders.routes import register_order_routes


def create_app(router):
    register_order_routes(router)
    return router
