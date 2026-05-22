"""
test_heartbeat_monitor.py - pytest tests for heartbeat_monitor.py

Test structure mirrors the TS module architecture:
  - TestConstants: module-level constants
  - TestActionLogEntry / TestBornLogEntry / TestIsBornEntry: data types
  - TestHeartbeatStatus: enum
  - TestHeartbeatCheckResult: check result dataclass
  - TestInMemoryActionLogStore: action-log store
  - TestLogStoreSnapshotProvider: snapshot provider
  - TestResolveConfig: config resolution
  - TestHeartbeatMonitorBornChecks: born event validation
  - TestHeartbeatMonitorAliveChecks: alive check behavior
  - TestHeartbeatMonitorDeathDetection: death detection logic
  - TestHeartbeatMonitorCallbacks: death/alive callbacks
  - TestHeartbeatMonitorConfigurableThreshold: configurable threshold
  - TestHeartbeatMonitorInterface: IHeartbeatMonitor interface methods
  - TestWriteBornEvent / TestWriteActionEvent: agent-side helpers
  - TestToolNameToOperationType: tool name mapping
  - TestCreateMonitor: convenience factory

Constraints:
  - No external dependencies (stdlib + pytest only)
  - No print output with Chinese/emoji
  - death_threshold is configurable, never hardcoded
  - All API signatures verified via ast.parse before test writing
"""

from __future__ import annotations

import pytest
from typing import List

from .heartbeat_monitor import (
    BORN_OPERATION_TYPE,
    DEFAULT_CHECK_INTERVAL_MS,
    DEFAULT_DEATH_THRESHOLD,
    ActionLogEntry,
    AgentSnapshot,
    AliveCallback,
    BornLogEntry,
    DeathCallback,
    HeartbeatCheckResult,
    HeartbeatConfig,
    HeartbeatMonitor,
    HeartbeatStatus,
    IActionLogStore,
    IHeartbeatMonitor,
    ISnapshotProvider,
    InMemoryActionLogStore,
    LogStoreSnapshotProvider,
    ResolvedHeartbeatConfig,
    create_monitor,
    is_born_entry,
    resolve_config,
    tool_name_to_operation_type,
    write_action_event,
    write_born_event,
    _now_ms,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def store() -> InMemoryActionLogStore:
    """Provide a fresh InMemoryActionLogStore."""
    return InMemoryActionLogStore()


@pytest.fixture
def provider(store: InMemoryActionLogStore) -> LogStoreSnapshotProvider:
    """Provide a LogStoreSnapshotProvider backed by the fixture store."""
    return LogStoreSnapshotProvider(store)


@pytest.fixture
def monitor(store: InMemoryActionLogStore, provider: LogStoreSnapshotProvider) -> HeartbeatMonitor:
    """Provide a HeartbeatMonitor with default config (agent1, death_threshold=3)."""
    config = HeartbeatConfig(agent_id="agent1", death_threshold=3)
    return HeartbeatMonitor(config, store, provider)


def _add_born(store: InMemoryActionLogStore, agent_id: str = "agent1") -> None:
    """Helper: write a born entry for the given agent."""
    born_entry = BornLogEntry(timestamp=_now_ms(), impact_scope=f"agent:{agent_id}")
    store.append(agent_id, born_entry)


def _add_action(store: InMemoryActionLogStore, agent_id: str = "agent1",
                operation_type: str = "file_write", impact_scope: str = "scope1") -> None:
    """Helper: write a regular action entry for the given agent."""
    entry = ActionLogEntry(timestamp=_now_ms(), operation_type=operation_type,
                           impact_scope=impact_scope)
    store.append(agent_id, entry)


# ---------------------------------------------------------------------------
# Test: Constants
# ---------------------------------------------------------------------------

class TestConstants:
    """Test module-level constants."""

    def test_born_operation_type(self):
        assert BORN_OPERATION_TYPE == "born"

    def test_default_check_interval_ms(self):
        assert DEFAULT_CHECK_INTERVAL_MS == 5000

    def test_default_death_threshold(self):
        assert DEFAULT_DEATH_THRESHOLD == 3


# ---------------------------------------------------------------------------
# Test: _now_ms helper
# ---------------------------------------------------------------------------

class TestNowMs:
    """Test _now_ms returns Unix milliseconds int."""

    def test_returns_int(self):
        result = _now_ms()
        assert isinstance(result, int)

    def test_returns_reasonable_timestamp(self):
        result = _now_ms()
        # After year 2020 in ms
        assert result > 1577836800000


# ---------------------------------------------------------------------------
# Test: Data types (types.ts translation)
# ---------------------------------------------------------------------------

class TestActionLogEntry:
    """Test ActionLogEntry dataclass."""

    def test_creation(self):
        entry = ActionLogEntry(
            timestamp=1000000,
            operation_type="file_write",
            impact_scope="workspace:abc/file:main.ts",
        )
        assert entry.timestamp == 1000000
        assert entry.operation_type == "file_write"
        assert entry.impact_scope == "workspace:abc/file:main.ts"

    def test_frozen(self):
        entry = ActionLogEntry(
            timestamp=1000000,
            operation_type="file_write",
            impact_scope="workspace:abc/file:main.ts",
        )
        with pytest.raises(AttributeError):
            entry.operation_type = "api_call"  # type: ignore[misc]

    def test_equality(self):
        e1 = ActionLogEntry(1000, "file_write", "scope1")
        e2 = ActionLogEntry(1000, "file_write", "scope1")
        assert e1 == e2

    def test_inequality(self):
        e1 = ActionLogEntry(1000, "file_write", "scope1")
        e2 = ActionLogEntry(1000, "file_write", "scope2")
        assert e1 != e2


class TestBornLogEntry:
    """Test BornLogEntry dataclass."""

    def test_operation_type_is_born(self):
        entry = BornLogEntry(timestamp=1000, impact_scope="agent:x")
        assert entry.operation_type == BORN_OPERATION_TYPE
        assert entry.operation_type == "born"

    def test_is_subclass_of_action_log_entry(self):
        entry = BornLogEntry(timestamp=1000, impact_scope="agent:x")
        assert isinstance(entry, ActionLogEntry)

    def test_inherits_frozen(self):
        entry = BornLogEntry(timestamp=1000, impact_scope="agent:x")
        with pytest.raises(AttributeError):
            entry.impact_scope = "changed"  # type: ignore[misc]


class TestIsBornEntry:
    """Test is_born_entry type guard."""

    def test_born_entry_returns_true(self):
        entry = BornLogEntry(timestamp=1000, impact_scope="agent:x")
        assert is_born_entry(entry) is True

    def test_non_born_entry_returns_false(self):
        entry = ActionLogEntry(timestamp=1000, operation_type="file_write", impact_scope="s")
        assert is_born_entry(entry) is False


class TestHeartbeatStatus:
    """Test HeartbeatStatus enum."""

    def test_values(self):
        assert HeartbeatStatus.WAITING_FOR_BORN.value == "waiting_for_born"
        assert HeartbeatStatus.ALIVE.value == "alive"
        assert HeartbeatStatus.DEAD.value == "dead"

    def test_members(self):
        assert len(HeartbeatStatus) == 3

    def test_member_names(self):
        names = [m.name for m in HeartbeatStatus]
        assert "WAITING_FOR_BORN" in names
        assert "ALIVE" in names
        assert "DEAD" in names


class TestHeartbeatCheckResult:
    """Test HeartbeatCheckResult dataclass."""

    def test_creation(self):
        result = HeartbeatCheckResult(
            checked_at=1000,
            status=HeartbeatStatus.ALIVE,
            no_change_count=0,
            log_entry_count=5,
            has_change=True,
        )
        assert result.status == HeartbeatStatus.ALIVE
        assert result.has_change is True
        assert result.log_entry_count == 5

    def test_frozen(self):
        result = HeartbeatCheckResult(
            checked_at=1000,
            status=HeartbeatStatus.ALIVE,
            no_change_count=0,
            log_entry_count=5,
            has_change=True,
        )
        with pytest.raises(AttributeError):
            result.status = HeartbeatStatus.DEAD  # type: ignore[misc]


class TestAgentSnapshot:
    """Test AgentSnapshot dataclass."""

    def test_creation(self):
        entries = [ActionLogEntry(1000, "op1", "scope1")]
        snap = AgentSnapshot(
            agent_id="agent1",
            log_entries=entries,
            captured_at=1000,
        )
        assert snap.agent_id == "agent1"
        assert len(snap.log_entries) == 1
        assert snap.captured_at == 1000

    def test_frozen(self):
        snap = AgentSnapshot(agent_id="a", log_entries=[], captured_at=0)
        with pytest.raises(AttributeError):
            snap.agent_id = "b"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Test: InMemoryActionLogStore (action-log.ts translation)
# ---------------------------------------------------------------------------

class TestInMemoryActionLogStore:
    """Test InMemoryActionLogStore."""

    def test_append_and_read(self, store: InMemoryActionLogStore):
        entry = ActionLogEntry(1000, "file_write", "scope1")
        store.append("agent1", entry)
        entries = store.read("agent1")
        assert len(entries) == 1
        assert entries[0] == entry

    def test_read_unknown_agent_returns_empty(self, store: InMemoryActionLogStore):
        entries = store.read("unknown")
        assert entries == []

    def test_count(self, store: InMemoryActionLogStore):
        assert store.count("agent1") == 0
        store.append("agent1", ActionLogEntry(1000, "op1", "s1"))
        assert store.count("agent1") == 1
        store.append("agent1", ActionLogEntry(2000, "op2", "s2"))
        assert store.count("agent1") == 2

    def test_count_unknown_agent_is_zero(self, store: InMemoryActionLogStore):
        assert store.count("nobody") == 0

    def test_clear(self, store: InMemoryActionLogStore):
        store.append("agent1", ActionLogEntry(1000, "op1", "s1"))
        store.clear("agent1")
        assert store.count("agent1") == 0

    def test_read_returns_copy(self, store: InMemoryActionLogStore):
        store.append("agent1", ActionLogEntry(1000, "op1", "s1"))
        entries = store.read("agent1")
        entries.clear()
        # Original should be unaffected
        assert store.count("agent1") == 1

    def test_entries_sorted_by_timestamp(self, store: InMemoryActionLogStore):
        store.append("agent1", ActionLogEntry(3000, "op3", "s3"))
        store.append("agent1", ActionLogEntry(1000, "op1", "s1"))
        store.append("agent1", ActionLogEntry(2000, "op2", "s2"))
        entries = store.read("agent1")
        assert entries[0].timestamp == 1000
        assert entries[1].timestamp == 2000
        assert entries[2].timestamp == 3000

    def test_get_agent_ids(self, store: InMemoryActionLogStore):
        store.append("a1", ActionLogEntry(1000, "op1", "s1"))
        store.append("a2", ActionLogEntry(1000, "op1", "s1"))
        ids = store.get_agent_ids()
        assert "a1" in ids
        assert "a2" in ids

    def test_implements_i_action_log_store(self, store: InMemoryActionLogStore):
        assert isinstance(store, IActionLogStore)


# ---------------------------------------------------------------------------
# Test: LogStoreSnapshotProvider (snapshot-provider.ts translation)
# ---------------------------------------------------------------------------

class TestLogStoreSnapshotProvider:
    """Test LogStoreSnapshotProvider."""

    def test_capture_returns_snapshot(self, store: InMemoryActionLogStore):
        _add_born(store, "agent1")
        provider = LogStoreSnapshotProvider(store)
        snapshot = provider.capture("agent1")
        assert isinstance(snapshot, AgentSnapshot)
        assert snapshot.agent_id == "agent1"
        assert len(snapshot.log_entries) == 1

    def test_capture_includes_timestamp(self, store: InMemoryActionLogStore):
        provider = LogStoreSnapshotProvider(store)
        snapshot = provider.capture("agent1")
        assert snapshot.captured_at > 0
        assert isinstance(snapshot.captured_at, int)

    def test_capture_empty_agent(self, store: InMemoryActionLogStore):
        provider = LogStoreSnapshotProvider(store)
        snapshot = provider.capture("nonexistent")
        assert snapshot.log_entries == []

    def test_implements_i_snapshot_provider(self, store: InMemoryActionLogStore):
        provider = LogStoreSnapshotProvider(store)
        assert isinstance(provider, ISnapshotProvider)


# ---------------------------------------------------------------------------
# Test: resolve_config (monitor.ts translation)
# ---------------------------------------------------------------------------

class TestResolveConfig:
    """Test resolve_config defaults application."""

    def test_all_defaults(self):
        config = HeartbeatConfig(agent_id="a1")
        resolved = resolve_config(config)
        assert isinstance(resolved, ResolvedHeartbeatConfig)
        assert resolved.check_interval_ms == DEFAULT_CHECK_INTERVAL_MS
        assert resolved.death_threshold == DEFAULT_DEATH_THRESHOLD
        assert resolved.agent_id == "a1"

    def test_custom_values(self):
        config = HeartbeatConfig(agent_id="a2", check_interval_ms=1000, death_threshold=5)
        resolved = resolve_config(config)
        assert resolved.check_interval_ms == 1000
        assert resolved.death_threshold == 5

    def test_partial_defaults(self):
        config = HeartbeatConfig(agent_id="a3", death_threshold=7)
        resolved = resolve_config(config)
        assert resolved.check_interval_ms == DEFAULT_CHECK_INTERVAL_MS
        assert resolved.death_threshold == 7

    def test_resolved_is_frozen(self):
        config = HeartbeatConfig(agent_id="a1")
        resolved = resolve_config(config)
        with pytest.raises(AttributeError):
            resolved.death_threshold = 99  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Test: HeartbeatMonitor - Born checks (monitor.ts translation)
# ---------------------------------------------------------------------------

class TestHeartbeatMonitorBornChecks:
    """Test born event validation on first check."""

    def test_initial_status_is_waiting_for_born(self, monitor: HeartbeatMonitor):
        assert monitor.status == HeartbeatStatus.WAITING_FOR_BORN

    def test_first_check_with_born_transitions_to_alive(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        _add_born(store)
        result = monitor.perform_check()
        assert result is not None
        assert result.status == HeartbeatStatus.ALIVE
        assert result.has_change is True
        assert monitor.status == HeartbeatStatus.ALIVE
        assert monitor.born_confirmed is True

    def test_first_check_without_born_transitions_to_dead(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        _add_action(store)
        result = monitor.perform_check()
        assert result is not None
        assert result.status == HeartbeatStatus.DEAD
        assert monitor.born_confirmed is False

    def test_empty_log_means_no_born(
        self, monitor: HeartbeatMonitor
    ):
        result = monitor.perform_check()
        assert result is not None
        assert result.status == HeartbeatStatus.DEAD

    def test_born_entry_must_come_before_other_entries(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        # Action before born entry - born entry exists but first check should
        # still find born (is_born_entry checks operation_type, not order)
        _add_action(store)
        _add_born(store)
        result = monitor.perform_check()
        assert result is not None
        assert result.status == HeartbeatStatus.ALIVE


# ---------------------------------------------------------------------------
# Test: HeartbeatMonitor - Alive checks (monitor.ts translation)
# ---------------------------------------------------------------------------

class TestHeartbeatMonitorAliveChecks:
    """Test alive check behavior."""

    def test_subsequent_check_with_change_stays_alive(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        _add_born(store)
        monitor.perform_check()  # first check -> ALIVE
        _add_action(store)  # add new action
        result = monitor.perform_check()
        assert result is not None
        assert result.status == HeartbeatStatus.ALIVE
        assert result.has_change is True
        assert result.no_change_count == 0

    def test_subsequent_check_without_change_increments_counter(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        _add_born(store)
        monitor.perform_check()  # first check -> ALIVE
        result = monitor.perform_check()  # no change
        assert result is not None
        assert result.status == HeartbeatStatus.ALIVE
        assert result.has_change is False
        assert result.no_change_count == 1

    def test_alive_callback_fired_on_no_change_below_threshold(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        alive_results: List[HeartbeatCheckResult] = []
        monitor.on_alive(lambda aid, r: alive_results.append(r))
        _add_born(store)
        monitor.perform_check()  # ALIVE
        monitor.perform_check()  # no_change=1, still alive
        assert len(alive_results) == 2


# ---------------------------------------------------------------------------
# Test: HeartbeatMonitor - Death detection (monitor.ts translation)
# ---------------------------------------------------------------------------

class TestHeartbeatMonitorDeathDetection:
    """Test death detection logic."""

    def test_death_after_threshold_no_change(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        _add_born(store)
        monitor.perform_check()  # ALIVE (first check)
        monitor.perform_check()  # no_change=1
        monitor.perform_check()  # no_change=2
        result = monitor.perform_check()  # no_change=3 => DEAD
        assert result is not None
        assert result.status == HeartbeatStatus.DEAD

    def test_no_further_checks_after_death(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        _add_born(store)
        monitor.perform_check()  # ALIVE
        monitor.perform_check()  # no_change=1
        monitor.perform_check()  # no_change=2
        monitor.perform_check()  # no_change=3 => DEAD
        result = monitor.perform_check()  # already dead
        assert result is None

    def test_change_prevents_death(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        _add_born(store)
        monitor.perform_check()  # ALIVE
        monitor.perform_check()  # no_change=1
        monitor.perform_check()  # no_change=2
        # Add action before threshold is reached
        _add_action(store)
        result = monitor.perform_check()
        assert result is not None
        assert result.status == HeartbeatStatus.ALIVE
        assert result.no_change_count == 0

    def test_death_resets_no_change_counter_to_threshold(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        _add_born(store)
        monitor.perform_check()  # ALIVE
        monitor.perform_check()  # no_change=1
        monitor.perform_check()  # no_change=2
        result = monitor.perform_check()  # no_change=3 => DEAD
        assert result is not None
        assert result.no_change_count == 3


# ---------------------------------------------------------------------------
# Test: HeartbeatMonitor - Callbacks (monitor.ts translation)
# ---------------------------------------------------------------------------

class TestHeartbeatMonitorCallbacks:
    """Test death and alive callbacks."""

    def test_alive_callback_on_born(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        alive_results: List[HeartbeatCheckResult] = []
        monitor.on_alive(lambda aid, r: alive_results.append(r))
        _add_born(store)
        monitor.perform_check()  # first check -> ALIVE
        assert len(alive_results) == 1
        assert alive_results[0].status == HeartbeatStatus.ALIVE

    def test_death_callback_when_no_born(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        death_results: List[HeartbeatCheckResult] = []
        monitor.on_death(lambda aid, r: death_results.append(r))
        _add_action(store)
        monitor.perform_check()
        assert len(death_results) == 1
        assert death_results[0].status == HeartbeatStatus.DEAD

    def test_death_callback_on_threshold(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        death_results: List[HeartbeatCheckResult] = []
        monitor.on_death(lambda aid, r: death_results.append(r))
        _add_born(store)
        monitor.perform_check()  # ALIVE (first check)
        monitor.perform_check()  # no_change=1
        monitor.perform_check()  # no_change=2
        monitor.perform_check()  # no_change=3 => DEAD
        assert len(death_results) == 1
        assert death_results[0].status == HeartbeatStatus.DEAD

    def test_multiple_callbacks(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        results_a: List[HeartbeatCheckResult] = []
        results_b: List[HeartbeatCheckResult] = []
        monitor.on_alive(lambda aid, r: results_a.append(r))
        monitor.on_alive(lambda aid, r: results_b.append(r))
        _add_born(store)
        monitor.perform_check()
        assert len(results_a) == 1
        assert len(results_b) == 1

    def test_callback_receives_agent_id(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        received_ids: List[str] = []
        monitor.on_alive(lambda aid, r: received_ids.append(aid))
        _add_born(store)
        monitor.perform_check()
        assert received_ids == ["agent1"]


# ---------------------------------------------------------------------------
# Test: HeartbeatMonitor - Configurable threshold
# ---------------------------------------------------------------------------

class TestHeartbeatMonitorConfigurableThreshold:
    """Test configurable death_threshold."""

    def test_custom_threshold_1(
        self, store: InMemoryActionLogStore, provider: LogStoreSnapshotProvider
    ):
        config = HeartbeatConfig(agent_id="agent1", death_threshold=1)
        monitor = HeartbeatMonitor(config, store, provider)
        _add_born(store)
        monitor.perform_check()  # ALIVE (first check)
        result = monitor.perform_check()  # no_change=1 => DEAD (threshold=1)
        assert result is not None
        assert result.status == HeartbeatStatus.DEAD

    def test_custom_threshold_5(
        self, store: InMemoryActionLogStore, provider: LogStoreSnapshotProvider
    ):
        config = HeartbeatConfig(agent_id="agent1", death_threshold=5)
        monitor = HeartbeatMonitor(config, store, provider)
        _add_born(store)
        monitor.perform_check()  # ALIVE (first check)
        for i in range(4):
            result = monitor.perform_check()
            assert result is not None
            assert result.status == HeartbeatStatus.ALIVE, f"Should be alive at no_change={i+1}"
        result = monitor.perform_check()  # no_change=5 => DEAD
        assert result is not None
        assert result.status == HeartbeatStatus.DEAD

    def test_default_threshold_is_3(
        self, store: InMemoryActionLogStore, provider: LogStoreSnapshotProvider
    ):
        config = HeartbeatConfig(agent_id="agent1")
        monitor = HeartbeatMonitor(config, store, provider)
        assert monitor.config.death_threshold == DEFAULT_DEATH_THRESHOLD


# ---------------------------------------------------------------------------
# Test: HeartbeatMonitor - Interface methods (monitor.ts translation)
# ---------------------------------------------------------------------------

class TestHeartbeatMonitorInterface:
    """Test IHeartbeatMonitor interface methods."""

    def test_get_status(self, monitor: HeartbeatMonitor):
        assert monitor.get_status() == HeartbeatStatus.WAITING_FOR_BORN

    def test_get_no_change_count(self, monitor: HeartbeatMonitor):
        assert monitor.get_no_change_count() == 0

    def test_start_performs_check(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        _add_born(store)
        monitor.start()
        assert monitor.status == HeartbeatStatus.ALIVE

    def test_tick_alias(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        _add_born(store)
        result = monitor.tick()
        assert result is not None
        assert result.status == HeartbeatStatus.ALIVE

    def test_reset(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        _add_born(store)
        monitor.perform_check()  # ALIVE
        assert monitor.status == HeartbeatStatus.ALIVE
        monitor.reset()
        assert monitor.status == HeartbeatStatus.WAITING_FOR_BORN
        assert monitor.no_change_count == 0
        assert monitor.born_confirmed is False

    def test_stop_is_noop(
        self, monitor: HeartbeatMonitor
    ):
        # stop() should not raise
        monitor.stop()

    def test_implements_i_heartbeat_monitor(self, monitor: HeartbeatMonitor):
        assert isinstance(monitor, IHeartbeatMonitor)


# ---------------------------------------------------------------------------
# Test: HeartbeatCheckResult fields
# ---------------------------------------------------------------------------

class TestHeartbeatCheckResultDetails:
    """Test check result field values in detail."""

    def test_check_result_has_checked_at(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        _add_born(store)
        result = monitor.perform_check()
        assert result is not None
        assert isinstance(result.checked_at, int)
        assert result.checked_at > 0

    def test_check_result_log_entry_count(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        _add_born(store)
        result = monitor.perform_check()
        assert result is not None
        assert result.log_entry_count == 1


# ---------------------------------------------------------------------------
# Test: write_born_event (agent-behavior-log.ts translation)
# ---------------------------------------------------------------------------

class TestWriteBornEvent:
    """Test write_born_event helper."""

    def test_writes_born_entry(self, store: InMemoryActionLogStore):
        write_born_event(store, "agent1", "agent:agent1")
        entries = store.read("agent1")
        assert len(entries) == 1
        assert is_born_entry(entries[0])

    def test_born_entry_has_correct_operation_type(self, store: InMemoryActionLogStore):
        write_born_event(store, "agent1", "agent:agent1")
        entries = store.read("agent1")
        assert entries[0].operation_type == BORN_OPERATION_TYPE

    def test_born_entry_has_timestamp(self, store: InMemoryActionLogStore):
        write_born_event(store, "agent1", "agent:agent1")
        entries = store.read("agent1")
        assert isinstance(entries[0].timestamp, int)
        assert entries[0].timestamp > 0


# ---------------------------------------------------------------------------
# Test: write_action_event (agent-behavior-log.ts translation)
# ---------------------------------------------------------------------------

class TestWriteActionEvent:
    """Test write_action_event helper."""

    def test_writes_action_entry(self, store: InMemoryActionLogStore):
        write_action_event(store, "agent1", "file_write", "workspace:abc")
        entries = store.read("agent1")
        assert len(entries) == 1
        assert entries[0].operation_type == "file_write"

    def test_refuses_born_operation_type(self, store: InMemoryActionLogStore):
        with pytest.raises(ValueError, match="Cannot write 'born' event"):
            write_action_event(store, "agent1", BORN_OPERATION_TYPE, "scope")

    def test_action_entry_has_timestamp(self, store: InMemoryActionLogStore):
        write_action_event(store, "agent1", "api_call", "scope")
        entries = store.read("agent1")
        assert isinstance(entries[0].timestamp, int)
        assert entries[0].timestamp > 0


# ---------------------------------------------------------------------------
# Test: tool_name_to_operation_type (agent-behavior-log.ts translation)
# ---------------------------------------------------------------------------

class TestToolNameToOperationType:
    """Test tool_name_to_operation_type mapping."""

    def test_known_mappings(self):
        assert tool_name_to_operation_type("reply_to_user") == "message_send"
        assert tool_name_to_operation_type("set_goal") == "goal_set"
        assert tool_name_to_operation_type("read_file") == "file_read"
        assert tool_name_to_operation_type("write_file") == "file_write"
        assert tool_name_to_operation_type("shell_exec") == "shell_exec"
        assert tool_name_to_operation_type("web_search") == "web_search"

    def test_unknown_tool_returns_tool_name(self):
        assert tool_name_to_operation_type("unknown_tool") == "unknown_tool"

    def test_start_self_update_mapping(self):
        assert tool_name_to_operation_type("start_self_update") == "self_update_start"


# ---------------------------------------------------------------------------
# Test: create_monitor helper
# ---------------------------------------------------------------------------

class TestCreateMonitor:
    """Test create_monitor convenience function."""

    def test_creates_monitor_with_defaults(self):
        monitor = create_monitor("agent1")
        assert monitor.config.agent_id == "agent1"
        assert monitor.config.death_threshold == DEFAULT_DEATH_THRESHOLD
        assert monitor.config.check_interval_ms == DEFAULT_CHECK_INTERVAL_MS

    def test_creates_monitor_with_custom_threshold(self):
        monitor = create_monitor("agent2", death_threshold=5)
        assert monitor.config.death_threshold == 5

    def test_creates_monitor_with_custom_store(self):
        store = InMemoryActionLogStore()
        monitor = create_monitor("agent3", log_store=store)
        assert monitor.config.agent_id == "agent3"

    def test_full_lifecycle_via_create_monitor(self):
        store = InMemoryActionLogStore()
        monitor = create_monitor("agent1", death_threshold=2, log_store=store)
        # Write born entry
        _add_born(store, "agent1")
        result = monitor.perform_check()
        assert result.status == HeartbeatStatus.ALIVE
        # No change x2 => DEAD
        monitor.perform_check()
        result = monitor.perform_check()
        assert result.status == HeartbeatStatus.DEAD


# ---------------------------------------------------------------------------
# Test: HeartbeatMonitor - Reset behavior
# ---------------------------------------------------------------------------

class TestHeartbeatMonitorReset:
    """Test monitor reset clears all state."""

    def test_reset_after_death_allows_new_lifecycle(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        _add_born(store)
        monitor.perform_check()  # ALIVE
        monitor.perform_check()  # no_change=1
        monitor.perform_check()  # no_change=2
        monitor.perform_check()  # no_change=3 => DEAD
        assert monitor.status == HeartbeatStatus.DEAD

        monitor.reset()
        assert monitor.status == HeartbeatStatus.WAITING_FOR_BORN
        assert monitor.no_change_count == 0
        assert monitor.born_confirmed is False

        # Add fresh born entry
        _add_born(store)
        result = monitor.perform_check()
        assert result is not None
        assert result.status == HeartbeatStatus.ALIVE

    def test_reset_clears_callbacks(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        alive_results: List[HeartbeatCheckResult] = []
        monitor.on_alive(lambda aid, r: alive_results.append(r))
        _add_born(store)
        monitor.perform_check()
        assert len(alive_results) == 1

        monitor.reset()
        # After reset, callbacks are cleared
        _add_born(store)
        monitor.perform_check()
        # No additional callbacks should fire
        assert len(alive_results) == 1


# ---------------------------------------------------------------------------
# Test: Edge cases
# ---------------------------------------------------------------------------

class TestEdgeCases:
    """Test edge cases and boundary conditions."""

    def test_multiple_agents_independent(
        self, store: InMemoryActionLogStore, provider: LogStoreSnapshotProvider
    ):
        """Two agents should be monitored independently."""
        config1 = HeartbeatConfig(agent_id="a1", death_threshold=2)
        config2 = HeartbeatConfig(agent_id="a2", death_threshold=2)
        m1 = HeartbeatMonitor(config1, store, provider)
        m2 = HeartbeatMonitor(config2, store, provider)

        # Both get born events
        _add_born(store, "a1")
        _add_born(store, "a2")

        r1 = m1.perform_check()
        r2 = m2.perform_check()
        assert r1 is not None and r1.status == HeartbeatStatus.ALIVE
        assert r2 is not None and r2.status == HeartbeatStatus.ALIVE

        # a1 gets action, a2 doesn't
        _add_action(store, "a1")
        r1 = m1.perform_check()
        r2 = m2.perform_check()
        assert r1 is not None and r1.status == HeartbeatStatus.ALIVE
        assert r2 is not None and r2.no_change_count == 1

    def test_check_result_timestamp_is_int_ms(
        self, store: InMemoryActionLogStore, monitor: HeartbeatMonitor
    ):
        """Verify checked_at is Unix ms integer (aligns with TS Date.now())."""
        _add_born(store)
        result = monitor.perform_check()
        assert result is not None
        assert isinstance(result.checked_at, int)
        # Should be greater than year 2020 in ms
        assert result.checked_at > 1577836800000

    def test_snapshot_captured_at_is_int_ms(
        self, store: InMemoryActionLogStore
    ):
        """Verify AgentSnapshot.captured_at is Unix ms integer."""
        _add_born(store, "agent1")
        provider = LogStoreSnapshotProvider(store)
        snap = provider.capture("agent1")
        assert isinstance(snap.captured_at, int)
        assert snap.captured_at > 1577836800000
