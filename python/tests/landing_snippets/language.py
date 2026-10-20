import psycopg

from workhorse import Queue


def enqueue_welcome(database_url: str) -> None:
    with psycopg.connect(database_url) as connection:
        Queue(connection).enqueue(
            "email.welcome",
            {"to": "ada@example.com"},
        )
