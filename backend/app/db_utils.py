from typing import Any, Callable, Dict, List

PAGE_SIZE = 1000


def fetch_all(build_query: Callable[[], Any], page_size: int = PAGE_SIZE) -> List[Dict[str, Any]]:
    """Page through a PostgREST query until a short page is returned.

    `build_query` must return a fresh query each call — ranges are applied per page
    and Supabase query objects are not safely reusable across calls.
    """
    rows: List[Dict[str, Any]] = []
    offset = 0
    while True:
        page = build_query().range(offset, offset + page_size - 1).execute().data or []
        rows.extend(page)
        if len(page) < page_size:
            return rows
        offset += page_size
