# SPDX-License-Identifier: GPL-3.0-or-later
"""Two ordinary installations, driven only through public on-screen controls."""

import re
import secrets
import time


ROLES = ("A", "B")
EDIT = "android.widget.EditText"
WAIT_SECONDS = 60
STAGES = frozenset({
    "release-sign-in-screen", "invalid-email-blocked", "code-screen-shown",
    "wrong-code-rejected", "received-code-submitted", "recovery-screen-shown",
    "wrong-suffix-rejected", "recovery-confirmed", "contact-id-read",
    "invalid-contact-blocked", "self-contact-blocked", "foreign-contact-blocked",
    "invitation-created", "invitation-accepted", "unverified-send-blocked",
    "first-sas-matched", "rejected-verification-blocked", "second-sas-matched",
    "verification-confirmed", "fresh-messages-exchanged", "conversation-reopened",
    "cold-restart-restored", "new-messages-exchanged", "signed-out",
})


class FlowFailure(Exception):
    """A fixed message that can be displayed without disclosing UI or input values."""


def _require(condition):
    if not condition:
        raise FlowFailure("A physical acceptance check failed")


def _wait(read):
    deadline = time.monotonic() + WAIT_SECONDS
    while True:
        value = read()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise FlowFailure("A physical acceptance check timed out")
        time.sleep(0.25)


def _only(items):
    return items[0] if len(items) == 1 else None


def _field(device):
    return _wait(lambda: _only([element for element in device.find_all(EDIT)
                                if element.attribute("displayed") and element.attribute("enabled")]))


def _enter(device, value):
    field = _field(device)
    field.clear()
    field.send(value)


def _release_surface(device):
    _require(not device.has_text("Test server settings"))
    _require(not device.has_desc("Test server settings"))
    _require(not device.has_text("Server address"))


def _request_code(device, role, email, handoff, checkpoint):
    device.find_text("Continue with email")
    _release_surface(device)
    checkpoint(role, "release-sign-in-screen")
    _enter(device, "missing-domain@")
    device.tap_text("Continue with email")
    device.find_text("Enter a valid email address.")
    checkpoint(role, "invalid-email-blocked")
    _enter(device, email)
    handoff.begin(role)
    device.tap_text("Continue with email")
    device.find_text("Eight-digit email code")
    handoff.ready(role)
    checkpoint(role, "code-screen-shown")


def _submit_code(device, role, code, checkpoint):
    _require(isinstance(code, str) and re.fullmatch(r"[0-9]{8}", code))
    wrong = "11111111" if code == "00000000" else "00000000"
    _enter(device, wrong)
    device.tap_text("Open Vellivex")
    device.find_text("That code could not be verified. Check it or request a new one.")
    checkpoint(role, "wrong-code-rejected")
    _enter(device, code)
    # Compare the local field with the input without sending it back as a selector.
    _wait(lambda: _field(device).text() == code)
    device.tap_text("Open Vellivex")
    checkpoint(role, "received-code-submitted")


def _recovery_suffix(device):
    result = []
    for element in device.find_pattern("recovery"):
        if not element.attribute("displayed"):
            continue
        value = element.text()
        if not isinstance(value, str):
            continue
        groups = value.split()
        if (8 <= len(groups) and 40 <= len(value) <= 192 and
                all(re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{1,4}", group) for group in groups)):
            result.append("".join(groups)[-4:])
    return _only(result)


def _recover(device, role, checkpoint):
    device.find_text("Secure your account", timeout=WAIT_SECONDS)
    _require(not device.has_text("Messages"))
    checkpoint(role, "recovery-screen-shown")
    device.tap_text("Create recovery key")
    suffix = _wait(lambda: _recovery_suffix(device))
    _enter(device, "0000")  # Zero is outside the displayed recovery key alphabet.
    device.tap_text("I've saved my recovery key")
    device.find_text("Enter the last four characters of your recovery key exactly as shown.")
    _require(not device.has_text("Messages"))
    checkpoint(role, "wrong-suffix-rejected")
    _enter(device, suffix)
    del suffix
    device.tap_text("I've saved my recovery key")
    device.find_text("Messages", timeout=WAIT_SECONDS)
    checkpoint(role, "recovery-confirmed")


def _contact_id(device):
    device.find_desc("Your profile").click()
    device.find_text("Your Vellivex ID")
    element = _wait(lambda: _only([node for node in device.find_pattern("contact") if node.attribute("displayed")]))
    value = element.text()
    _require(isinstance(value, str) and re.fullmatch(r"@[A-Za-z0-9_.=+/\-]+:[A-Za-z0-9.:\[\]\-]+", value))
    device.tap_text("Done")
    return value


def _new_contact(device, value):
    device.tap_text("New conversation")
    device.find_text("Start a conversation")
    device.find_text("Contact ID or link")
    device.find_text("Cancel")
    _enter(device, value)
    device.tap_text("Continue")


def _blocked(device):
    _require(not device.has_desc("Send message"))
    _require(not device.has_text("Write a message"))


def _invite(devices, ids, checkpoint):
    first, second = devices["A"], devices["B"]
    for invalid, stage in (("not-a-contact", "invalid-contact-blocked"),
                           (ids["A"], "self-contact-blocked"),
                           ("@fictional:other.example.test", "foreign-contact-blocked")):
        # The snackbar from a preceding input cannot satisfy the next check.
        _wait(lambda: not first.has_text("Enter another account ID on this messaging service."))
        _new_contact(first, invalid)
        first.find_text("Enter another account ID on this messaging service.")
        first.find_text("Your people. Your space.")
        _blocked(first)
        _require(not first.has_text("Verify your contact to start chatting"))
        _require(not first.has_text("Conversation invitation"))
        checkpoint("A", stage)
    _new_contact(first, ids["B"])
    first.find_text("Verify your contact to start chatting", timeout=WAIT_SECONDS)
    checkpoint("A", "invitation-created")
    second.tap_text("Conversation invitation", timeout=WAIT_SECONDS)
    second.find_text("Accept invitation")
    _blocked(second)
    second.tap_text("Accept invitation")
    second.find_text("Compare a short code with your contact before your first message.")
    checkpoint("B", "invitation-accepted")
    first.tap_text("Verify your contact to start chatting")
    for role in ROLES:
        devices[role].find_text("Compare a short code with your contact before your first message.")
        _blocked(devices[role])
        checkpoint(role, "unverified-send-blocked")


def _verification_values(device):
    """Read every complete displayed SAS presentation locally, retaining duplicate detection."""
    values = {}
    for element in device.find_pattern("sas"):
        if not element.attribute("displayed"):
            continue
        value = element.text()
        if not isinstance(value, str):
            return None
        parts = value.split("  ")
        if len(parts) == 3 and all(re.fullmatch(r"[0-9]{4}", part) for part in parts):
            kind = "numbers"
        elif len(parts) == 7 and all(
            part and not part.isascii() and not any(ch.isspace() or ch.isascii() and ch.isalpha() for ch in part)
            for part in parts
        ):
            kind = "emoji"
        else:
            return None
        if kind in values:
            return None
        values[kind] = value
    return values or None


def _compare(devices, reject, checkpoint):
    initiator, recipient = ("A", "B") if reject else ("B", "A")
    devices[initiator].find_desc("Verify contact").click()
    devices[recipient].tap_text("Compare codes", timeout=WAIT_SECONDS)
    for role in ROLES:
        devices[role].find_text("They match", timeout=WAIT_SECONDS)
    left = _wait(lambda: _verification_values(devices["A"]))
    right = _wait(lambda: _verification_values(devices["B"]))
    _require(left == right)
    del left, right
    for role in ROLES:
        checkpoint(role, "first-sas-matched" if reject else "second-sas-matched")
    if reject:
        devices["B"].tap_text("They don't match")
        for role in ROLES:
            device = devices[role]
            device.find_text("Verification did not complete. Try again with your contact.", timeout=WAIT_SECONDS)
            device.tap_text("Done")
            device.find_text("Compare a short code with your contact before your first message.")
            _blocked(device)
            checkpoint(role, "rejected-verification-blocked")
        return
    # A displayed full match on *both* devices is a prerequisite to either confirmation.
    for role in ROLES:
        devices[role].tap_text("They match")
    for role in ROLES:
        device = devices[role]
        device.find_text("Contact verified. You can now send private messages.", timeout=WAIT_SECONDS)
        device.tap_text("Done")
        device.find_text("Write a message")
        checkpoint(role, "verification-confirmed")


def _visible_message(device, body):
    # Use a fixed witness pattern. The generated body never appears in a selector.
    def exactly_one():
        count = sum(1 for node in device.find_pattern("witness")
                    if node.attribute("className") != EDIT and node.attribute("displayed") and node.text() == body)
        _require(count <= 1)
        return count == 1

    _wait(exactly_one)


def _send(sender, receiver, body):
    sender.find_text("Write a message")
    _enter(sender, body)
    sender.find_desc("Send message").click()
    _visible_message(sender, body)
    _wait(lambda: _field(sender).text() != body)
    _visible_message(receiver, body)


def _messages(devices, checkpoint):
    run_id = secrets.token_hex(6)
    first = {role: f"VVXQA-{run_id}-{role}-fresh" for role in ROLES}
    _send(devices["A"], devices["B"], first["A"])
    _send(devices["B"], devices["A"], first["B"])
    for role, peer in (("A", "B"), ("B", "A")):
        device = devices[role]
        checkpoint(role, "fresh-messages-exchanged")
        device.find_desc("Back to messages").click()
        device.find_text("Messages")
        device.tap_text("Verified conversation")
        _visible_message(device, first[peer])
        _require(device.has_desc("Send message"))
        checkpoint(role, "conversation-reopened")
        device.find_desc("Back to messages").click()
        device.find_text("Messages")
        device.find_text("Verified conversation")
    for role in ROLES:
        devices[role].restart()
    for role in ROLES:
        device = devices[role]
        device.find_text("Messages", timeout=WAIT_SECONDS)
        _require(not device.has_text("Continue with email"))
        device.tap_text("Verified conversation", timeout=WAIT_SECONDS)
        device.find_text("Contact verified")
        for body in first.values():
            _visible_message(device, body)
        _require(device.has_desc("Send message"))
        checkpoint(role, "cold-restart-restored")
    _send(devices["B"], devices["A"], f"VVXQA-{run_id}-B-restart")
    _send(devices["A"], devices["B"], f"VVXQA-{run_id}-A-restart")
    for role in ROLES:
        devices[role].find_desc("Back to messages").click()
        devices[role].find_text("Messages")
        checkpoint(role, "new-messages-exchanged")


def _run_pair(devices, handoff, checkpoint):
    _require(set(devices) == set(ROLES) and devices["A"] is not devices["B"])
    emails = {role: handoff.email(role) for role in ROLES}
    _require(all(isinstance(v, str) and re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", v) for v in emails.values()))
    _require(emails["A"].casefold() != emails["B"].casefold())
    for role in ROLES:
        _request_code(devices[role], role, emails.pop(role), handoff, checkpoint)
    # Both requests have reached their code screen before waiting for either delivery.
    for role in ROLES:
        _submit_code(devices[role], role, handoff.code(role), checkpoint)
    ids = {}
    for role in ROLES:
        _recover(devices[role], role, checkpoint)
        ids[role] = _contact_id(devices[role])
        checkpoint(role, "contact-id-read")
    _require(ids["A"] != ids["B"])
    _invite(devices, ids, checkpoint)
    del ids
    _compare(devices, reject=True, checkpoint=checkpoint)
    _compare(devices, reject=False, checkpoint=checkpoint)
    _messages(devices, checkpoint)
    for role in ROLES:
        device = devices[role]
        device.find_desc("Your profile").click()
        device.find_text("Your Vellivex ID")
        device.tap_text("Sign out")
        device.find_text("Sign out of this phone?")
        device.tap_text("Sign out")
        device.find_text("Continue with email", timeout=WAIT_SECONDS)
        _release_surface(device)
        checkpoint(role, "signed-out")


def run_pair(devices, handoff, checkpoint):
    """On success both apps visibly signed out. The only emitted data are role/stage."""
    try:
        _run_pair(devices, handoff, checkpoint)
    except Exception:
        # Driver exceptions may contain the field, method payload or response. Keep
        # them out of the exported exception, even when a caller prints a traceback.
        pass
    else:
        return
    raise FlowFailure("Two-device physical acceptance did not complete")
