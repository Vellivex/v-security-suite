#!/usr/bin/env python3
"""Validate two tcp_persist instrumentation series against controlled receipts.

Usage: vguard-persistent-check.py SELECTED_LOG CONTROL_LOG SERVER_LOG \
    BEFORE_ACTIVATION_MS ACTIVE_MS BEFORE_STOP_MS

Times must share Android elapsedRealtime's clock. Each attempt must expose
started_at_ms and ended_at_ms. A complete SERIES_COMPLETE result is mandatory.
SERVER_LOG must be a snapshot taken before Stop, while the VPN is still active.
Receipts and outcomes are asserted only in baseline/settled-active windows;
the full series is parsed for structural integrity, not post-stop recovery.
tcp_persist must retain its original socket; this checker checks the mode, while
the probe implementation is responsible for never reconnecting it.
"""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import re
import sys


class InvalidEvidence(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise InvalidEvidence(message)


def number(value, label):
    require(isinstance(value, str) and re.fullmatch(r"[0-9]+", value) is not None,
            f"{label}: expected nonnegative integer")
    return int(value)


def parse_instrumentation(text, label):
    records, pending, summary = [], {}, {}
    final_seen = False
    result_seen = False
    for line_no, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        where = f"{label}:{line_no}"
        if not line:
            continue
        if line.startswith("INSTRUMENTATION_STATUS: "):
            require(not final_seen and not result_seen, f"{where}: status after final result")
            item = line[len("INSTRUMENTATION_STATUS: "):]
            require("=" in item, f"{where}: malformed status")
            key, value = item.split("=", 1)
            require(key and key not in pending, f"{where}: duplicate/empty status key {key!r}")
            pending[key] = value
        elif line.startswith("INSTRUMENTATION_STATUS_CODE:"):
            require(not final_seen and not result_seen and pending,
                    f"{where}: status terminator without pending record")
            require(line.split(":", 1)[1].strip() == "0", f"{where}: nonzero status code")
            records.append(pending)
            pending = {}
        elif line.startswith("INSTRUMENTATION_RESULT: "):
            require(not final_seen and not pending, f"{where}: result after final/incomplete record")
            result_seen = True
            item = line[len("INSTRUMENTATION_RESULT: "):]
            require("=" in item, f"{where}: malformed result")
            key, value = item.split("=", 1)
            require(key and key not in summary, f"{where}: duplicate/empty result key {key!r}")
            summary[key] = value
        elif line.startswith("INSTRUMENTATION_CODE:"):
            require(not final_seen and not pending and summary,
                    f"{where}: premature/duplicate final terminator")
            require(line.split(":", 1)[1].strip() == "0", f"{where}: unsuccessful instrumentation")
            final_seen = True
        else:
            # Dedicated logs must contain probe output only. In particular, do not
            # overlook adb failures, truncated instrumentation, or continuation text.
            raise InvalidEvidence(f"{where}: unrecognized log line")
    require(not pending, f"{label}: unterminated status record")
    require(final_seen, f"{label}: missing final instrumentation completion")
    require(records, f"{label}: no attempt records")
    require(summary.get("mode") == "tcp_persist", f"{label}: final mode is not tcp_persist")
    require(summary.get("outcome") == "SERIES_COMPLETE", f"{label}: series did not complete")
    package = summary.get("test_package", "")
    require(re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+", package),
            f"{label}: invalid package")
    previous_end = -1
    outcomes = Counter()
    tokens = set()
    for index, record in enumerate(records, 1):
        where = f"{label}:attempt {index}"
        require(record.get("mode") == "tcp_persist", f"{where}: reconnect-capable/wrong mode")
        require(record.get("test_package") == package, f"{where}: inconsistent package")
        require(number(record.get("attempt"), where + " attempt") == index,
                f"{where}: missing/duplicate/nonsequential attempt")
        token = record.get("test_token", "")
        require(token.startswith(package + ":") and len(token) > len(package) + 1
                and len(token) <= 200 and all(33 <= ord(c) <= 126 for c in token),
                f"{where}: invalid unique token")
        require(token not in tokens, f"{where}: repeated test token")
        tokens.add(token)
        start = number(record.get("started_at_ms"), where + " started_at_ms")
        end = number(record.get("ended_at_ms"), where + " ended_at_ms")
        require(previous_end <= start <= end, f"{where}: overlapping/reversed attempt timestamps")
        previous_end = end
        record["start"] = start
        record["end"] = end
        outcome = record.get("outcome")
        require(outcome in ("CONNECTED", "NO_CONNECTION", "UNEXPECTED_RESPONSE"),
                f"{where}: unsupported outcome {outcome!r}")
        outcomes[outcome] += 1
    for field, expected in (("attempts", len(records)), ("connected", outcomes["CONNECTED"]),
                            ("no_connection", outcomes["NO_CONNECTION"]),
                            ("unexpected", outcomes["UNEXPECTED_RESPONSE"])):
        require(number(summary.get(field), label + " summary " + field) == expected,
                f"{label}: inconsistent summary {field}")
    return package, records


def parse_receipts(text):
    receipts = defaultdict(list)
    for line_no, raw in enumerate(text.splitlines(), 1):
        if not raw.strip():
            continue
        try:
            item = json.loads(raw)
        except (ValueError, TypeError) as exc:
            raise InvalidEvidence(f"server:{line_no}: malformed JSON") from exc
        require(isinstance(item, dict) and isinstance(item.get("protocol"), str),
                f"server:{line_no}: malformed protocol record")
        if "token" in item:
            require(isinstance(item["token"], str) and item["token"],
                    f"server:{line_no}: malformed receipt token")
            receipts[item["token"]].append(item["protocol"])
    return receipts


def check(selected_text, control_text, server_text, before_activation_ms, active_ms, before_stop_ms):
    require(0 <= before_activation_ms <= active_ms < before_stop_ms,
            "invalid activation/stop timestamp ordering")
    require(active_ms + 1000 < before_stop_ms, "no settled active observation window")
    selected_package, selected = parse_instrumentation(selected_text, "selected")
    control_package, control = parse_instrumentation(control_text, "control")
    require(selected_package != control_package, "selected and control must be distinct packages")
    all_tokens = [r["test_token"] for r in selected + control]
    require(len(all_tokens) == len(set(all_tokens)), "tokens reused across series")
    receipts = parse_receipts(server_text)
    counts = {}
    for label, records in (("selected", selected), ("control", control)):
        baseline = [r for r in records if r["end"] < before_activation_ms]
        active = [r for r in records
                  if r["start"] >= active_ms + 1000 and r["end"] < before_stop_ms]
        require(len(baseline) >= 2, f"{label}: fewer than two baseline attempts")
        require(len(active) >= 2, f"{label}: fewer than two settled active attempts")
        for record in records:
            token = record["test_token"]
            receipt = receipts.get(token, [])
            # The server snapshot predates Stop. Even a request whose read ends
            # after Stop is a proven active leak if its active-origin token is
            # already present in that snapshot. Post-stop delivery is not here.
            if label == "selected" and active_ms <= record["start"] < before_stop_ms:
                require(not receipt, f"selected: active receipt/leak at attempt {record['attempt']}")
        for record in baseline:
            require(record["outcome"] == "CONNECTED",
                    f"{label}: baseline attempt {record['attempt']} did not connect")
            require(receipts.get(record["test_token"], []) == ["tcp"],
                    f"{label}: CONNECTED attempt {record['attempt']} lacks exactly one TCP receipt")
        for record in active:
            expected = "NO_CONNECTION" if label == "selected" else "CONNECTED"
            require(record["outcome"] == expected,
                    f"{label}: active attempt {record['attempt']} expected {expected}")
            if label == "selected":
                require(not receipts.get(record["test_token"]),
                        f"selected: active receipt/leak at attempt {record['attempt']}")
            else:
                require(receipts.get(record["test_token"], []) == ["tcp"],
                        f"{label}: CONNECTED attempt {record['attempt']} lacks exactly one TCP receipt")
        counts[label] = {"baseline": len(baseline), "active": len(active), "total": len(records)}
    return {"status": "PASS", "mode": "tcp_persist", "counts": counts,
            "before_activation_ms": before_activation_ms, "active_ms": active_ms,
            "before_stop_ms": before_stop_ms,
            "scope": "existing socket blocked during VPN; control preserved; no post-stop recovery claim"}


def self_test():
    import unittest

    def sample(label, outcomes=None, times=None):
        outcomes = outcomes or (["CONNECTED"] * 2 + (["NO_CONNECTION"] * 2 if label == "selected"
                                                   else ["CONNECTED"] * 2))
        times = times or [(100, 200), (300, 400), (3100, 3200), (3300, 3400)]
        package = "app.vguard.qa." + label
        records = []
        for attempt, (outcome, (start, end)) in enumerate(zip(outcomes, times), 1):
            records.append({"attempt": str(attempt), "mode": "tcp_persist", "test_package": package,
                            "test_token": package + ":token" + str(attempt), "outcome": outcome,
                            "started_at_ms": str(start), "ended_at_ms": str(end)})
        return records

    def render(records, complete=True):
        lines = []
        for record in records:
            lines.extend("INSTRUMENTATION_STATUS: " + k + "=" + v for k, v in record.items())
            lines.append("INSTRUMENTATION_STATUS_CODE: 0")
        if complete:
            summary = {"mode": "tcp_persist", "test_package": records[0]["test_package"],
                       "outcome": "SERIES_COMPLETE", "attempts": str(len(records)),
                       "connected": str(sum(r["outcome"] == "CONNECTED" for r in records)),
                       "no_connection": str(sum(r["outcome"] == "NO_CONNECTION" for r in records)),
                       "unexpected": str(sum(r["outcome"] not in ("CONNECTED", "NO_CONNECTION") for r in records))}
            lines.extend("INSTRUMENTATION_RESULT: " + k + "=" + v for k, v in summary.items())
            lines.append("INSTRUMENTATION_CODE: 0")
        return "\n".join(lines) + "\n"

    class Cases(unittest.TestCase):
        def setUp(self):
            self.selected, self.control = sample("selected"), sample("control")
            self.receipts = [{"protocol": "tcp", "token": r["test_token"]}
                             for r in self.selected + self.control if r["outcome"] == "CONNECTED"]

        def run_check(self, selected_text=None, control_text=None, server_text=None):
            return check(selected_text if selected_text is not None else render(self.selected),
                         control_text if control_text is not None else render(self.control),
                         server_text if server_text is not None else "\n".join(map(json.dumps, self.receipts)),
                         1000, 2000, 5000)

        def test_valid(self):
            self.assertEqual(self.run_check()["status"], "PASS")

        def test_active_leak_despite_no_connection(self):
            self.receipts.append({"protocol": "tcp", "token": self.selected[2]["test_token"]})
            with self.assertRaisesRegex(InvalidEvidence, "leak"):
                self.run_check()

        def test_unexpected_outcome(self):
            self.selected[2]["outcome"] = "UNEXPECTED_RESPONSE"
            with self.assertRaisesRegex(InvalidEvidence, "expected NO_CONNECTION"):
                self.run_check()

        def test_unexpected_baseline_outcome(self):
            self.selected[0]["outcome"] = "UNEXPECTED_RESPONSE"
            with self.assertRaisesRegex(InvalidEvidence, "baseline.*did not connect"):
                self.run_check()

        def test_unknown_outcome(self):
            self.selected[2]["outcome"] = "PROBE_ERROR"
            with self.assertRaisesRegex(InvalidEvidence, "unsupported outcome"):
                self.run_check()

        def test_no_baseline(self):
            for record in self.selected:
                record["started_at_ms"] = str(int(record["started_at_ms"]) + 1000)
                record["ended_at_ms"] = str(int(record["ended_at_ms"]) + 1000)
            with self.assertRaisesRegex(InvalidEvidence, "baseline"):
                self.run_check()

        def test_insufficient_active_window(self):
            self.selected[3]["ended_at_ms"] = "5000"
            with self.assertRaisesRegex(InvalidEvidence, "settled active"):
                self.run_check()

        def test_missing_receipt(self):
            self.receipts.pop()
            with self.assertRaisesRegex(InvalidEvidence, "exactly one TCP receipt"):
                self.run_check()

        def test_duplicate_receipt(self):
            self.receipts.append(self.receipts[0])
            with self.assertRaisesRegex(InvalidEvidence, "exactly one TCP receipt"):
                self.run_check()

        def test_control_blocked(self):
            self.control[2]["outcome"] = "NO_CONNECTION"
            with self.assertRaisesRegex(InvalidEvidence, "expected CONNECTED"):
                self.run_check()

        def test_connected_selected(self):
            self.selected[2]["outcome"] = "CONNECTED"
            self.receipts.append({"protocol": "tcp", "token": self.selected[2]["test_token"]})
            with self.assertRaisesRegex(InvalidEvidence, "leak"):
                self.run_check()

        def test_wrong_mode(self):
            self.selected[2]["mode"] = "tcp"
            with self.assertRaisesRegex(InvalidEvidence, "wrong mode"):
                self.run_check()

        def test_truncated_status(self):
            with self.assertRaisesRegex(InvalidEvidence, "unterminated"):
                self.run_check(selected_text=render(self.selected, False).rsplit("INSTRUMENTATION_STATUS_CODE:", 1)[0])

        def test_missing_final_completion(self):
            with self.assertRaisesRegex(InvalidEvidence, "missing final"):
                self.run_check(selected_text=render(self.selected, False))

        def test_bad_timestamp(self):
            self.selected[2]["started_at_ms"] = "NaN"
            with self.assertRaisesRegex(InvalidEvidence, "integer"):
                self.run_check()

        def test_missing_timestamp(self):
            del self.selected[2]["ended_at_ms"]
            with self.assertRaisesRegex(InvalidEvidence, "integer"):
                self.run_check()

        def test_duplicate_status_key(self):
            text = render(self.selected).replace("INSTRUMENTATION_STATUS: mode=tcp_persist",
                    "INSTRUMENTATION_STATUS: mode=tcp_persist\nINSTRUMENTATION_STATUS: mode=tcp_persist", 1)
            with self.assertRaisesRegex(InvalidEvidence, "duplicate"):
                self.run_check(selected_text=text)

        def test_bad_server_json(self):
            with self.assertRaisesRegex(InvalidEvidence, "malformed JSON"):
                self.run_check(server_text="{truncated")

        def test_summary_mismatch(self):
            text = render(self.selected).replace("INSTRUMENTATION_RESULT: attempts=4", "INSTRUMENTATION_RESULT: attempts=5")
            with self.assertRaisesRegex(InvalidEvidence, "inconsistent summary"):
                self.run_check(selected_text=text)

        def test_poststop_selected_recovery_not_required(self):
            record = dict(self.selected[-1], attempt="5", test_token="app.vguard.qa.selected:token5",
                          started_at_ms="5100", ended_at_ms="5200", outcome="NO_CONNECTION")
            self.selected.append(record)
            self.assertEqual(self.run_check()["status"], "PASS")

        def test_poststop_unexpected_accepted(self):
            self.selected.append(dict(self.selected[-1], attempt="5",
                test_token="app.vguard.qa.selected:token5", started_at_ms="5100",
                ended_at_ms="5200", outcome="UNEXPECTED_RESPONSE"))
            self.assertEqual(self.run_check()["status"], "PASS")

        def test_poststop_connected_without_snapshot_receipt_accepted(self):
            self.selected.append(dict(self.selected[-1], attempt="5",
                test_token="app.vguard.qa.selected:token5", started_at_ms="5100",
                ended_at_ms="5200", outcome="CONNECTED"))
            self.assertEqual(self.run_check()["status"], "PASS")

        def test_active_origin_receipt_even_if_read_ends_after_stop(self):
            self.selected.append(dict(self.selected[-1], attempt="5",
                test_token="app.vguard.qa.selected:token5", started_at_ms="4900",
                ended_at_ms="5200", outcome="UNEXPECTED_RESPONSE"))
            self.receipts.append({"protocol": "tcp", "token": self.selected[-1]["test_token"]})
            with self.assertRaisesRegex(InvalidEvidence, "leak"):
                self.run_check()

    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Cases))
    return 0 if result.wasSuccessful() else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("inputs", nargs="*", metavar="INPUT")
    args = parser.parse_args()
    if args.self_test:
        if args.inputs:
            parser.error("--self-test takes no other inputs")
        return self_test()
    if len(args.inputs) != 6:
        parser.error("expected SELECTED_LOG CONTROL_LOG SERVER_LOG BEFORE_ACTIVATION_MS ACTIVE_MS BEFORE_STOP_MS")
    try:
        selected, control, server = [Path(path).read_text(encoding="utf-8", errors="strict") for path in args.inputs[:3]]
        times = [number(value, label) for value, label in zip(args.inputs[3:],
                 ("before_activation_ms", "active_ms", "before_stop_ms"))]
        print(json.dumps(check(selected, control, server, *times), sort_keys=True))
        return 0
    except (InvalidEvidence, OSError, UnicodeError) as exc:
        print("FAIL: " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
