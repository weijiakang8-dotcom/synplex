from __future__ import annotations

import threading
import time


class CircuitBreaker:
    def __init__(
        self, failure_threshold: int = 5, window: int = 10, cooldown: int = 30
    ):
        self.failure_threshold = failure_threshold
        self.window = window
        self.cooldown = cooldown
        self.state = "CLOSED"
        self.failures: list[float] = []
        self.last_open_time = 0.0
        self._lock = threading.Lock()

    def allow(self) -> bool:
        with self._lock:
            now = time.time()
            if self.state == "OPEN" and now - self.last_open_time >= self.cooldown:
                self.state = "HALF_OPEN"
            return self.state != "OPEN"

    def record_success(self) -> None:
        with self._lock:
            self.state = "CLOSED"
            self.failures.clear()

    def record_failure(self) -> None:
        with self._lock:
            now = time.time()
            self.failures = [t for t in self.failures if now - t <= self.window]
            self.failures.append(now)
            if (
                self.state == "HALF_OPEN"
                or len(self.failures) >= self.failure_threshold
            ):
                self.state = "OPEN"
                self.last_open_time = now


llm_breaker = CircuitBreaker()
