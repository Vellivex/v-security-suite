"""BrowserStack App Automate transport. Only reviewed endpoints ever receive credentials."""
import base64
import hashlib
import json
import os
import re
import runpy
import secrets
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from device import Device, DeviceError, token

API = "https://api-cloud.browserstack.com/app-automate"
HUB = "https://hub-cloud.browserstack.com/wd/hub"
MODELS = {"A": ("Google Pixel 7", "13.0"), "B": ("Google Pixel 8", "14.0")}
PRIVACY = {"appiumVersion": "2.18.0", "video": False, "debug": False, "appiumLogs": False,
           "deviceLogs": False, "networkLogs": False, "maskCommands": "setValues,getValues,screenshot"}
CANARY_LABEL = "Continue with email"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def physical_release(profile):
    if profile not in {"alpha08-release", "alpha09-release"}:
        raise DeviceError("unsupported physical release profile")
    validator = Path(__file__).resolve().parents[1] / "live-release-profile.py"
    return runpy.run_path(str(validator))["load_manifest"](profile)


class Provider:
    def __init__(self):
        self.release = physical_release(os.environ.get("VELLIVEX_PHYSICAL_RELEASE", "alpha08-release"))
        pair = [os.environ.get(k, "") for k in ("BROWSERSTACK_USERNAME", "BROWSERSTACK_ACCESS_KEY")]
        if not all(pair):
            raise DeviceError("private BrowserStack environment is missing credentials")
        self.authorization = "Basic " + base64.b64encode(":".join(pair).encode()).decode()
        self.http = build_opener(NoRedirect())

    def request(self, origin, method, path, body=None, mime="application/json", *, raw=False):
        if origin not in {API, HUB} or not re.fullmatch(r"/[A-Za-z0-9._/-]+", path):
            raise DeviceError("unsupported provider endpoint")
        req = Request(origin + path, data=body, method=method, headers={
            "Authorization": self.authorization, "Content-Type": mime, "Accept": "*/*"})
        try:
            with self.http.open(req, timeout=120) as response:
                content = response.read(12_000_001)
            if len(content) > 12_000_000:
                raise DeviceError("provider response too large")
            return content if raw else json.loads(content)
        except (HTTPError, URLError, TimeoutError, ValueError):
            # Remote responses and WebDriver diagnostics may echo submitted text.
            raise DeviceError("provider request failed") from None

    def hub(self, method, path, payload=None):
        body = json.dumps(payload).encode() if payload is not None else None
        reply = self.request(HUB, method, path, body)
        value = reply.get("value")
        if isinstance(value, dict) and "error" in value:
            raise DeviceError("remote operation failed")
        return value

    def capacity(self):
        plan = self.request(API, "GET", "/plan.json")
        used, maximum, team, queued = (plan.get(k) for k in ("parallel_sessions_running",
            "parallel_sessions_max_allowed", "team_parallel_sessions_max_allowed", "queued_sessions"))
        if (not all(type(n) is int and n >= 0 for n in (used, maximum, team, queued)) or queued or
                min(maximum, team) - used < 2):
            raise DeviceError("two free physical device slots are unavailable")
        inventory = self.request(API, "GET", "/devices.json")
        available = {(v.get("device"), str(v.get("os_version")).split(".")[0])
                     for v in inventory if str(v.get("os")).lower() == "android" and
                     str(v.get("realMobile", v.get("real_mobile"))).lower() == "true"}
        if any((model, os_version.split(".")[0]) not in available for model, os_version in MODELS.values()):
            raise DeviceError("the two requested stock Pixel configurations are unavailable")

    def upload(self, apk):
        data = apk.read_bytes()
        if len(data) != self.release["app_bytes"] or hashlib.sha256(data).hexdigest() != self.release["app_sha256"]:
            raise DeviceError("incorrect installer")
        boundary = "vellivex" + secrets.token_hex(16)
        prefix = ("--" + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="messenger.apk"\r\n'
                  "Content-Type: application/vnd.android.package-archive\r\n\r\n").encode()
        body = prefix + data + ("\r\n--" + boundary + "--\r\n").encode()
        # Upload bytes, omitting BrowserStack's opt-in package patching/screen bypass.
        result = self.request(API, "POST", "/upload", body, "multipart/form-data; boundary=" + boundary)
        app = result.get("app_url", "")
        if not re.fullmatch(r"bs://[0-9a-f]{40}", app):
            raise DeviceError("upload identity unavailable")
        return app

    def start(self, role, app, build):
        model, version = MODELS[role]
        options = dict(PRIVACY, deviceName=model, osVersion=version, projectName="Vellivex Messenger",
                       buildName=build, sessionName="Controlled phone " + role, idleTimeout=300)
        # printPageSourceOnFindFailure=false, no UI snapshots or proxying of production traffic.
        caps = {"platformName": "Android", "appium:automationName": "UiAutomator2", "appium:app": app,
                "appium:deviceName": model, "appium:platformVersion": version,
                "appium:printPageSourceOnFindFailure": False, "appium:newCommandTimeout": 300,
                "bstack:options": options}
        val = self.hub("POST", "/session", {"capabilities": {"alwaysMatch": caps, "firstMatch": [{}]}})
        device = Device(self, token(val["sessionId"]))
        device.reported_capabilities = val.get("capabilities", {})
        return device

    def describe(self, device, role, app, build):
        fact = self.request(API, "GET", "/sessions/" + device.session + ".json")["automation_session"]
        model, version = MODELS[role]
        if (fact.get("hashed_id") != device.session or fact.get("os", "").lower() != "android" or
            fact.get("device") != model or str(fact.get("os_version")).split(".")[0] != version.split(".")[0] or
            fact.get("build_name") != build or (fact.get("app_details") or {}).get("app_url") != app):
            raise DeviceError("provider session identity failed verification")
        route = urlsplit(fact.get("logs", ""))
        match = re.fullmatch(r"/builds/([0-9a-f]{40})/sessions/([0-9a-f]{40})/logs", route.path)
        if route.hostname != "app-automate.browserstack.com" or not match or match[2] != device.session:
            raise DeviceError("provider evidence identity failed verification")
        return fact, match[1]

    @staticmethod
    def effective_privacy(device):
        def confirmed(reported):
            if not isinstance(reported, dict):
                return False
            nested = reported.get("bstack:options", {})
            if not isinstance(nested, dict):
                return False
            def option(name):
                return nested.get(name, reported.get("browserstack." + name))
            for name in ("video", "debug", "appiumLogs", "deviceLogs", "networkLogs"):
                value = option(name)
                if value is not False and value != "false":
                    return False
            mask = option("maskCommands")
            if isinstance(mask, str):
                mask = [v.strip() for v in mask.split(",")]
            return isinstance(mask, list) and {"setValues", "getValues", "screenshot"}.issubset(mask)

        # Query the actual provider session if the initial response omitted
        # vendor options. Neither verification path consults our desired flags.
        if not confirmed(device.reported_capabilities):
            current = device.transport.hub("GET", "/session/" + device.session)
            if not confirmed(current):
                raise DeviceError("effective capture suppression and command masking unverified")

    def captures_disabled(self, fact, build_id, session):
        # Some accounts include static log links even when capture is disabled.
        # Query only canonical per-session API paths, before any private entry.
        checks = {"appium_logs_url": "appiumlogs", "device_logs_url": "devicelogs", "har_logs_url": "networklogs"}
        for field, suffix in checks.items():
            if not fact.get(field):
                continue
            path = f"/builds/{build_id}/sessions/{session}/{suffix}"
            url = urlsplit(fact[field])
            if url.scheme != "https" or url.netloc != "api-cloud.browserstack.com" or url.path != "/app-automate" + path:
                return False
            req = Request(API + path, headers={"Authorization": self.authorization})
            try:
                with self.http.open(req, timeout=10) as response:
                    # A non-empty capture, unrecognized status, or unauthorized
                    # probe is not proof of disabled capture.
                    if response.read(1):
                        return False
            except HTTPError as err:
                if err.code not in {404, 410}:
                    return False
            except (URLError, TimeoutError):
                return False
        if fact.get("video_url"):
            video = urlsplit(fact["video_url"])
            if (video.scheme != "https" or video.netloc != "app-automate.browserstack.com" or
                    video.path != f"/sessions/{session}/video"):
                return False
            try:
                # HEAD only, with no Basic credentials and no redirect following.
                with self.http.open(Request(fact["video_url"], method="HEAD"), timeout=10):
                    return False
            except HTTPError as err:
                if err.code not in {404, 410}:
                    return False
            except (URLError, TimeoutError):
                return False
        return True

    @staticmethod
    def masked_round_trip(text):
        # The documented text stream uses one REQUEST line and its RESPONSE.
        # Tie the read and write to the same element and do not let a following
        # command's redaction establish that this command concealed anything.
        written, retrieved = set(), set()
        pending = None
        for line in text.splitlines():
            if re.search(r"\bREQUEST\b", line, re.I):
                pending = None
                match = re.search(r"\b(POST|GET)\s+(?:/wd/hub)?/session/[A-Za-z0-9-]+/"
                                  r"element/([A-Za-z0-9-]+)/(value|text)(?:\s|$)(.*)", line, re.I)
                if match:
                    method, identity, command, payload = match.groups()
                    if method.upper() == "POST" and command.lower() == "value" and "redacted" in payload.lower():
                        written.add(identity)
                    if method.upper() == "GET" and command.lower() == "text":
                        pending = identity
            elif re.search(r"\bRESPONSE\b", line, re.I):
                if pending and "redacted" in line.lower():
                    retrieved.add(pending)
                pending = None
        return bool(written & retrieved)

    def audit_canary(self, device, role, app, build, sentinel, live=False):
        last = time.monotonic() + 65
        while time.monotonic() < last:
            fact, build_id = self.describe(device, role, app, build)
            path = "/builds/" + build_id + "/sessions/" + device.session
            logs = self.request(API, "GET", path + "/logs", raw=True)
            if sentinel.encode() in logs or any(x.encode() in logs for x in (sentinel[:14], sentinel[-14:])):
                raise DeviceError("provider canary exposed test data")
            text = logs.decode("utf-8", "replace").lower()
            status = str(fact.get("status", "")).lower()
            if self.masked_round_trip(text) and status in ({"running"} if live else {"done", "passed"}):
                # Corroborate the effective settings using the provider metadata.
                if not self.captures_disabled(fact, build_id, device.session):
                    raise DeviceError("provider still advertises a disabled capture")
                return {"role": role, "device": MODELS[role][0], "os": MODELS[role][1],
                        "settings": PRIVACY, "test_entry_and_readback_redacted": True,
                        "checked_while_running": live}
            time.sleep(3)
        raise DeviceError("provider privacy evidence incomplete")
