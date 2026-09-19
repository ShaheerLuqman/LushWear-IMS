import asyncio
import logging
from typing import Awaitable, Callable, TypeVar

logger = logging.getLogger("app.retry")

T = TypeVar("T")

_ATTEMPTS = 3
_DELAY = 1.0


async def with_retry(attempt: Callable[[], Awaitable[T]], what: str) -> T:
    """Run `attempt` up to 3 times, 1s apart, re-raising the last failure. Any exception
    counts - a courier's transient 503 and a definitive rejection are retried alike."""
    for n in range(1, _ATTEMPTS + 1):
        try:
            return await attempt()
        except Exception as exc:
            if n == _ATTEMPTS:
                raise
            logger.warning("%s failed (attempt %d/%d), retrying in %ss: %s", what, n, _ATTEMPTS, _DELAY, exc)
            await asyncio.sleep(_DELAY)
