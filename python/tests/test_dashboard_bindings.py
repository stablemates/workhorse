from __future__ import annotations

import pytest

from workhorse.dashboard_v1 import (
    DashboardInputValidationError,
    validate_event_detail_input,
    validate_meta_input,
)


def test_generated_input_validator_accepts_valid_input() -> None:
    validate_event_detail_input({"id": "event:018f0000-0000-7000-8000-000000000042"})


def test_generated_input_validator_rejects_schema_violation() -> None:
    with pytest.raises(DashboardInputValidationError, match="does not match"):
        validate_event_detail_input({"id": "42"})


def test_generated_input_validator_rejects_input_for_empty_procedure() -> None:
    with pytest.raises(DashboardInputValidationError, match="does not accept input"):
        validate_meta_input({})
