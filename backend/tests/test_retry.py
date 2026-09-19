import asyncio

import pytest

from app.retry import with_retry


def test_succeeds_on_a_later_attempt_without_surfacing_earlier_failures():
    calls = []

    async def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise RuntimeError("busy")
        return "ok"

    assert asyncio.run(with_retry(flaky, "flaky")) == "ok"
    assert len(calls) == 3


def test_gives_up_after_three_attempts_and_reraises_the_last_error():
    calls = []

    async def always_fails():
        calls.append(1)
        raise RuntimeError(f"attempt {len(calls)}")

    with pytest.raises(RuntimeError, match="attempt 3"):
        asyncio.run(with_retry(always_fails, "doomed"))
    assert len(calls) == 3
