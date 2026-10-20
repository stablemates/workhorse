import psycopg

from workhorse import Admin, Queue, TaskListQuery


def inspect(database_url: str) -> None:
    with psycopg.connect(database_url) as connection:
        health = Queue(connection).health()
        print(health["status"])

        live = Admin(connection).list_tasks(
            TaskListQuery(
                states=("active", "scheduled"),
                limit=100,
            )
        )
        print(len(live.items))
