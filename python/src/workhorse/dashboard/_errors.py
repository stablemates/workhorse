from __future__ import annotations


class DashboardRPCError(Exception):
    def __init__(self, status: int, code: str, message: str, data: object | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.data = data
