"""Accept a signed Vellivex contact-link release on an isolated Android 15 emulator."""

import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path

HOST = "www.vellivex.com"
ORIGIN = f"https://{HOST}"
PACKAGE = "com.vellivex.messenger.alpha"
CERT = "3aac05cadcd0cb90dff2474118586d537ce45cf177f237aa90a84a6ed3400df2"
INVITE = f"{ORIGIN}/invite#/@qr-check:messenger.vellivex.com"
SDK = Path(os.environ["ANDROID_HOME"])
SIGNER = SDK / "build-tools/36.0.0/apksigner"
ADB = [str(SDK / "platform-tools/adb"), "-s", "emulator-5554"]


def run(*args):
    try:
        return subprocess.check_output(args, encoding="utf-8", timeout=90).strip()
    except subprocess.CalledProcessError as error:
        print("Failed command output:", error.output, flush=True)
        raise


def adb(*args):
    return run(*ADB, *args)


def wait_until(check, label, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(3)
    raise RuntimeError(f"Timed out checking {label}")


def get_apk(version, digest, destination):
    assert re.fullmatch(r"[a-f0-9]{64}", digest)
    url = f"{ORIGIN}/downloads/Vellivex-Messenger-0.1.0-{version}-universal.apk"
    run("curl", "--proto", "=https", "--fail", "--silent", "--show-error", "--max-time", "80",
        "--output", destination, url)
    with destination.open("rb") as source:
        assert hashlib.file_digest(source, "sha256").hexdigest() == digest
    certs = re.findall(r"^Signer #\d+ certificate SHA-256 digest: (\w+)$",
                       run(SIGNER, "verify", "--print-certs", destination), re.M)
    assert certs == [CERT], f"Unexpected signing certificate for {version}"


def resolver(url):
    return adb("shell", "cmd", "package", "resolve-activity", "--brief", "--user", "0",
               "-a", "android.intent.action.VIEW", "-c", "android.intent.category.BROWSABLE",
               "-d", url).splitlines()[-1]


def launch_from_home():
    result = adb("shell", "am", "start", "-W", "-n",
                 PACKAGE + "/com.vellivex.messenger.MainActivity")
    assert "Status: ok" in result, result
    adb("shell", "input", "keyevent", "KEYCODE_HOME")


def installed_version():
    state = adb("shell", "dumpsys", "package", PACKAGE)
    return int(re.search(r"\bversionCode=(\d+)", state)[1])


def ui_nodes():
    adb("shell", "uiautomator", "dump", "/data/local/tmp/qr-screen.xml")
    tree = ET.fromstring(adb("shell", "cat", "/data/local/tmp/qr-screen.xml"))
    return list(tree.iter("node"))


def tap(node):
    coords = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds", ""))
    if not coords:
        raise RuntimeError("Android accessibility did not return touch bounds")
    left, top, right, bottom = map(int, coords.groups())
    assert right > left and bottom > top
    adb("shell", "input", "tap", str((left + right) // 2), str((top + bottom) // 2))


def sign_in_visible():
    return any(node.get("package") == PACKAGE and node.get("text") == "Continue with email"
               for node in ui_nodes())


def browser_button(browser, label):
    browser_pkg = browser.split("/")[0]
    result = adb("shell", "am", "start", "-W", "-n", browser, "-a", "android.intent.action.VIEW", "-d", INVITE)
    assert "Status: ok" in result and f"Activity: {browser_pkg}/" in result, result
    startup = {"Use without an account", "Continue without an account", "Accept & continue", "No thanks", "Got it"}
    observed = []

    def touch_link():
        nodes = [n for n in ui_nodes() if n.get("package") == browser_pkg]
        texts = [(n, (n.get("text") or n.get("content-desc") or "").strip()) for n in nodes]
        observed[:] = [t[:90] for _, t in texts if t][:22]
        for node, text in texts:
            if text == "Open in Vellivex":
                tap(node)
                print("Touched Android Chrome's Open in Vellivex control", flush=True)
                return True
        for node, text in texts:
            if text in startup:
                tap(node)
                break
        return False

    try:
        wait_until(touch_link, "visible Android Chrome Open in Vellivex link", 75)
    except RuntimeError:
        print("Last browser labels:", observed, flush=True)
        raise
    wait_until(sign_in_visible, "Vellivex screen after a real browser touchscreen tap", 45)
    print(f"PASS {label}: Android Chrome touchscreen opened the installed original-signed Vellivex", flush=True)


def automatic_link(label):
    print("Initial domain state:", adb("shell", "pm", "get-app-links", "--user", "0", PACKAGE), flush=True)
    adb("shell", "pm", "verify-app-links", "--re-verify", PACKAGE)
    verified = False
    for attempt in range(42):
        state = adb("shell", "pm", "get-app-links", "--user", "0", PACKAGE)
        if attempt % 7 == 0:
            print("Android domain state:", state, flush=True)
        if re.search(r"^\s*www\.vellivex\.com:\s*verified\s*$", state, re.M):
            verified = True
            break
        time.sleep(4)
    if not verified:
        details = adb("shell", "logcat", "-d", "-s", "DomainVerificationAgent", "IntentFilterIntentOp",
                      "DomainVerificationService", "StatementService")
        print("Android verifier diagnostics:", details[-1800:], flush=True)
    component = resolver(INVITE)
    print("User's invitation resolver:", component, flush=True)
    print("Available activities:", adb("shell", "cmd", "package", "query-activities",
          "--brief", "--user", "0", "-a", "android.intent.action.VIEW",
          "-c", "android.intent.category.BROWSABLE", "-d", INVITE), flush=True)
    assert not resolver(f"{ORIGIN}/messenger").startswith(PACKAGE + "/")
    adb("shell", "am", "kill", PACKAGE)
    launched = adb("shell", "am", "start", "-W", "-a", "android.intent.action.VIEW",
                   "-c", "android.intent.category.BROWSABLE", "-d", INVITE)
    print("Unqualified invitation start:", launched, flush=True)
    assert "Status: ok" in launched and f"Activity: {PACKAGE}/" in launched, launched
    wait_until(sign_in_visible, "Vellivex sign-in after opening the QR link", 40)
    # The PM shell's prediction may be the generic resolver even when
    # ActivityManager delivers the unqualified link directly to this app.
    assert verified, state
    print(f"PASS {label}: exact signed install, verified domain, cold invitation opens Vellivex sign-in",
          flush=True)


def confirm_candidate(sha, label, browser):
    assert installed_version() == 10
    path = adb("shell", "pm", "path", PACKAGE)
    assert path.startswith("package:") and "\n" not in path
    installed = path.removeprefix("package:")
    assert re.fullmatch(r"/data/app/[A-Za-z0-9._=+~/\-]+/base\.apk", installed)
    # Hash on the Android device, as the paired-app runner does. Transferring
    # the entire universal APK back can interrupt the emulator transport.
    for attempt in range(2):
        try:
            result = adb("shell", "toybox", "sha256sum", installed)
        except subprocess.CalledProcessError:
            if attempt:
                raise
            adb("wait-for-device")
            continue
        assert result.split()[0] == sha, result
        break
    launch_from_home()
    if os.environ["QR_ROUTE"] == "browser":
        browser_button(browser, label)
    else:
        automatic_link(label)


def main():
    sha = "c994d9243e2c9b9e4ffaade600096682991e16ce27f9e9648e5181f96ad52c65"
    with tempfile.TemporaryDirectory() as temp:
        directory = Path(temp)
        current, previous = directory / "alpha10.apk", directory / "alpha09.apk"
        get_apk("alpha09", "eab2468488a6a34451a47bc0e5dda2ed51e8dcf2f8fed191fadf97ebb55e1471", previous)
        get_apk("alpha10", sha, current)
        association = directory / "assetlinks.json"
        response_status = run("curl", "--proto", "=https", "--silent", "--show-error", "--fail",
                              "--max-time", "20", "--output", association, "--write-out", "%{http_code}",
                              f"{ORIGIN}/.well-known/assetlinks.json")
        assert response_status == "200"
        relations = json.loads(association.read_text())
        print("PASS both exact release digests and APK certificates", flush=True)
        assert any("delegate_permission/common.handle_all_urls" in relation["relation"] and
                   relation["target"].get("namespace") == "android_app" and
                   relation["target"].get("package_name") == PACKAGE and
                   CERT in [cert.replace(":", "").lower()
                            for cert in relation["target"]["sha256_cert_fingerprints"]]
                   for relation in relations)
        adb("wait-for-device")
        wait_until(lambda: adb("shell", "getprop", "sys.boot_completed") == "1", "emulator boot", 280)
        assert adb("shell", "getprop", "ro.build.version.sdk") == "35"
        adb("shell", "wm", "dismiss-keyguard")
        assert adb("shell", "pm", "list", "packages", PACKAGE) == ""
        if os.environ["QR_ROUTE"] == "browser":
            def landing_ready():
                page = run("curl", "--proto", "=https", "--silent", "--show-error", "--fail", "--max-time",
                           "20", ORIGIN + "/invite")
                return 'id="open-vellivex"' in page
            wait_until(landing_ready, "production Open in Vellivex control", 720)
        browser = resolver(INVITE)
        assert browser == resolver(f"{ORIGIN}/messenger") and "/" in browser
        browser_package = browser.split("/")[0]
        assert browser_package not in ("android", PACKAGE)
        browser_launch = adb("shell", "am", "start", "-W", "-a", "android.intent.action.VIEW",
                             "-c", "android.intent.category.BROWSABLE", "-d", INVITE)
        assert "Status: ok" in browser_launch and f"Activity: {browser_package}/" in browser_launch
        dom = run("google-chrome", "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
                  "--user-data-dir=" + str(directory / "chrome"), "--dump-dom", INVITE)
        assert '<code id="contact">@qr-check:messenger.vellivex.com</code>' in dom and "matrix.to" not in dom
        assert "Vellivex" in dom and "/messenger" in dom
        print("PASS browser fallback: contact ID and official Vellivex setup on the landing page", flush=True)
        adb("install", str(previous))
        assert installed_version() == 9 and resolver(INVITE) == browser
        launch_from_home()
        adb("install", "-r", str(current))
        errors = []
        try:
            confirm_candidate(sha, "upgrade Alpha09 to Alpha10", browser)
        except (subprocess.SubprocessError, RuntimeError, AssertionError, ET.ParseError) as error:
            print("FAIL upgraded installation:", repr(error), flush=True)
            errors.append(error)
        assert adb("uninstall", PACKAGE) == "Success"
        assert resolver(INVITE) == browser
        adb("install", str(current))
        try:
            confirm_candidate(sha, "fresh Alpha10", browser)
        except (subprocess.SubprocessError, RuntimeError, AssertionError, ET.ParseError) as error:
            print("FAIL fresh installation:", repr(error), flush=True)
            errors.append(error)
        if errors:
            raise RuntimeError(f"{len(errors)} installation scenarios failed") from errors[0]


if __name__ == "__main__":
    main()
