import os

import psycopg

from workhorse.dashboard import DashboardHost, DashboardPrincipal

connection = psycopg.connect(os.environ["DATABASE_URL"], autocommit=True)

dashboard = DashboardHost(
    connection,
    path="/workhorse",
    authorize=lambda environ: (
        DashboardPrincipal(actor=str(environ["REMOTE_USER"]))
        if environ.get("REMOTE_USER")
        else False
    ),
)
