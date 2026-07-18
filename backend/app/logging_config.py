import logging
import os


def configure_logging() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    # httpx logs every outbound request at INFO, including the full URL with query
    # params (table names, filter values). A single sync makes thousands of calls,
    # so it both floods the log and over-shares. Warnings/errors still surface.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
