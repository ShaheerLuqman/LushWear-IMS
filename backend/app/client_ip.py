from fastapi import Request


def get_client_ip(request: Request) -> str:
    """Client identity for the PIN lockout and the rate limiter.

    Trusts exactly one proxy hop - Northflank's ingress, the only way to reach
    this container. When present, X-Forwarded-For's rightmost entry is what
    that proxy itself observed as the TCP peer, appended after anything a
    client tried to fake further left in the header (the standard "N trusted
    hops -> Nth-from-right" rule for a single known proxy). Reading the
    leftmost entry instead - or request.client.host directly - would either be
    spoofable or collapse every client behind the proxy into one shared bucket.
    Falls back to the raw socket peer for local/direct connections, where
    there's no proxy to have set the header.
    """
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        candidate = forwarded.split(",")[-1].strip()
        if candidate:
            return candidate
    return (request.client.host if request.client else None) or "unknown"
