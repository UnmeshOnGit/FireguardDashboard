#!/usr/bin/env python3
"""
FireGuard Monitor — Python Flask + pyserial Backend
Reads Arduino fire & gas telemetry in a background daemon thread, logs readings
and safety events to CSV files, and serves a fast REST API for the web dashboard.
"""

import argparse
import csv
import json
import math
import os
import re
import threading
import time
from collections import deque
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from flask import Flask, jsonify, render_template, request, send_file
import serial
import serial.tools.list_ports

# ---------------------------------------------------------------------------
# Paths & Constants
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
READINGS_CSV = os.path.join(DATA_DIR, "readings.csv")
EVENTS_CSV = os.path.join(DATA_DIR, "events.csv")
SETTINGS_JSON = os.path.join(DATA_DIR, "settings.json")

MAX_READINGS = 5000
MAX_EVENTS = 1000
OFFLINE_TIMEOUT_SEC = 3.0
IR_FAULT_DURATION_SEC = 60.0

READINGS_HEADER = [
    "timestamp_iso",
    "timestamp_ms",
    "mq2",
    "gas",
    "ir",
    "servo",
    "mist",
    "alarm",
    "state",
]
EVENTS_HEADER = [
    "timestamp_iso",
    "timestamp_ms",
    "event_type",
    "state",
    "mq2",
    "gas",
    "ir",
    "servo",
    "mist",
    "alarm",
]

# Regex patterns for Arduino serial lines
TELEMETRY_EXACT_RE = re.compile(
    r"^MQ2:\s*(\d+)\s*\|\s*GAS:\s*(NORMAL|ALERT)\s*\|\s*IR:\s*(NORMAL|DETECTED)"
    r"(?:\s*\|\s*SERVO:\s*(\d+))?\s*\|\s*MIST:\s*(ON|OFF)\s*\|\s*ALARM:\s*(CLEAR|ACTIVE)\s*$",
    re.IGNORECASE,
)
CALIBRATION_RE = re.compile(
    r"^Baseline:\s*(\d+)\s*\|\s*Threshold:\s*(\d+)\s*$", re.IGNORECASE
)
WARMUP_RE = re.compile(r"^Warm-?up:\s*(\d+)\s*s?\s*$", re.IGNORECASE)
READY_RE = re.compile(r"^FIREGUARD\s+READY\s*$", re.IGNORECASE)
KV_TOKEN_RE = re.compile(
    r"\b(MQ-?2(?:\s+(?:SENSOR|VAL(?:UE)?))?|GAS(?:\s+VAL(?:UE)?)?|SMOKE|PPM|ANALOG|RAW|"
    r"IR(?:\s+SENSOR)?|FLAME(?:\s+SENSOR)?|FIRE|SERVO|MIST|RELAY|PUMP|ALARM|BUZZER)\s*[:=]\s*([A-Za-z0-9_.-]+)",
    re.IGNORECASE,
)
BARE_INT_RE = re.compile(r"^\s*(\d{1,4})\s*$")
SIMPLE_CSV_RE = re.compile(
    r"^\s*(\d{1,4})\s*[,;]\s*([A-Za-z0-9_]+)(?:\s*[,;]\s*([A-Za-z0-9_]+))?(?:\s*[,;]\s*([A-Za-z0-9_]+))?\s*$"
)


def _norm_gas(token: str) -> Optional[str]:
    t = token.strip().upper()
    if t in ("ALERT", "HIGH", "DANGER", "DETECTED", "WARNING", "LEAK", "YES", "TRUE", "1"):
        return "ALERT"
    if t in ("NORMAL", "OK", "CLEAR", "SAFE", "LOW", "NO", "FALSE", "0"):
        return "NORMAL"
    return None


def _norm_ir(token: str) -> Optional[str]:
    t = token.strip().upper()
    if t in ("DETECTED", "FIRE", "FLAME", "ALERT", "HIGH", "YES", "TRUE", "1"):
        return "DETECTED"
    if t in ("NORMAL", "CLEAR", "NONE", "NO", "SAFE", "LOW", "FALSE", "0"):
        return "NORMAL"
    return None


def _norm_mist(token: str) -> Optional[str]:
    t = token.strip().upper()
    if t in ("ON", "ACTIVE", "HIGH", "YES", "TRUE", "1"):
        return "ON"
    if t in ("OFF", "CLEAR", "LOW", "NO", "FALSE", "0"):
        return "OFF"
    return None


def _norm_alarm(token: str) -> Optional[str]:
    t = token.strip().upper()
    if t in ("ACTIVE", "ON", "ALERT", "HIGH", "YES", "TRUE", "1"):
        return "ACTIVE"
    if t in ("CLEAR", "OFF", "NORMAL", "LOW", "NO", "FALSE", "0"):
        return "CLEAR"
    return None


# ---------------------------------------------------------------------------
# Thread-Safe Application Store
# ---------------------------------------------------------------------------
class FireGuardStore:
    """Thread-safe in-memory state + CSV persistence for FireGuard Monitor."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        os.makedirs(DATA_DIR, exist_ok=True)

        self.session_start = time.time()
        self.readings: deque = deque(maxlen=MAX_READINGS)
        self.events: deque = deque(maxlen=MAX_EVENTS)

        # Calibration & settings
        self.baseline = 280
        self.threshold = 380
        self.critical_level = 580
        self._load_settings()

        # Warm-up state
        self.warming_up = False
        self.warmup_total_sec = 0
        self.warmup_until: Optional[float] = None

        # Connection status
        self.demo_mode = False
        self.configured_port: Optional[str] = None
        self.active_port: Optional[str] = None
        self.baud_rate = 115200
        self.connection_status = "Disconnected"  # Disconnected | Connecting | Live | Demo

        # Latest reading & computed state tracking
        self.latest: Optional[Dict[str, Any]] = None
        self.last_reading_time: Optional[float] = None
        self.last_accounting_time: Optional[float] = None
        self.system_state = "OFFLINE"
        self.state_entered_at = time.time()

        # Session statistics
        self.session_peak_mq2: Optional[int] = None
        self.mq2_sum = 0
        self.mq2_count = 0
        self.mq2_min: Optional[int] = None
        self.mq2_max: Optional[int] = None

        self.durations = {"NORMAL": 0.0, "WARNING": 0.0, "CRITICAL": 0.0}
        self.mist_on_sec = 0.0
        self.gas_alerts_count = 0
        self.flame_detections_count = 0
        self.critical_started_at: Optional[float] = None
        self.longest_critical_sec = 0.0
        self.last_incident_time: Optional[float] = None

        # Servo lock & sensor health tracking
        self.recent_servo_angles: deque = deque(maxlen=5)
        self.mq2_rail_count = 0
        self.ir_continuous_since: Optional[float] = None

        # Raw serial stream diagnostics & live reconnect signaling
        self.raw_serial_lines: deque = deque(maxlen=40)
        self.raw_lines_count = 0
        self.parsed_lines_count = 0
        self.garbled_lines_count = 0
        self.reconnect_event = threading.Event()

        self._ensure_csv_headers()

    def _load_settings(self) -> None:
        if not os.path.exists(SETTINGS_JSON):
            return
        try:
            with open(SETTINGS_JSON, "r", encoding="utf-8") as f:
                data = json.load(f)
            t = int(data.get("threshold", self.threshold))
            c = int(data.get("critical_level", self.critical_level))
            if 1 <= t <= 1023:
                self.threshold = t
            if 1 <= c <= 1023:
                self.critical_level = c
        except Exception:
            pass

    def _save_settings(self) -> None:
        try:
            with open(SETTINGS_JSON, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "threshold": self.threshold,
                        "critical_level": self.critical_level,
                    },
                    f,
                    indent=2,
                )
        except Exception:
            pass

    def _ensure_csv_headers(self) -> None:
        for path, header in (
            (READINGS_CSV, READINGS_HEADER),
            (EVENTS_CSV, EVENTS_HEADER),
        ):
            if not os.path.exists(path) or os.path.getsize(path) == 0:
                with open(path, "w", newline="", encoding="utf-8") as f:
                    csv.writer(f).writerow(header)

    def _append_csv_row(self, path: str, row: List[Any]) -> None:
        try:
            with open(path, "a", newline="", encoding="utf-8") as f:
                csv.writer(f).writerow(row)
        except Exception:
            pass

    @staticmethod
    def _compute_state(reading: Dict[str, Any]) -> str:
        if reading["ir"] == "DETECTED":
            return "CRITICAL"
        if reading["gas"] == "ALERT":
            return "WARNING"
        return "NORMAL"

    def _refresh_offline_locked(self, now: float) -> None:
        if (
            self.last_reading_time is not None
            and (now - self.last_reading_time) > OFFLINE_TIMEOUT_SEC
            and self.system_state != "OFFLINE"
        ):
            # Finalize active state duration up to timeout boundary
            if self.last_accounting_time is not None:
                dt = max(0.0, min(5.0, now - self.last_accounting_time))
                if self.system_state in self.durations:
                    self.durations[self.system_state] += dt
                if self.latest and self.latest["mist"] == "ON":
                    self.mist_on_sec += dt
            if self.critical_started_at is not None:
                crit_dur = now - self.critical_started_at
                self.longest_critical_sec = max(self.longest_critical_sec, crit_dur)
                self.critical_started_at = None

            self.last_accounting_time = None
            self.system_state = "OFFLINE"
            self.state_entered_at = now

    def set_connection(
        self, status: str, port: Optional[str] = None
    ) -> None:
        with self.lock:
            self.connection_status = status
            if port is not None:
                self.active_port = port

    def _record_event_locked(
        self, event_type: str, reading: Dict[str, Any], state: str
    ) -> None:
        ev = {
            "ts": reading["ts"],
            "iso": reading["iso"],
            "type": event_type,
            "state": state,
            "mq2": reading["mq2"],
            "gas": reading["gas"],
            "ir": reading["ir"],
            "servo": reading["servo"],
            "mist": reading["mist"],
            "alarm": reading["alarm"],
        }
        self.events.appendleft(ev)
        if event_type in ("Gas alert start", "Flame detected", "Alarm active"):
            self.last_incident_time = reading["ts"] / 1000.0

        self._append_csv_row(
            EVENTS_CSV,
            [
                ev["iso"],
                ev["ts"],
                ev["type"],
                ev["state"],
                ev["mq2"],
                ev["gas"],
                ev["ir"],
                "" if ev["servo"] is None else ev["servo"],
                ev["mist"],
                ev["alarm"],
            ],
        )

    def _record_raw_line_locked(self, line: str, status: str) -> None:
        ts_str = datetime.now().strftime("%H:%M:%S")
        self.raw_lines_count += 1
        if status == "OK":
            self.parsed_lines_count += 1
        elif status == "GARBLED":
            self.garbled_lines_count += 1
        cleaned = "".join(ch if (32 <= ord(ch) < 127) else "?" for ch in line[:140])
        self.raw_serial_lines.appendleft(f"[{ts_str}] [{status}] {cleaned}")

    def _parse_telemetry_values(self, line: str) -> Optional[Dict[str, Any]]:
        # Fast path: exact pipe-delimited format (with optional SERVO)
        t_match = TELEMETRY_EXACT_RE.match(line)
        if t_match:
            mq2 = int(t_match.group(1))
            if not (0 <= mq2 <= 1023):
                return None
            servo_raw = t_match.group(4)
            servo: Optional[int] = None
            if servo_raw is not None:
                servo_val = int(servo_raw)
                if 0 <= servo_val <= 180:
                    servo = max(15, min(165, servo_val))
            return {
                "mq2": mq2,
                "gas": t_match.group(2).upper(),
                "ir": t_match.group(3).upper(),
                "servo": servo,
                "mist": t_match.group(5).upper(),
                "alarm": t_match.group(6).upper(),
            }

        # Flexible Key:Value / Key=Value parser (pipes, commas, semicolons, or spaces)
        mq2: Optional[int] = None
        gas: Optional[str] = None
        ir: Optional[str] = None
        servo: Optional[int] = None
        mist: Optional[str] = None
        alarm: Optional[str] = None
        matched_fields = 0

        for m in KV_TOKEN_RE.finditer(line):
            raw_key = re.sub(r"[\s_-]+", "", m.group(1).upper())
            val = m.group(2)

            if raw_key in ("MQ2", "MQ2SENSOR", "MQ2VAL", "MQ2VALUE", "GASVAL", "GASVALUE", "SMOKE", "PPM", "ANALOG", "RAW"):
                try:
                    num = int(float(val))
                except ValueError:
                    continue
                if 0 <= num <= 1023:
                    mq2 = num
                    matched_fields += 1
            elif raw_key == "GAS":
                g = _norm_gas(val)
                if g:
                    gas = g
                    matched_fields += 1
                else:
                    try:
                        num = int(float(val))
                        if 0 <= num <= 1023 and mq2 is None:
                            mq2 = num
                            matched_fields += 1
                    except ValueError:
                        pass
            elif raw_key in ("IR", "IRSENSOR", "FLAME", "FLAMESENSOR", "FIRE"):
                parsed_ir = _norm_ir(val)
                if parsed_ir:
                    ir = parsed_ir
                    matched_fields += 1
            elif raw_key == "SERVO":
                try:
                    s_val = int(float(val))
                    if 0 <= s_val <= 180:
                        servo = max(15, min(165, s_val))
                        matched_fields += 1
                except ValueError:
                    pass
            elif raw_key in ("MIST", "RELAY", "PUMP"):
                parsed_mist = _norm_mist(val)
                if parsed_mist:
                    mist = parsed_mist
                    matched_fields += 1
            elif raw_key in ("ALARM", "BUZZER"):
                parsed_alarm = _norm_alarm(val)
                if parsed_alarm:
                    alarm = parsed_alarm
                    matched_fields += 1

        # Fallback: simple CSV (mq2,ir[,mist[,alarm]]) or single integer 0..1023
        if mq2 is None and matched_fields == 0:
            csv_m = SIMPLE_CSV_RE.match(line)
            if csv_m:
                num = int(csv_m.group(1))
                parsed_ir = _norm_ir(csv_m.group(2))
                if 0 <= num <= 1023 and parsed_ir:
                    mq2 = num
                    ir = parsed_ir
                    if csv_m.group(3):
                        mist = _norm_mist(csv_m.group(3)) or mist
                    if csv_m.group(4):
                        alarm = _norm_alarm(csv_m.group(4)) or alarm
                    matched_fields = 2
            else:
                int_m = BARE_INT_RE.match(line)
                if int_m:
                    num = int(int_m.group(1))
                    if 0 <= num <= 1023:
                        mq2 = num
                        matched_fields = 1

        if mq2 is None and matched_fields < 2:
            return None

        with self.lock:
            fallback_mq2 = self.latest["mq2"] if self.latest else self.baseline
            cur_thresh = self.threshold

        safe_mq2 = mq2 if mq2 is not None else fallback_mq2
        safe_gas = gas if gas is not None else ("ALERT" if safe_mq2 >= cur_thresh else "NORMAL")
        safe_ir = ir if ir is not None else "NORMAL"
        safe_mist = mist if mist is not None else "OFF"
        safe_alarm = alarm if alarm is not None else ("ACTIVE" if (safe_ir == "DETECTED" or safe_gas == "ALERT") else "CLEAR")

        return {
            "mq2": safe_mq2,
            "gas": safe_gas,
            "ir": safe_ir,
            "servo": servo,
            "mist": safe_mist,
            "alarm": safe_alarm,
        }

    def ingest_line(self, raw_line: str) -> None:
        line = raw_line.strip()
        if not line:
            return

        # Detect garbled bytes (common when baud rate mismatches)
        non_print = sum(1 for ch in line if ch == "\ufffd" or ord(ch) < 32 or ord(ch) > 126)
        if non_print > max(2, len(line) // 4):
            with self.lock:
                self._record_raw_line_locked(line, "GARBLED")
            return

        # 1. Startup calibration line
        cal_match = CALIBRATION_RE.match(line)
        if cal_match:
            baseline = max(0, min(1023, int(cal_match.group(1))))
            threshold = max(1, min(1023, int(cal_match.group(2))))
            with self.lock:
                self.baseline = baseline
                self.threshold = threshold
                self.critical_level = min(1023, threshold + 200)
                self._save_settings()
                self._record_raw_line_locked(line, "OK")
            return

        # 2. Warm-up countdown line
        warm_match = WARMUP_RE.match(line)
        if warm_match:
            sec = max(0, int(warm_match.group(1)))
            with self.lock:
                self.warming_up = sec > 0
                self.warmup_total_sec = sec
                self.warmup_until = time.time() + sec if sec > 0 else None
                self._record_raw_line_locked(line, "OK")
            return

        # 3. Ready line
        if READY_RE.match(line):
            with self.lock:
                self.warming_up = False
                self.warmup_until = None
                self._record_raw_line_locked(line, "OK")
            return

        # 4. Telemetry line (exact or flexible format)
        parsed = self._parse_telemetry_values(line)
        if not parsed:
            with self.lock:
                self._record_raw_line_locked(line, "SKIP")
            if not self.demo_mode:
                print(f"[Serial SKIP] Unrecognized line: {line!r}")
            return

        mq2 = parsed["mq2"]
        servo = parsed["servo"]
        gas = parsed["gas"]
        ir = parsed["ir"]
        mist = parsed["mist"]
        alarm = parsed["alarm"]

        now = time.time()
        ts_ms = int(now * 1000)
        iso = datetime.fromtimestamp(now).isoformat(timespec="seconds")

        with self.lock:
            self._record_raw_line_locked(line, "OK")
            self._refresh_offline_locked(now)
            prev = self.latest
            prev_state = self.system_state

            reading = {
                "ts": ts_ms,
                "iso": iso,
                "mq2": mq2,
                "gas": gas,
                "ir": ir,
                "servo": servo,
                "mist": mist,
                "alarm": alarm,
            }
            next_state = self._compute_state(reading)
            reading["state"] = next_state

            # Duration accounting since last active reading
            if self.last_accounting_time is not None and prev_state != "OFFLINE":
                dt = max(0.0, min(5.0, now - self.last_accounting_time))
                if prev_state in self.durations:
                    self.durations[prev_state] += dt
                if prev and prev["mist"] == "ON":
                    self.mist_on_sec += dt

            self.last_accounting_time = now
            self.last_reading_time = now

            # Store in capped deque & append to CSV
            self.readings.append(reading)
            self._append_csv_row(
                READINGS_CSV,
                [
                    iso,
                    ts_ms,
                    mq2,
                    gas,
                    ir,
                    "" if servo is None else servo,
                    mist,
                    alarm,
                    next_state,
                ],
            )

            # Aggregate MQ2 stats
            self.mq2_sum += mq2
            self.mq2_count += 1
            self.mq2_min = mq2 if self.mq2_min is None else min(self.mq2_min, mq2)
            self.mq2_max = mq2 if self.mq2_max is None else max(self.mq2_max, mq2)
            if self.session_peak_mq2 is None or mq2 > self.session_peak_mq2:
                self.session_peak_mq2 = mq2

            # Servo tracking
            if servo is not None:
                self.recent_servo_angles.append(servo)

            # Sensor health tracking
            if mq2 == 0 or mq2 == 1023:
                self.mq2_rail_count += 1
            else:
                self.mq2_rail_count = 0

            if ir == "DETECTED":
                if self.ir_continuous_since is None:
                    self.ir_continuous_since = now
            else:
                self.ir_continuous_since = None

            # Event detection (start/end transitions)
            if prev is None or prev_state == "OFFLINE":
                if gas == "ALERT":
                    self.gas_alerts_count += 1
                    self._record_event_locked("Gas alert start", reading, next_state)
                if ir == "DETECTED":
                    self.flame_detections_count += 1
                    self._record_event_locked("Flame detected", reading, next_state)
                if mist == "ON":
                    self._record_event_locked("Mist ON", reading, next_state)
                if alarm == "ACTIVE":
                    self._record_event_locked("Alarm active", reading, next_state)
            else:
                if gas != prev["gas"]:
                    if gas == "ALERT":
                        self.gas_alerts_count += 1
                        self._record_event_locked("Gas alert start", reading, next_state)
                    else:
                        self._record_event_locked("Gas alert end", reading, next_state)

                if ir != prev["ir"]:
                    if ir == "DETECTED":
                        self.flame_detections_count += 1
                        self._record_event_locked("Flame detected", reading, next_state)
                    else:
                        self._record_event_locked("Flame cleared", reading, next_state)

                if mist != prev["mist"]:
                    self._record_event_locked(
                        "Mist ON" if mist == "ON" else "Mist OFF", reading, next_state
                    )

                if alarm != prev["alarm"]:
                    self._record_event_locked(
                        "Alarm active" if alarm == "ACTIVE" else "Alarm clear",
                        reading,
                        next_state,
                    )

                if next_state == "NORMAL" and prev_state in ("WARNING", "CRITICAL"):
                    self._record_event_locked("Back to normal", reading, next_state)

            # Critical duration tracking
            if next_state == "CRITICAL" and prev_state != "CRITICAL":
                self.critical_started_at = now
            elif (
                next_state != "CRITICAL"
                and prev_state == "CRITICAL"
                and self.critical_started_at is not None
            ):
                crit_dur = now - self.critical_started_at
                self.longest_critical_sec = max(self.longest_critical_sec, crit_dur)
                self.critical_started_at = None

            if next_state != prev_state:
                self.system_state = next_state
                self.state_entered_at = now

            self.latest = reading

    def get_latest_payload(self) -> Dict[str, Any]:
        now = time.time()
        with self.lock:
            self._refresh_offline_locked(now)

            # Warmup remaining
            warmup_rem = 0
            if self.warming_up and self.warmup_until is not None:
                warmup_rem = max(0, int(math.ceil(self.warmup_until - now)))
                if warmup_rem == 0:
                    self.warming_up = False
                    self.warmup_until = None

            # Data rate over last 5 seconds
            cutoff_ms = int((now - 5.0) * 1000)
            recent_count = 0
            for r in reversed(self.readings):
                if r["ts"] >= cutoff_ms:
                    recent_count += 1
                else:
                    break
            data_rate = round(recent_count / 5.0, 1)

            # Servo mode
            servo_mode = "Sweeping"
            if (
                self.latest
                and self.latest["ir"] == "DETECTED"
                and len(self.recent_servo_angles) >= 3
            ):
                last3 = list(self.recent_servo_angles)[-3:]
                if max(last3) - min(last3) <= 1:
                    servo_mode = "Locked on flame"

            # Sensor health check
            mq2_fault = self.mq2_rail_count >= 5
            ir_fault = (
                self.ir_continuous_since is not None
                and (now - self.ir_continuous_since) > IR_FAULT_DURATION_SEC
            )
            health_ok = not (mq2_fault or ir_fault)
            if mq2_fault and ir_fault:
                health_msg = "MQ2 stuck at rail and IR continuously active > 60s"
            elif mq2_fault:
                val = self.latest["mq2"] if self.latest else "?"
                health_msg = f"MQ2 stuck at extreme rail ({val})"
            elif ir_fault:
                health_msg = "IR flame sensor stuck DETECTED for > 60s"
            else:
                health_msg = "All sensors nominal"

            return {
                "reading": self.latest,
                "state": self.system_state,
                "state_duration_sec": int(max(0, now - self.state_entered_at)),
                "uptime_sec": int(max(0, now - self.session_start)),
                "baseline": self.baseline,
                "threshold": self.threshold,
                "critical_level": self.critical_level,
                "session_peak": self.session_peak_mq2,
                "data_rate": data_rate,
                "servo_mode": servo_mode,
                "warm_up": {
                    "active": self.warming_up,
                    "remaining_sec": warmup_rem,
                    "total_sec": self.warmup_total_sec,
                },
                "connection": {
                    "status": self.connection_status,
                    "port": "DEMO" if self.demo_mode else self.active_port,
                    "baud": self.baud_rate,
                    "demo": self.demo_mode,
                },
                "sensor_health": {
                    "healthy": health_ok,
                    "message": health_msg,
                },
                "serial_log": {
                    "total": self.raw_lines_count,
                    "parsed": self.parsed_lines_count,
                    "garbled": self.garbled_lines_count,
                    "lines": list(self.raw_serial_lines)[:15],
                },
            }

    def get_history_payload(self, seconds: int) -> Dict[str, Any]:
        seconds = max(10, min(3600, seconds))
        cutoff_ms = int((time.time() - seconds) * 1000)

        with self.lock:
            window = [r for r in self.readings if r["ts"] >= cutoff_ms]
            # Downsample to max 300 points
            if len(window) > 300:
                step = len(window) / 300.0
                sampled = [window[int(i * step)] for i in range(300)]
            else:
                sampled = window

            return {
                "points": sampled,
                "threshold": self.threshold,
                "critical_level": self.critical_level,
                "baseline": self.baseline,
            }

    def get_events_payload(self, limit: int, event_type: str) -> Dict[str, Any]:
        limit = max(1, min(1000, limit))
        ev_filter = event_type.strip()
        with self.lock:
            items = list(self.events)
        if ev_filter and ev_filter.upper() != "ALL":
            items = [e for e in items if e["type"] == ev_filter]
        return {"events": items[:limit]}

    def get_report_payload(self) -> Dict[str, Any]:
        now = time.time()
        with self.lock:
            self._refresh_offline_locked(now)
            n_sec = self.durations["NORMAL"]
            w_sec = self.durations["WARNING"]
            c_sec = self.durations["CRITICAL"]
            mist_sec = self.mist_on_sec

            # Add ongoing slice without mutating
            if self.last_accounting_time is not None and self.system_state in self.durations:
                dt = max(0.0, min(5.0, now - self.last_accounting_time))
                if self.system_state == "NORMAL":
                    n_sec += dt
                elif self.system_state == "WARNING":
                    w_sec += dt
                elif self.system_state == "CRITICAL":
                    c_sec += dt
                if self.latest and self.latest["mist"] == "ON":
                    mist_sec += dt

            total_state_sec = n_sec + w_sec + c_sec
            pct_n = round((n_sec / total_state_sec) * 100.0, 1) if total_state_sec > 0 else 0.0
            pct_w = round((w_sec / total_state_sec) * 100.0, 1) if total_state_sec > 0 else 0.0
            pct_c = round((c_sec / total_state_sec) * 100.0, 1) if total_state_sec > 0 else 0.0

            active_crit = (now - self.critical_started_at) if self.critical_started_at else 0.0
            longest_crit = max(self.longest_critical_sec, active_crit)
            avg_mq2 = round(self.mq2_sum / self.mq2_count) if self.mq2_count > 0 else None

            # 5-minute alert/flame buckets
            bucket_ms = 300 * 1000
            buckets: Dict[int, Dict[str, int]] = {}
            for ev in self.events:
                if ev["type"] not in ("Gas alert start", "Flame detected"):
                    continue
                b_key = (ev["ts"] // bucket_ms) * bucket_ms
                if b_key not in buckets:
                    buckets[b_key] = {"gas": 0, "flame": 0}
                if ev["type"] == "Gas alert start":
                    buckets[b_key]["gas"] += 1
                else:
                    buckets[b_key]["flame"] += 1

            sorted_keys = sorted(buckets.keys())[-12:]
            bucket_list = [
                {
                    "label": datetime.fromtimestamp(k / 1000.0).strftime("%H:%M"),
                    "gas": buckets[k]["gas"],
                    "flame": buckets[k]["flame"],
                }
                for k in sorted_keys
            ]

            return {
                "session_duration_sec": int(max(0, now - self.session_start)),
                "total_readings": self.mq2_count,
                "avg_mq2": avg_mq2,
                "min_mq2": self.mq2_min,
                "max_mq2": self.mq2_max,
                "gas_alerts_count": self.gas_alerts_count,
                "flame_detections_count": self.flame_detections_count,
                "mist_on_sec": int(round(mist_sec)),
                "longest_critical_sec": int(round(longest_crit)),
                "last_incident_time": (
                    datetime.fromtimestamp(self.last_incident_time).strftime("%H:%M:%S")
                    if self.last_incident_time
                    else None
                ),
                "time_in_state": {
                    "NORMAL": {"sec": int(round(n_sec)), "pct": pct_n},
                    "WARNING": {"sec": int(round(w_sec)), "pct": pct_w},
                    "CRITICAL": {"sec": int(round(c_sec)), "pct": pct_c},
                },
                "buckets_5min": bucket_list,
            }

    def update_settings(self, threshold: int, critical_level: int) -> None:
        with self.lock:
            self.threshold = max(1, min(1023, threshold))
            self.critical_level = max(1, min(1023, critical_level))
            self._save_settings()

    def clear_all(self) -> None:
        now = time.time()
        with self.lock:
            self.readings.clear()
            self.events.clear()
            self.latest = None
            self.last_reading_time = None
            self.last_accounting_time = None
            self.system_state = "OFFLINE"
            self.state_entered_at = now
            self.session_start = now

            self.session_peak_mq2 = None
            self.mq2_sum = 0
            self.mq2_count = 0
            self.mq2_min = None
            self.mq2_max = None

            self.durations = {"NORMAL": 0.0, "WARNING": 0.0, "CRITICAL": 0.0}
            self.mist_on_sec = 0.0
            self.gas_alerts_count = 0
            self.flame_detections_count = 0
            self.critical_started_at = None
            self.longest_critical_sec = 0.0
            self.last_incident_time = None
            self.recent_servo_angles.clear()
            self.mq2_rail_count = 0
            self.ir_continuous_since = None
            self.raw_serial_lines.clear()
            self.raw_lines_count = 0
            self.parsed_lines_count = 0
            self.garbled_lines_count = 0

            for path, header in (
                (READINGS_CSV, READINGS_HEADER),
                (EVENTS_CSV, EVENTS_HEADER),
            ):
                with open(path, "w", newline="", encoding="utf-8") as f:
                    csv.writer(f).writerow(header)


# ---------------------------------------------------------------------------
# Serial Auto-Detection & Background Reader Workers
# ---------------------------------------------------------------------------
def list_and_detect_port(preferred_port: Optional[str]) -> Tuple[List[str], Optional[str]]:
    ports = list(serial.tools.list_ports.comports())
    print("\n=== Available Serial Ports ===")
    if not ports:
        print("  (none detected)")
    else:
        for p in ports:
            print(f"  - {p.device}: {p.description} [{p.hwid}]")
    print("==============================\n")

    if preferred_port:
        return [p.device for p in ports], preferred_port

    keywords = ("arduino", "ch340", "cp210", "ftdi", "usb serial", "usb-serial", "acm")
    for p in ports:
        desc = f"{p.description} {p.manufacturer or ''} {p.device}".lower()
        if any(k in desc for k in keywords):
            return [p.device for p in ports], p.device

    if ports:
        return [p.device for p in ports], ports[0].device
    return [], None


def serial_worker(store: FireGuardStore, stop_event: threading.Event) -> None:
    """Continuously reads Arduino serial port with automatic reconnect on unplug."""
    while not stop_event.is_set():
        store.reconnect_event.clear()
        target_port = store.configured_port
        if not target_port:
            _, detected = list_and_detect_port(None)
            target_port = detected

        if not target_port:
            store.set_connection("Disconnected", None)
            store.reconnect_event.wait(2.0)
            continue

        ser = None
        try:
            baud = store.baud_rate
            store.set_connection("Connecting", target_port)
            ser = serial.Serial(target_port, baud, timeout=0.5)
            try:
                ser.dtr = True
            except Exception:
                pass
            # Brief reset settle for Arduino Uno/Nano auto-reset on open
            time.sleep(0.25)
            store.set_connection("Live", target_port)
            print(f"[Serial] Connected to {target_port} at {baud} baud")

            buf = ""
            logged_first_rx = False
            while not stop_event.is_set() and not store.reconnect_event.is_set():
                waiting = ser.in_waiting
                raw = ser.read(waiting if waiting > 0 else 1)
                if not raw:
                    continue
                chunk = raw.decode("utf-8", errors="replace")
                buf += chunk
                if "\n" in buf or "\r" in buf:
                    parts = re.split(r"\r\n|\n|\r", buf)
                    buf = parts.pop()
                    for line in parts:
                        if line.strip():
                            if not logged_first_rx:
                                print(f"[Serial RX] First line from {target_port}: {line.strip()!r}")
                                logged_first_rx = True
                            store.ingest_line(line)
                elif len(buf) > 512:
                    store.ingest_line(buf)
                    buf = ""

        except (serial.SerialException, OSError) as exc:
            print(f"[Serial] Disconnected from {target_port}: {exc}. Retrying in 2s...")
            store.set_connection("Disconnected", target_port)
            store.reconnect_event.wait(2.0)
        except Exception as exc:
            print(f"[Serial] Unexpected error: {exc}. Retrying in 2s...")
            store.set_connection("Disconnected", target_port)
            store.reconnect_event.wait(2.0)
        finally:
            if ser is not None:
                try:
                    ser.close()
                except Exception:
                    pass


def demo_worker(store: FireGuardStore, stop_event: threading.Event) -> None:
    """Generates realistic FireGuard startup and multi-phase hazard telemetry."""
    store.set_connection("Demo", "DEMO")
    store.ingest_line("Warm-up: 5s")
    for _ in range(10):
        if stop_event.is_set():
            return
        time.sleep(0.5)
    store.ingest_line("Baseline: 280 | Threshold: 380")
    store.ingest_line("FIREGUARD READY")

    tick = 0
    while not stop_event.is_set():
        cycle = tick % 64
        base = store.baseline
        thresh = store.threshold

        mq2 = base + int(round(math.sin(tick * 0.35) * 14))
        gas = "NORMAL"
        ir = "NORMAL"
        servo = int(round(90 + math.sin(tick * 0.25) * 65))
        mist = "OFF"
        alarm = "CLEAR"

        if 14 <= cycle < 28:
            progress = (cycle - 14) / 14.0
            mq2 = int(round(thresh + 25 + progress * 140))
            gas = "ALERT"
            alarm = "ACTIVE"
        elif 28 <= cycle < 46:
            mq2 = int(round(thresh + 230 + math.sin(tick) * 20))
            gas = "ALERT"
            ir = "DETECTED"
            servo = 112
            mist = "ON"
            alarm = "ACTIVE"
        elif 46 <= cycle < 54:
            decay = (cycle - 46) / 8.0
            mq2 = int(round(thresh + 60 * (1.0 - decay)))
            gas = "ALERT" if mq2 >= thresh else "NORMAL"
            ir = "NORMAL"
            servo = 112 + (cycle - 46) * 4
            mist = "ON" if cycle < 50 else "OFF"
            alarm = "ACTIVE" if gas == "ALERT" else "CLEAR"

        mq2 = max(0, min(1023, mq2))
        servo = max(15, min(165, servo))
        line = (
            f"MQ2: {mq2} | GAS: {gas} | IR: {ir} | "
            f"SERVO: {servo} | MIST: {mist} | ALARM: {alarm}"
        )
        store.ingest_line(line)
        tick += 1
        stop_event.wait(0.5)


# ---------------------------------------------------------------------------
# Flask App & Routes
# ---------------------------------------------------------------------------
store = FireGuardStore()
app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/latest")
def api_latest():
    return jsonify(store.get_latest_payload())


@app.route("/api/history")
def api_history():
    try:
        seconds = int(request.args.get("seconds", 60))
    except (TypeError, ValueError):
        seconds = 60
    return jsonify(store.get_history_payload(seconds))


@app.route("/api/events")
def api_events():
    try:
        limit = int(request.args.get("limit", 100))
    except (TypeError, ValueError):
        limit = 100
    ev_type = str(request.args.get("type", ""))[:64]
    return jsonify(store.get_events_payload(limit, ev_type))


@app.route("/api/report")
def api_report():
    return jsonify(store.get_report_payload())


@app.route("/api/export/readings.csv")
def api_export_readings():
    store._ensure_csv_headers()
    return send_file(
        READINGS_CSV,
        mimetype="text/csv",
        as_attachment=True,
        download_name="fireguard-readings.csv",
    )


@app.route("/api/export/events.csv")
def api_export_events():
    store._ensure_csv_headers()
    return send_file(
        EVENTS_CSV,
        mimetype="text/csv",
        as_attachment=True,
        download_name="fireguard-events.csv",
    )


@app.route("/api/settings", methods=["POST"])
def api_settings():
    payload = request.get_json(silent=True) or {}
    try:
        threshold = int(payload.get("threshold", store.threshold))
        critical_level = int(payload.get("critical_level", store.critical_level))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid numeric values for settings."}), 400

    if not (1 <= threshold <= 1023) or not (1 <= critical_level <= 1023):
        return jsonify({"error": "Thresholds must be between 1 and 1023."}), 400
    if critical_level < threshold:
        return jsonify({"error": "Critical gas level must be >= warning threshold."}), 400

    store.update_settings(threshold, critical_level)
    return jsonify(
        {
            "ok": True,
            "threshold": store.threshold,
            "critical_level": store.critical_level,
        }
    )


@app.route("/api/clear", methods=["POST"])
def api_clear():
    store.clear_all()
    return jsonify({"ok": True})


@app.route("/api/ports")
def api_ports():
    ports = [
        {"device": p.device, "description": p.description or ""}
        for p in serial.tools.list_ports.comports()
    ]
    return jsonify({"ports": ports, "active_port": store.active_port, "baud": store.baud_rate})


@app.route("/api/serial", methods=["POST"])
def api_serial():
    if store.demo_mode:
        return jsonify({"error": "Cannot change serial settings in Demo mode."}), 400
    payload = request.get_json(silent=True) or {}
    allowed_bauds = (9600, 19200, 38400, 57600, 115200, 230400)
    try:
        baud = int(payload.get("baud", store.baud_rate))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid baud rate."}), 400
    if baud not in allowed_bauds:
        return jsonify({"error": "Unsupported baud rate."}), 400

    port_val = payload.get("port", store.configured_port)
    if port_val is not None:
        port_val = str(port_val).strip()[:64] or None

    with store.lock:
        store.baud_rate = baud
        if "port" in payload:
            store.configured_port = port_val
    store.reconnect_event.set()
    return jsonify({"ok": True, "port": store.configured_port, "baud": store.baud_rate})


# ---------------------------------------------------------------------------
# Entry Point
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="FireGuard Monitor Flask + pyserial Server")
    parser.add_argument("--port", default=None, help="Serial port (e.g. COM3 or /dev/ttyACM0)")
    parser.add_argument("--baud", type=int, default=115200, help="Serial baud rate (default: 115200)")
    parser.add_argument("--demo", action="store_true", help="Run with simulated FireGuard sensor data")
    parser.add_argument("--host", default="0.0.0.0", help="Web server host (default: 0.0.0.0)")
    parser.add_argument("--web-port", type=int, default=5000, help="Web server port (default: 5000)")
    args = parser.parse_args()

    store.baud_rate = args.baud
    store.demo_mode = bool(args.demo)

    _, selected_port = list_and_detect_port(args.port)
    store.configured_port = selected_port

    stop_event = threading.Event()
    if args.demo:
        print("[Mode] Starting in DEMO simulation mode")
        worker = threading.Thread(target=demo_worker, args=(store, stop_event), daemon=True)
    else:
        if selected_port:
            print(f"[Serial] Target port: {selected_port} @ {args.baud} baud")
        else:
            print("[Serial] No port specified or detected yet; background scanner will keep checking.")
        worker = threading.Thread(target=serial_worker, args=(store, stop_event), daemon=True)

    worker.start()

    print(f"[Web] FireGuard Monitor running at http://localhost:{args.web_port}")
    try:
        app.run(host=args.host, port=args.web_port, threaded=True, debug=False, use_reloader=False)
    finally:
        stop_event.set()


if __name__ == "__main__":
    main()
