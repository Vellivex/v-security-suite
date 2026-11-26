"""Small Appium client for the signed Messenger test. Never dumps pages or remote errors."""
import ast
import json
import re
import time
import threading
from pathlib import Path

PACKAGE = "com.vellivex.messenger.alpha"
ELEMENT = "element-6066-11e4-a52e-4f735466cecf"
PATTERNS = {
    "contact": r"@[A-Za-z0-9_.=+/\-]+:[A-Za-z0-9.:\[\]\-]+",
    "recovery": r"[1-9A-HJ-NP-Za-km-z\s]{40,192}",
    "sas": r".+  .+",
    "witness": r"VVXQA-[a-zA-Z0-9-]{3,90}",
}


# A peer ID, OTP, recovery key or message can never become a WebDriver selector.
def reviewed_labels():
    flow = ast.parse(Path(__file__).with_name("flow.py").read_text(encoding="utf-8"))
    methods = {"find_text", "find_desc", "has_text", "has_desc", "tap_text"}
    return frozenset(node.args[0].value for node in ast.walk(flow)
                     if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                     and node.func.attr in methods and node.args and isinstance(node.args[0], ast.Constant)
                     and isinstance(node.args[0].value, str))


LABELS = reviewed_labels()


class DeviceError(RuntimeError):
    pass


def token(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9-]{8,128}", value):
        raise DeviceError("provider returned an invalid object ID")
    return value


class Element:
    def __init__(self, device, identity):
        self.device = device
        self.path = "element/" + token(identity)

    def click(self):
        self.device.command("POST", self.path + "/click", {})

    def clear(self):
        self.device.command("POST", self.path + "/clear", {})

    def send(self, value):
        # Only standard W3C sendKeys and getText have verified provider masking.
        self.device.command("POST", self.path + "/value", {"text": value})

    def text(self):
        val = self.device.command("GET", self.path + "/text")
        if not isinstance(val, str):
            raise DeviceError("expected text response")
        return val

    def attribute(self, name):
        if name not in {"enabled", "displayed", "clickable", "className"}:
            raise DeviceError("unsupported attribute")
        val = self.device.command("GET", self.path + "/attribute/" + name)
        if name == "className":
            return val
        if val in (True, "true"):
            return True
        if val in (False, "false"):
            return False
        raise DeviceError("unexpected boolean attribute")


class Device:
    def __init__(self, transport, session):
        self.transport = transport
        self.session = token(session)
        self._lock = threading.RLock()
        self._last_command = time.monotonic()

    def command(self, method, route, value=None):
        with self._lock:
            reply = self.transport.hub(method, "/session/" + self.session + "/" + route, value)
            self._last_command = time.monotonic()
            return reply

    def keep_alive(self, stop):
        while not stop.wait(15):
            with self._lock:
                if time.monotonic() - self._last_command > 25:
                    try:
                        self.command("GET", "appium/device/current_package")
                    except DeviceError:
                        # The next real UI operation will report a sanitized failure.
                        return

    def elements(self, strategy, selector):
        values = self.command("POST", "elements", {"using": strategy, "value": selector})
        if not isinstance(values, list):
            raise DeviceError("invalid element collection")
        return [Element(self, obj[ELEMENT]) for obj in values]

    def grouped(self, suffix):
        selector = "new UiSelector().packageName(" + json.dumps(PACKAGE) + ")." + suffix
        return self.elements("-android uiautomator", selector)

    def find_all(self, class_name):
        if class_name not in {"android.widget.EditText", "android.widget.TextView"}:
            raise DeviceError("unsupported UI class")
        return self.grouped("className(" + json.dumps(class_name) + ")")

    def find_pattern(self, kind):
        pattern = PATTERNS[kind]
        # UiAutomator2's selector parser removes the surrounding quotes but
        # preserves regex backslashes. JSON-escaping the regex here would
        # double those slashes before WebDriver performs its normal encoding.
        if any(ch in pattern for ch in ('"', "\n", "\r")):
            raise DeviceError("unsupported pattern syntax")
        return self.grouped('textMatches("' + pattern + '")')

    def _label(self, label, desc):
        if label not in LABELS:
            raise DeviceError("unreviewed label")
        return self.grouped(("description" if desc else "text") + "(" + json.dumps(label) + ")")

    def _visible(self, lookup, timeout):
        until = time.monotonic() + timeout
        while True:
            matching = [element for element in lookup() if element.attribute("displayed")]
            if matching:
                return matching[0]
            if time.monotonic() >= until:
                return None
            time.sleep(.35)

    def find_text(self, label, timeout=30):
        node = self._visible(lambda: self._label(label, False), timeout)
        if node is None:
            raise DeviceError("expected screen label missing")
        return node

    def find_desc(self, label, timeout=30):
        node = self._visible(lambda: self._label(label, True), timeout)
        if node is None:
            raise DeviceError("expected described control missing")
        return node

    def has_text(self, label, timeout=0):
        return self._visible(lambda: self._label(label, False), timeout) is not None

    def has_desc(self, label, timeout=0):
        return self._visible(lambda: self._label(label, True), timeout) is not None

    def tap_text(self, label, timeout=30):
        if label not in LABELS or '"' in label:
            raise DeviceError("unsupported label")
        # The XPath request contains only a reviewed literal button label. The
        # driver returns element handles and evaluates the UI hierarchy remotely.
        path = ('//*[@package="' + PACKAGE + '" and (@text="' + label +
                '" or @content-desc="' + label + '")]/ancestor-or-self::*[@package="' +
                PACKAGE + '" and @clickable="true"][1]')
        until = time.monotonic() + timeout
        scrolled = False
        while True:
            targets = [e for e in self.elements("xpath", path)
                       if e.attribute("enabled") and e.attribute("displayed")]
            if len(targets) == 1:
                targets[0].click()
                return
            if not scrolled:
                scrolled = True
                try:
                    self.command("POST", "execute/sync", {"script": "mobile: hideKeyboard", "args": [{}]})
                except DeviceError:
                    pass
                # Appium returns only an opaque element handle, never the page.
                scroll = ("new UiScrollable(new UiSelector().packageName(" + json.dumps(PACKAGE) +
                          ").scrollable(true)).scrollTextIntoView(" + json.dumps(label) + ")")
                self.elements("-android uiautomator", scroll)
            if time.monotonic() >= until:
                raise DeviceError("unique enabled control missing")
            time.sleep(.35)

    def back(self):
        self.command("POST", "back", {})

    def restart(self):
        for script in ("mobile: terminateApp", "mobile: activateApp"):
            result = self.command("POST", "execute/sync", {"script": script, "args": [{"appId": PACKAGE}]})
            if script.endswith("terminateApp") and result is not True:
                raise DeviceError("could not terminate running Messenger")

    def close(self):
        self.transport.hub("DELETE", "/session/" + self.session)
