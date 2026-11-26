"""Check the public original-signed Messenger update on a disposable Android 15 device."""

import hashlib
import os
import re
import subprocess
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

SDK = Path(os.environ["ANDROID_HOME"])
PACKAGE = "com.vellivex.messenger.alpha"
PERMISSION = "android.permission.POST_NOTIFICATIONS"
SIGNER = "3aac05cadcd0cb90dff2474118586d537ce45cf177f237aa90a84a6ed3400df2"
BUILDTOOLS = SDK / "build-tools/36.0.0"
PINS = {
    10: "c994d9243e2c9b9e4ffaade600096682991e16ce27f9e9648e5181f96ad52c65",
    11: "a43380c4585ab189544ce3109e9b869791371dcedac8a782bbacd51e78abc28b",
}


def run(*args, timeout=100):
    return subprocess.check_output(args, encoding="utf-8", timeout=timeout).strip()


def adb(*args):
    return run(SDK / "platform-tools/adb", "-s", "emulator-5554", *args)


def wait_for(condition, label, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(2)
    raise TimeoutError(label)


def package_state():
    return adb("shell", "dumpsys", "package", PACKAGE)


def check_screen():
    adb("shell", "uiautomator", "dump", "/data/local/tmp/installed-screen.xml")
    tree = ET.fromstring(adb("shell", "cat", "/data/local/tmp/installed-screen.xml"))
    return any(n.get("package") == PACKAGE and n.get("text") == "Continue with email" for n in tree.iter("node"))


def check_installed(version):
    state = package_state()
    assert re.search(rf"\bversionCode={version}\b", state)
    assert re.search(rf"\bversionName=0\.1\.0-alpha{version}\b", state)
    base = adb("shell", "pm", "path", PACKAGE).removeprefix("package:")
    assert re.fullmatch(r"/data/app/[a-zA-Z0-9._=+~/\-]+/base\.apk", base)
    assert adb("shell", "toybox", "sha256sum", base).split()[0] == PINS[version]
    started = adb("shell", "am", "start", "-W", "-n", PACKAGE + "/com.vellivex.messenger.MainActivity")
    assert "Status: ok" in started, started
    wait_for(check_screen, f"Alpha{version} visible sign-in screen")
    print(f"PASS Android installed exact Alpha{version} {PINS[version]} and displayed sign-in", flush=True)


def download(version, output):
    url = f"https://www.vellivex.com/downloads/Vellivex-Messenger-0.1.0-alpha{version}-universal.apk"
    deadline = time.monotonic() + 660
    while True:
        result = subprocess.run(["curl", "--silent", "--show-error", "--proto", "=https",
                                 "--connect-timeout", "20", "--max-time", "135",
                                 "--output", str(output), "--write-out", "%{http_code}", url],
                                capture_output=True, text=True)
        if result.returncode == 0 and result.stdout == "200":
            break
        if result.stdout not in {"000", "404", "503"} or time.monotonic() >= deadline:
            raise RuntimeError(f"Release download HTTP {result.stdout} curl {result.returncode}")
        time.sleep(10)
    with output.open("rb") as stream:
        assert hashlib.file_digest(stream, "sha256").hexdigest() == PINS[version]
    verified = run(BUILDTOOLS / "apksigner", "verify", "--print-certs", output)
    assert re.findall(r"^Signer #\d+ certificate SHA-256 digest: (\w+)$", verified, re.M) == [SIGNER]
    badging = run(BUILDTOOLS / "aapt", "dump", "badging", output)
    assert f"package: name='{PACKAGE}' versionCode='{version}' versionName='0.1.0-alpha{version}'" in badging
    native = next(line for line in badging.splitlines() if line.startswith("native-code: "))
    assert set(native.split()[1:]) == {"'arm64-v8a'", "'x86_64'"}
    assert "application-debuggable" not in badging.splitlines()
    print(f"PASS verified official Alpha{version} HTTP bytes {output.stat().st_size}, SHA-256 {PINS[version]}, signer {SIGNER}", flush=True)


def first_install(state):
    return re.search(r"\bfirstInstallTime=(.+)$", state, re.M)[1].strip()


def test_installation():
    assert adb("shell", "getprop", "ro.build.version.sdk") == "35"
    assert adb("shell", "getprop", "ro.kernel.qemu") == "1" or adb("shell", "getprop", "ro.boot.qemu") == "1"
    adb("shell", "wm", "dismiss-keyguard")
    assert not adb("shell", "pm", "list", "packages", PACKAGE)
    with tempfile.TemporaryDirectory() as temp:
        previous, current = Path(temp) / "alpha10.apk", Path(temp) / "alpha11.apk"
        download(10, previous)
        download(11, current)
        assert "Success" in adb("install", previous)
        check_installed(10)
        adb("shell", "pm", "grant", PACKAGE, PERMISSION)
        before = package_state()
        assert PERMISSION + ": granted=true" in before
        original_install = first_install(before)
        # The emulated system image provides root for this synthetic fixture only.
        # A file in the app's private files directory distinguishes a real update from a reinstall.
        adb("root")
        adb("wait-for-device")
        assert adb("shell", "id", "-u") == "0"
        directory = f"/data/user/0/{PACKAGE}/files"
        app_uid = adb("shell", "stat", "-c", "%u", f"/data/user/0/{PACKAGE}")
        assert app_uid.isdigit() and int(app_uid) >= 10000
        adb("shell", "mkdir", "-p", directory)
        adb("shell", "chown", app_uid + ":" + app_uid, directory)
        marker = Path(temp) / "update-proof"
        marker.write_text(uuid.uuid4().hex)
        remote = directory + "/vellivex-update-check"
        adb("push", marker, remote)
        adb("shell", "chown", app_uid + ":" + app_uid, remote)
        adb("shell", "chmod", "600", remote)
        adb("shell", "restorecon", remote)
        adb("shell", "input", "keyevent", "KEYCODE_HOME")
        assert "Success" in adb("install", "-r", current)
        check_installed(11)
        after = package_state()
        assert first_install(after) == original_install
        assert PERMISSION + ": granted=true" in after
        assert adb("shell", "cat", remote) == marker.read_text()
        print("PASS Alpha10 in-place update retained private fixture data, original installation time and Android notification permission", flush=True)
        assert adb("uninstall", PACKAGE) == "Success"
        assert not adb("shell", "pm", "list", "packages", PACKAGE)
        assert "Success" in adb("install", current)
        check_installed(11)
        assert PERMISSION + ": granted=true" not in package_state()
        adb("shell", "test", "!", "-e", remote)
        print("PASS Alpha11 fresh install started with fresh data and no prior Android notification grant", flush=True)


if __name__ == "__main__":
    adb("wait-for-device")
    wait_for(lambda: adb("shell", "getprop", "sys.boot_completed") == "1", "Android boot", timeout=270)
    test_installation()
