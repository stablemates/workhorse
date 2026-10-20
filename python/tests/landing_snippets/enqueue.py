import psycopg

from workhorse import Queue


def create_order(database_url: str, order_id: str, total: int) -> None:
    with psycopg.connect(database_url) as connection:
        connection.execute(
            "INSERT INTO orders (id, total) VALUES (%s, %s)",
            (order_id, total),
        )
        Queue(connection).enqueue("order.confirm", {"orderId": order_id})
