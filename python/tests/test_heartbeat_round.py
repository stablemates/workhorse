from __future__ import annotations

from workhorse._heartbeat_round import heartbeat_round_bound_ms


def test_a_round_bound_is_three_quarters_of_the_interval_and_the_interval_up_to_50_ms() -> None:
    assert heartbeat_round_bound_ms(10) == 10
    assert heartbeat_round_bound_ms(40) == 40
    assert heartbeat_round_bound_ms(50) == 50
    assert heartbeat_round_bound_ms(66) == 50
    assert heartbeat_round_bound_ms(69) == 51
    assert heartbeat_round_bound_ms(200) == 150
    assert heartbeat_round_bound_ms(10_000) == 7_500


def test_one_timed_out_round_leaves_a_renewal_margin_with_the_defaults() -> None:
    lease_ms = 30_000
    heartbeat_ms = lease_ms // 3
    assert 2 * heartbeat_ms + heartbeat_round_bound_ms(heartbeat_ms) < lease_ms
