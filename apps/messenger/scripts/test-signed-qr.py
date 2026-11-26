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


def confirm_candidate(sha, label, directory):
    assert installed_version() == 10
    path = adb("shell", "pm", "path", PACKAGE)
    assert path.startswith("package:") and "\n" not in path
    installed = directory / "installed.apk"
    adb("pull", path.removeprefix("package:"), str(installed))
    with installed.open("rb") as source:
        assert hashlib.file_digest(source, "sha256").hexdigest() == sha
    adb("shell", "pm", "verify-app-links", "--re-verify", PACKAGE)
    wait_until(lambda: re.search(r"^\s*www\.vellivex\.com:\s*verified\s*$",
                                 adb("shell", "pm", "get-app-links", PACKAGE), re.M),
               "automatic Android domain verification", 185)
    print(adb("shell", "pm", "get-app-links", "--user", "0", PACKAGE), flush=True)
    print("Initial resolver:", resolver(INVITE), flush=True)
    print("Available activities:", adb("shell", "cmd", "package", "query-activities",
          "--brief", "--user", "0", "-a", "android.intent.action.VIEW",
          "-c", "android.intent.category.BROWSABLE", "-d", INVITE), flush=True)
    # The receiving user has launched the app before scanning. A force-stop sets
    # the package's stopped flag, unlike Android reclaiming a background process.
    launch_from_home()
    print("Post-launch resolver:", resolver(INVITE), flush=True)
    assert not resolver(f"{ORIGIN}/messenger").startswith(PACKAGE + "/")
    adb("shell", "am", "kill", PACKAGE)
    launched = adb("shell", "am", "start", "-W", "-a", "android.intent.action.VIEW",
                   "-c", "android.intent.category.BROWSABLE", "-d", INVITE)
    print("Unqualified invitation start:", launched, flush=True)
    assert "Status: ok" in launched and (f"Activity: {PACKAGE}/" in launched or
                                          f"Activity: {PACKAGE}." in launched), launched

    def sign_in_visible():
        adb("shell", "uiautomator", "dump", "/data/local/tmp/qr-screen.xml")
        ui = ET.fromstring(adb("shell", "cat", "/data/local/tmp/qr-screen.xml"))
        return any(node.get("package") == PACKAGE and node.get("text") == "Continue with email"
                   for node in ui.iter("node"))

    wait_until(sign_in_visible, "Vellivex sign-in after opening the QR link", 40)
    component = resolver(INVITE)
    assert component.startswith(PACKAGE + "/"), component
    print(f"PASS {label}: exact signed install, verified domain, cold invitation opens Vellivex sign-in",
          flush=True)


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
        confirm_candidate(sha, "upgrade Alpha09 to Alpha10", directory)
        assert adb("uninstall", PACKAGE) == "Success"
        assert resolver(INVITE) == browser
        adb("install", str(current))
        confirm_candidate(sha, "fresh Alpha10", directory)


if __name__ == "__main__":
    main()
