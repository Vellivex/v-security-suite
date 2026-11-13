// client/internet-call-screen.js
function setupInternetCallUI({ call: providedCall } = {}) {
  const el = (id) => document.getElementById("call-" + id);
  let configured = false;
  let pendingLink = "";
  let notice = "";
  let busy = false;
  let micPending = false;
  let actionGeneration = 0;
  let qrLink = "";
  if (location.hash) {
    const fragment = location.hash;
    history.replaceState(null, "", location.pathname);
    try {
      parseAudioLink(fragment);
      pendingLink = location.origin + location.pathname + fragment;
    } catch {
      notice = "This private invitation link is invalid. Request a new one.";
    }
  }
  const call = providedCall ?? new InternetCall();
  const active = () => !["idle", "ended"].includes(call.status.phase);
  function render() {
    const s = call.status;
    const inProgress = active();
    const ready = s.connected && s.localVerified && s.remoteVerified;
    el("create").disabled = !configured || busy || inProgress || !el("consent").checked || Boolean(pendingLink);
    el("end").disabled = !inProgress && !busy && !pendingLink;
    el("consent").disabled = busy || inProgress;
    el("join-panel").hidden = inProgress;
    el("join").disabled = !configured || busy || inProgress || !el("consent").checked || !(pendingLink || el("incoming").value.trim());
    el("incoming").disabled = busy || inProgress;
    el("share").hidden = !s.hasInvitation;
    el("link").value = call.invitationLink;
    if (qrLink !== call.invitationLink) {
      qrLink = call.invitationLink;
      el("qr").removeAttribute("src");
      el("qr-panel").hidden = true;
      if (qrLink) {
        try {
          el("qr").src = invitationQr(qrLink, location.origin).createDataURL(4, 16);
          el("qr-panel").hidden = false;
        } catch {
        }
      }
    }
    el("verify").disabled = busy || !s.connected;
    el("verify").checked = s.localVerified;
    el("fingerprints").hidden = !s.connected;
    el("fingerprint").textContent = s.fingerprint ?? "";
    el("preset").disabled = busy;
    el("mic-on").disabled = busy || !ready || s.microphoneActive || !el("headphones").checked;
    el("mic-off").disabled = !s.microphoneActive && !micPending;
    el("sound").disabled = busy || !ready || !s.remoteAudioAvailable || s.soundEnabled || !el("headphones").checked;
    el("badge").textContent = s.microphoneActive ? "Microphone on" : s.connected ? "Connected \\xB7 microphone off" : "Microphone off";
    el("status").textContent = notice || s.message;
    el("status").dataset.state = notice ? "error" : "";
    el("incoming-note").textContent = pendingLink ? "A private invitation is ready. Tick the private-call box, then select Join invitation." : "Open the private link, or paste it below. Joining leaves your microphone and sound off.";
    el("verification-note").textContent = ready ? "Both devices confirmed. Microphone and sound still need your explicit action." : s.connected ? "Compare the complete connection code, then confirm on each device." : "Audio stays off until a connection is established and both devices confirm the connection code.";
    el("audio-status").textContent = (micPending ? "Waiting for microphone permission. You can turn it off or end the test." : s.microphoneActive ? "Microphone on." : "Microphone off.") + " Received sound " + (s.soundEnabled ? "enabled." : "muted.");
    el("deadline").textContent = s.expiresAt ? "This invitation and call end five minutes after creation." : "";
  }
  async function run(action, { microphone = false } = {}) {
    if (busy || document.hidden) return;
    const generation = ++actionGeneration;
    busy = true;
    micPending = microphone;
    notice = "";
    render();
    try {
      await action();
    } catch {
      if (generation === actionGeneration && !document.hidden) notice = "That action could not finish. Check the invitation and connection before trying again.";
    } finally {
      if (generation === actionGeneration) {
        busy = false;
        micPending = false;
        render();
      }
    }
  }
  function clear() {
    pendingLink = "";
    qrLink = "";
    el("qr").removeAttribute("src");
    el("qr-panel").hidden = true;
    el("incoming").value = "";
    el("link").value = "";
    el("verify").checked = false;
    el("headphones").checked = false;
    el("consent").checked = false;
    el("copy-status").textContent = "";
  }
  async function end(message) {
    ++actionGeneration;
    busy = false;
    micPending = false;
    notice = "";
    clear();
    await call.stop(message);
    render();
  }
  el("consent").addEventListener("change", render);
  el("incoming").addEventListener("input", () => {
    pendingLink = "";
    notice = "";
    render();
  });
  el("create").addEventListener("click", () => {
    if (!el("consent").checked) return;
    void run(() => call.create());
  });
  el("join").addEventListener("click", () => {
    if (!el("consent").checked) return;
    const link = pendingLink || el("incoming").value.trim();
    try {
      parseAudioLink(link);
    } catch {
      notice = "This invitation link is invalid. Request a new one.";
      render();
      return;
    }
    pendingLink = "";
    el("incoming").value = "";
    void run(() => call.join(link));
  });
  el("copy").addEventListener("click", () => {
    const link = call.invitationLink;
    if (!link || document.hidden) return;
    el("link").focus();
    el("link").select();
    if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(link).then(() => {
      if (call.invitationLink === link && !document.hidden) el("copy-status").textContent = "Private link copied. Share only with your other device.";
    }, () => {
      if (call.invitationLink === link && !document.hidden) el("copy-status").textContent = "Select and copy the private link above.";
    });
    else el("copy-status").textContent = "Select and copy the private link above.";
  });
  el("end").addEventListener("click", () => {
    void end();
  });
  el("verify").addEventListener("change", () => {
    const confirmed = el("verify").checked;
    void run(() => call.verify(confirmed));
  });
  el("headphones").addEventListener("change", () => {
    if (!el("headphones").checked && active()) void end("Headphones were unticked. Call ended; microphone and sound are off.");
    else render();
  });
  el("mic-on").addEventListener("click", () => {
    if (el("headphones").checked) void run(() => call.microphone(el("preset").value, true), { microphone: true });
  });
  el("preset").addEventListener("change", () => {
    if (call.status.microphoneActive) void run(() => call.setPreset(el("preset").value));
  });
  el("mic-off").addEventListener("click", () => {
    ++actionGeneration;
    busy = false;
    micPending = false;
    void call.muteMicrophone().then(render, () => end());
  });
  el("sound").addEventListener("click", () => {
    if (el("headphones").checked) void run(() => call.sound(true));
  });
  call.addEventListener("state", ({ detail }) => {
    if (detail.phase === "ended") {
      ++actionGeneration;
      busy = false;
      micPending = false;
      clear();
    }
    render();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) void end("The page was hidden. Call ended; microphone and sound are off.");
  });
  document.addEventListener("freeze", () => {
    void end("Call ended because the page was frozen.");
  });
  globalThis.addEventListener("pagehide", () => {
    void end("Call ended because the page was left.");
  });
  document.addEventListener("vellivex-session-ended", () => {
    void end("Your protected session ended. Microphone and sound are off.");
  });
  document.addEventListener("vellivex-call-frozen", () => {
    void end("Calling tests were frozen. Microphone and sound are off.");
  });
  render();
  async function configuration() {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12e3);
    try {
      const response = await fetch("/api/audio/status", { credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal });
      if (!response.ok) throw new Error();
      const value = await boundedJson(response);
      if (Object.keys(value).sort().join(",") !== "enabled,maxSeconds,phoneCalling,profile" || typeof value.enabled !== "boolean" || value.profile !== "wss-opus-v1" || value.maxSeconds !== 300 || value.phoneCalling !== false) throw new Error();
      if (!value.enabled) {
        notice ||= "Internet calling is still being connected. You can use the local voice preview meanwhile.";
        return;
      }
      try {
        if (await OpusAudio.supported() !== true) throw new Error();
        configured = true;
      } catch {
        notice ||= "Internet calling is not supported by this browser. Try it on your other device.";
      }
    } catch {
      notice ||= "Sign in to this private app to check internet calling availability.";
    } finally {
      clearTimeout(timer);
      render();
    }
  }
  void configuration();
}
