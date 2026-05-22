"""
heartbeat_monitor.py - Agent Heartbeat Detection Module (Python Prototype)

Translated 1:1 from TypeScript prototype in src/heartbeat/.

Design principles preserved from TS source:
  - Agent liveness is defined by externally observable behavior, not internal state.
  - The environment owns the action log; agents cannot forge entries.
  - Only actions producing externally observable side effects count as "change";
    pure internal computation is NOT evidence of life.
  - Death detection: consecutive N no-change checks => Dead (N configurable, default 3).
  - Born event: first check validates presence of born log entry; no born => immediate death.
  - Once Dead, no further checks are performed (monitor stops itself).

Constraints:
  - No external dependencies (stdlib only)
  - No print output with Chinese/emoji
  - death_threshold is configurable, never hardcoded
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Dict, List, Optional


# ---------------------------------------------------------------------------
# Constants (translated from types.ts / monitor.ts)
# ---------------------------------------------------------------------------

BORN_OPERATION_TYPE: str = "born"

DEFAULT_CHECK_INTERVAL_MS: int = 5000
DEFAULT_DEATH_THRESHOLD: int = 3


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _now_ms() -> int:
    """Return current time as Unix milliseconds (mirrors TS Date.now())."""
    import time
    return int(time.time() * 1000)


# ---------------------------------------------------------------------------
# Data types (translated 1:1 from types.ts)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ActionLogEntry:
    """A single action log entry.

    Attributes:
        timestamp: Unix milliseconds timestamp.
        operation_type: e.g. "born", "file_write", "api_call", "message_send".
        impact_scope: e.g. "workspace:abc/file:main.ts".
    """
    timestamp: int
    operation_type: str
    impact_scope: str


@dataclass(frozen=True)
class BornLogEntry(ActionLogEntry):
    """A born-type log entry. operation_type is always 'born'."""
    def __init__(self, timestamp: int, impact_scope: str):
        super().__init__(
            timestamp=timestamp,
            operation_type=BORN_OPERATION_TYPE,
            impact_scope=impact_scope,
        )


def is_born_entry(entry: ActionLogEntry) -> bool:
    """Type guard: check if an entry is a born entry.

    Translated from TS: isBornEntry(entry: ActionLogEntry): entry is BornLogEntry
    """
    return entry.operation_type == BORN_OPERATION_TYPE


@dataclass(frozen=True)
class AgentSnapshot:
    """Snapshot of an agent's current observable state.

    Attributes:
        agent_id: Identifier of the monitored agent.
        log_entries: List of action log entries sorted by timestamp ascending.
        captured_at: Unix milliseconds when snapshot was taken.
    """
    agent_id: str
    log_entries: List[ActionLogEntry]
    captured_at: int


@dataclass
class HeartbeatConfig:
    """Configuration for heartbeat monitoring.

    Attributes:
        check_interval_ms: Check interval in milliseconds (default 5000).
        death_threshold: Consecutive no-change checks before declaring dead (default 3).
        agent_id: Identifier of the monitored agent.
    """
    check_interval_ms: Optional[int] = None
    death_threshold: Optional[int] = None
    agent_id: str = ""


@dataclass(frozen=True)
class ResolvedHeartbeatConfig:
    """Fully resolved heartbeat config with all defaults applied."""
    check_interval_ms: int
    death_threshold: int
    agent_id: str


class HeartbeatStatus(Enum):
    """Agent heartbeat status.

    Translated from TS: enum HeartbeatStatus
    """
    WAITING_FOR_BORN = "waiting_for_born"
    ALIVE = "alive"
    DEAD = "dead"


@dataclass(frozen=True)
class HeartbeatCheckResult:
    """Result of a single heartbeat check.

    Attributes:
        checked_at: Unix milliseconds when the check was performed.
        status: Current heartbeat status.
        no_change_count: Current consecutive no-change count.
        log_entry_count: Total log entries at the time of check.
        has_change: Whether there was a change since the last check.
    """
    checked_at: int
    status: HeartbeatStatus
    no_change_count: int
    log_entry_count: int
    has_change: bool


# Callback type aliases (translated from TS DeathCallback / AliveCallback)
DeathCallback = Callable[[str, HeartbeatCheckResult], None]
AliveCallback = Callable[[str, HeartbeatCheckResult], None]


# ---------------------------------------------------------------------------
# Interfaces (translated 1:1 from types.ts)
# ---------------------------------------------------------------------------

class IActionLogStore(ABC):
    """Interface for action log persistence.

    Translated from TS: interface IActionLogStore
    """

    @abstractmethod
    def append(self, agent_id: str, entry: ActionLogEntry) -> None:
        """Append an action log entry for the given agent."""

    @abstractmethod
    def read(self, agent_id: str) -> List[ActionLogEntry]:
        """Read all action log entries for the given agent."""

    @abstractmethod
    def count(self, agent_id: str) -> int:
        """Return the number of log entries for the given agent."""

    @abstractmethod
    def clear(self, agent_id: str) -> None:
        """Clear all log entries for the given agent."""


class ISnapshotProvider(ABC):
    """Interface for capturing agent snapshots.

    Translated from TS: interface ISnapshotProvider
    """

    @abstractmethod
    def capture(self, agent_id: str) -> AgentSnapshot:
        """Capture a snapshot of the agent's current observable state."""


class IHeartbeatMonitor(ABC):
    """Interface for heartbeat monitoring.

    Translated from TS: interface IHeartbeatMonitor
    """

    @abstractmethod
    def start(self) -> None:
        """Start periodic heartbeat checks."""

    @abstractmethod
    def stop(self) -> None:
        """Stop periodic heartbeat checks."""

    @abstractmethod
    def on_death(self, callback: DeathCallback) -> None:
        """Register a death callback."""

    @abstractmethod
    def on_alive(self, callback: AliveCallback) -> None:
        """Register an alive callback."""

    @abstractmethod
    def get_status(self) -> HeartbeatStatus:
        """Return current heartbeat status."""

    @abstractmethod
    def get_no_change_count(self) -> int:
        """Return current consecutive no-change count."""


# ---------------------------------------------------------------------------
# InMemoryActionLogStore (translated 1:1 from action-log.ts)
# ---------------------------------------------------------------------------

class InMemoryActionLogStore(IActionLogStore):
    """In-memory implementation of IActionLogStore.

    All log data stored in Dict[str, List[ActionLogEntry]].
    Production environment can replace with persistent storage.
    """

    def __init__(self) -> None:
        self._logs: Dict[str, List[ActionLogEntry]] = {}

    def append(self, agent_id: str, entry: ActionLogEntry) -> None:
        """Append a log entry. Maintains ascending timestamp sort order."""
        if agent_id not in self._logs:
            self._logs[agent_id] = []
        self._logs[agent_id].append(entry)
        # Keep sorted by timestamp ascending (mirrors TS .sort((a, b) => a.timestamp - b.timestamp))
        self._logs[agent_id].sort(key=lambda e: e.timestamp)

    def read(self, agent_id: str) -> List[ActionLogEntry]:
        """Read all entries for the given agent (returns a copy)."""
        return list(self._logs.get(agent_id, []))

    def count(self, agent_id: str) -> int:
        """Return the number of log entries for the given agent."""
        return len(self._logs.get(agent_id, []))

    def clear(self, agent_id: str) -> None:
        """Clear all log entries for the given agent."""
        self._logs.pop(agent_id, None)

    def get_agent_ids(self) -> List[str]:
        """Return all registered agent IDs (test helper).

        Not part of IActionLogStore interface; mirrors TS getAgentIds().
        """
        return list(self._logs.keys())


# ---------------------------------------------------------------------------
# LogStoreSnapshotProvider (translated 1:1 from snapshot-provider.ts)
# ---------------------------------------------------------------------------

class LogStoreSnapshotProvider(ISnapshotProvider):
    """Snapshot provider backed by an IActionLogStore.

    Translated from TS: class LogStoreSnapshotProvider implements ISnapshotProvider

    On capture:
    1. Read all logs for the agent from logStore
    2. Build AgentSnapshot with current timestamp
    """

    def __init__(self, log_store: IActionLogStore) -> None:
        self._log_store = log_store

    def capture(self, agent_id: str) -> AgentSnapshot:
        log_entries = self._log_store.read(agent_id)
        return AgentSnapshot(
            agent_id=agent_id,
            log_entries=log_entries,
            captured_at=_now_ms(),
        )


# ---------------------------------------------------------------------------
# resolveConfig (translated 1:1 from monitor.ts)
# ---------------------------------------------------------------------------

def resolve_config(config: HeartbeatConfig) -> ResolvedHeartbeatConfig:
    """Resolve a HeartbeatConfig by applying defaults.

    Translated from TS: function resolveConfig(config: HeartbeatConfig): ResolvedHeartbeatConfig
    """
    return ResolvedHeartbeatConfig(
        check_interval_ms=config.check_interval_ms if config.check_interval_ms is not None else DEFAULT_CHECK_INTERVAL_MS,
        death_threshold=config.death_threshold if config.death_threshold is not None else DEFAULT_DEATH_THRESHOLD,
        agent_id=config.agent_id,
    )


# ---------------------------------------------------------------------------
# HeartbeatMonitor (translated 1:1 from monitor.ts)
# ---------------------------------------------------------------------------

class HeartbeatMonitor(IHeartbeatMonitor):
    """Core heartbeat monitor that detects agent death.

    Translated from TS: class HeartbeatMonitor implements IHeartbeatMonitor

    Decision flow:
    1. First check: look for born log entry -> no born -> immediate death
    2. Subsequent checks: compare log entry count with last snapshot
       - Has change (count increased) -> alive, reset counter
       - No change -> increment noChangeCount
       - noChangeCount >= deathThreshold -> dead
    3. Once dead, no further checks are performed
    """

    def __init__(
        self,
        config: HeartbeatConfig,
        log_store: IActionLogStore,
        snapshot_provider: ISnapshotProvider,
    ) -> None:
        self._config: ResolvedHeartbeatConfig = resolve_config(config)
        self._log_store: IActionLogStore = log_store
        self._snapshot_provider: ISnapshotProvider = snapshot_provider

        # Internal state (mirrors TS private fields)
        self._status: HeartbeatStatus = HeartbeatStatus.WAITING_FOR_BORN
        self._no_change_count: int = 0
        self._last_log_entry_count: int = 0
        self._death_callbacks: List[DeathCallback] = []
        self._alive_callbacks: List[AliveCallback] = []
        self._born_confirmed: bool = False
        self._is_first_check: bool = True

    # -- Properties (test helpers, mirrors TS public getters) --

    @property
    def status(self) -> HeartbeatStatus:
        return self._status

    @property
    def no_change_count(self) -> int:
        return self._no_change_count

    @property
    def config(self) -> ResolvedHeartbeatConfig:
        return self._config

    @property
    def born_confirmed(self) -> bool:
        return self._born_confirmed

    # -- IHeartbeatMonitor implementation --

    def start(self) -> None:
        """Start monitoring.

        In this synchronous Python prototype, perform one immediate check.
        The caller is responsible for calling perform_check() at the desired
        interval. (TS uses setInterval; here we perform a single tick.)
        """
        self.perform_check()

    def stop(self) -> None:
        """Stop monitoring.

        No-op in synchronous prototype; kept for interface parity with TS.
        """
        pass

    def on_death(self, callback: DeathCallback) -> None:
        """Register a death callback. Mirrors TS onDeath()."""
        self._death_callbacks.append(callback)

    def on_alive(self, callback: AliveCallback) -> None:
        """Register an alive callback. Mirrors TS onAlive()."""
        self._alive_callbacks.append(callback)

    def get_status(self) -> HeartbeatStatus:
        """Return current heartbeat status. Mirrors TS getStatus()."""
        return self._status

    def get_no_change_count(self) -> int:
        """Return current consecutive no-change count. Mirrors TS getNoChangeCount()."""
        return self._no_change_count

    # -- Core check logic --

    def perform_check(self) -> Optional[HeartbeatCheckResult]:
        """Perform a single heartbeat check.

        Translated from TS: private async performCheck(): Promise<void>

        Returns the check result, or None if the agent is already dead
        (no further checks after death).
        """
        # If already dead, do nothing
        if self._status == HeartbeatStatus.DEAD:
            return None

        # Capture snapshot
        snapshot = self._snapshot_provider.capture(self._config.agent_id)
        log_entries = snapshot.log_entries

        # First check: validate born event
        if self._is_first_check:
            self._is_first_check = False
            has_born = any(is_born_entry(e) for e in log_entries)

            if not has_born:
                # No born event -> immediate death
                self._status = HeartbeatStatus.DEAD
                self._born_confirmed = False
                self._no_change_count = self._config.death_threshold

                result = self._build_check_result(snapshot, False)
                self._fire_death(result)
                self.stop()
                return result

            # Born event confirmed
            self._born_confirmed = True
            self._status = HeartbeatStatus.ALIVE
            self._last_log_entry_count = len(log_entries)
            self._no_change_count = 0

            result = self._build_check_result(snapshot, True)
            self._fire_alive(result)
            return result

        # Subsequent checks: compare log entry count
        current_count = len(log_entries)
        has_change = current_count > self._last_log_entry_count

        if has_change:
            # Has new entries -> alive, reset counter
            self._no_change_count = 0
            self._status = HeartbeatStatus.ALIVE
            self._last_log_entry_count = current_count

            result = self._build_check_result(snapshot, True)
            self._fire_alive(result)
        else:
            # No change -> increment counter
            self._no_change_count += 1

            if self._no_change_count >= self._config.death_threshold:
                # Consecutive N no-change -> dead
                self._status = HeartbeatStatus.DEAD

                result = self._build_check_result(snapshot, False)
                self._fire_death(result)
                self.stop()
            else:
                # Not yet at threshold, keep waiting
                result = self._build_check_result(snapshot, False)
                self._fire_alive(result)

        return result

    # -- Private helpers --

    def _build_check_result(
        self,
        snapshot: AgentSnapshot,
        has_change: bool,
    ) -> HeartbeatCheckResult:
        """Build a HeartbeatCheckResult object.

        Translated from TS: private buildCheckResult(snapshot, hasChange): HeartbeatCheckResult
        """
        return HeartbeatCheckResult(
            checked_at=snapshot.captured_at,
            status=self._status,
            no_change_count=self._no_change_count,
            log_entry_count=len(snapshot.log_entries),
            has_change=has_change,
        )

    def _fire_death(self, result: HeartbeatCheckResult) -> None:
        """Trigger all death callbacks.

        Translated from TS: private fireDeath(result): void
        """
        for cb in self._death_callbacks:
            cb(self._config.agent_id, result)

    def _fire_alive(self, result: HeartbeatCheckResult) -> None:
        """Trigger all alive callbacks.

        Translated from TS: private fireAlive(result): void
        """
        for cb in self._alive_callbacks:
            cb(self._config.agent_id, result)

    # -- Test helper methods (mirrors TS tick() / reset()) --

    def tick(self) -> Optional[HeartbeatCheckResult]:
        """Manually trigger one check (for testing, skip timer).

        Translated from TS: async tick(): Promise<void>
        """
        return self.perform_check()

    def reset(self) -> None:
        """Reset internal state to initial (for testing).

        Translated from TS: reset(): void
        """
        self.stop()
        self._status = HeartbeatStatus.WAITING_FOR_BORN
        self._no_change_count = 0
        self._last_log_entry_count = 0
        self._born_confirmed = False
        self._is_first_check = True
        self._death_callbacks = []
        self._alive_callbacks = []


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Agent-side helpers (translated 1:1 from agent-behavior-log.ts)
# ---------------------------------------------------------------------------

def write_born_event(
    log_store: IActionLogStore,
    agent_id: str,
    impact_scope: str,
) -> None:
    """Write a born event to the action log.

    Translated from TS: async function writeBornEvent(logStore, agentId, impactScope)

    Args:
        log_store: The action log store to write to.
        agent_id: The agent identifier.
        impact_scope: Description of the impact scope.
    """
    entry = ActionLogEntry(
        timestamp=_now_ms(),
        operation_type=BORN_OPERATION_TYPE,
        impact_scope=impact_scope,
    )
    log_store.append(agent_id, entry)


def write_action_event(
    log_store: IActionLogStore,
    agent_id: str,
    operation_type: str,
    impact_scope: str,
) -> None:
    """Write an action event to the action log.

    Translated from TS: async function writeActionEvent(logStore, agentId, operationType, impactScope)

    Safety guard: refuses to write if operation_type is 'born' (use write_born_event instead).

    Args:
        log_store: The action log store to write to.
        agent_id: The agent identifier.
        operation_type: The operation type (must NOT be 'born').
        impact_scope: Description of the impact scope.

    Raises:
        ValueError: If operation_type is 'born'.
    """
    if operation_type == BORN_OPERATION_TYPE:
        raise ValueError(
            "Cannot write 'born' event via write_action_event; use write_born_event instead"
        )
    entry = ActionLogEntry(
        timestamp=_now_ms(),
        operation_type=operation_type,
        impact_scope=impact_scope,
    )
    log_store.append(agent_id, entry)


def tool_name_to_operation_type(tool_name: str) -> str:
    """Map a tool name to its operation type.

    Translated from TS: function toolNameToOperationType(toolName: string): string

    Default fallback: if tool_name is not in the mapping, returns the tool_name as-is.

    Args:
        tool_name: The name of the tool.

    Returns:
        The corresponding operation type string.
    """
    _TOOL_MAP: Dict[str, str] = {
        "reply_to_user": "message_send",
        "set_goal": "goal_set",
        "start_self_update": "self_update_start",
        "list_inner_brains": "status_read",
        "stop_inner_brain": "brain_stop",
        "send_directive": "directive_send",
        "get_time": "time_read",
        "search_thread": "thread_search",
        "read_file": "file_read",
        "write_file": "file_write",
        "shell_exec": "shell_exec",
        "web_search": "web_search",
    }
    return _TOOL_MAP.get(tool_name, tool_name)


# ---------------------------------------------------------------------------
# Convenience helper: create_monitor
# ---------------------------------------------------------------------------

def create_monitor(
    agent_id: str,
    death_threshold: Optional[int] = None,
    check_interval_ms: Optional[int] = None,
    log_store: Optional[IActionLogStore] = None,
) -> HeartbeatMonitor:
    """Create a HeartbeatMonitor with default in-memory store and snapshot provider.

    Args:
        agent_id: The agent to monitor.
        death_threshold: Consecutive no-change checks before death (default 3).
        check_interval_ms: Check interval in ms (default 5000).
        log_store: Optional custom log store; defaults to InMemoryActionLogStore.

    Returns:
        A configured HeartbeatMonitor instance.
    """
    store = log_store if log_store is not None else InMemoryActionLogStore()
    snapshot_provider = LogStoreSnapshotProvider(store)
    config = HeartbeatConfig(
        agent_id=agent_id,
        death_threshold=death_threshold,
        check_interval_ms=check_interval_ms,
    )
    return HeartbeatMonitor(config, store, snapshot_provider)
