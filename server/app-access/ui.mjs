// Vellivex email-only app access. Authentication and app data remain separate.
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function renderAccessPage({appName = 'Vellivex apps'} = {}) {
  const name = escape(String(appName).slice(0, 80));
  return `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta name="referrer" content="no-referrer">
  <meta name="theme-color" content="#101718">
  <title>Sign in to Vellivex</title>
  <link rel="stylesheet" href="/access.css">
  <script src="/access-ui.js" defer></script>
</head>
<body>
  <a class="skip" href="#main-content">Skip to sign in</a>
  <div class="shell">
    <header class="site-header">
      <a class="brand" href="https://www.vellivex.com" aria-label="Vellivex home">
        <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path d="M6 10h12l14 32 14-32h12L38 56H26z"/><path d="M25 10h14l-7 16z"/></svg>
        <span>vellivex</span>
      </a>
      <a class="header-link" href="https://www.vellivex.com">Explore the apps <span aria-hidden="true">↗</span></a>
    </header>
    <main id="main-content" tabindex="-1">
      <section class="intro" aria-labelledby="page-title">
        <p class="eyebrow"><span aria-hidden="true"></span> YOUR VELLIVEX ACCESS</p>
        <h1 id="page-title">One email.<br><em>All Vellivex apps.</em></h1>
        <p class="lead">Sign up or sign in with your email. We’ll send you a code. No password to remember.</p>
        <div class="steps" aria-label="How sign-in works">
          <p><span aria-hidden="true">01</span> Enter your email</p>
          <p><span aria-hidden="true">02</span> Verify your code</p>
          <p><span aria-hidden="true">03</span> Open your app</p>
        </div>
        <p class="device-note">Your app files, keys and recordings stay on their device. Signing in does not upload or sync them.</p>
      </section>
      <section class="access-card" aria-labelledby="form-title">
        <div class="card-top"><span class="eyebrow">EMAIL SIGN-IN</span><span class="small-badge">No password</span></div>
        <h2 id="form-title">Let’s get you in.</h2>
        <p id="destination" class="destination">Continue to ${name}.</p>
        <div id="loading" class="loading" role="status">Preparing your sign-in…</div>
        <div id="access-status" class="status" role="status" aria-live="polite" aria-atomic="true" tabindex="-1"></div>
        <div id="restart-panel" hidden>
          <p>Open the app you want to use, then sign in from there.</p>
          <a class="button" href="https://www.vellivex.com/#products">Choose an app <span aria-hidden="true">↗</span></a>
        </div>
        <form id="access-form" hidden>
          <fieldset id="email-fields">
            <legend class="visually-hidden">Your email address</legend>
            <label class="field-label" for="access-email">Email address</label>
            <input id="access-email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" placeholder="you@example.com" aria-describedby="email-help" required>
            <p class="field-help" id="email-help">We’ll send an eight-digit code to verify it’s yours.</p>
            <label class="consent" for="access-updates"><input id="access-updates" name="updates" type="checkbox"><span>Email me Vellivex updates and offers.<small>Optional. You can use the apps without subscribing.</small></span></label>
            <button class="button" id="send-code" type="submit">Send my code <span aria-hidden="true">→</span></button>
          </fieldset>
        </form>
        <form id="code-form" hidden>
          <fieldset id="code-fields">
            <legend class="visually-hidden">Verify your email address</legend>
            <p class="sent-to">Code sent to <strong id="sent-email"></strong></p>
            <label class="field-label" for="access-code">Your eight-digit code</label>
            <input id="access-code" class="code-input" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" autocapitalize="none" spellcheck="false" maxlength="16" pattern="(?:[0-9]| |-){8,16}" placeholder="0000 0000" aria-describedby="code-help code-expiry" required>
            <p class="field-help" id="code-help">Use the latest code from Vellivex. Check spam if it hasn’t arrived.</p>
            <p class="expiry" id="code-expiry" aria-live="off"></p>
            <button class="button" id="verify-code" type="submit">Verify and open app <span aria-hidden="true">→</span></button>
          </fieldset>
          <div class="secondary-actions"><button id="resend-code" class="text-button" type="button" disabled>Send a new code</button><button id="change-email" class="text-button" type="button">Change email</button></div>
        </form>
        <div id="signed-in" hidden>
          <div class="signed-in-box"><span class="verified-mark" aria-hidden="true">✓</span><div><p>You’re signed in</p><strong id="signed-email"></strong></div></div>
          <button class="button" id="continue-app" type="button">Open ${name} <span aria-hidden="true">→</span></button>
          <a class="button" id="manage-apps" href="https://www.vellivex.com/#products" hidden>Choose an app <span aria-hidden="true">↗</span></a>
          <button class="text-button signout" id="sign-out" type="button">Sign out and use another email</button>
        </div>
        <noscript><p class="status">JavaScript is needed to verify your email. Enable it for this page, then reload.</p></noscript>
        <p class="privacy-note">We store your verified email to provide app access. Updates and offers are a separate choice. <a href="https://www.vellivex.com/privacy">Privacy notice</a></p>
      </section>
    </main>
    <footer><p>Vellivex · Privacy by design, with honest limits.</p><a href="/">Account security and payments <span aria-hidden="true">↗</span></a></footer>
  </div>
</body>
</html>`;
}

export const ACCESS_CSS = `
:root{color-scheme:dark;--bg:#101718;--panel:#172123;--text:#edf4f5;--muted:#afc1c5;--accent:#a5e5ed;--line:#34484c;--error:#ffd0ba;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;line-height:1.6}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}[hidden]{display:none!important}a{color:inherit}button,input{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.55}button,input,a{outline-offset:5px}button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--accent)}::selection{background:var(--accent);color:var(--bg)}
.shell{width:min(1120px,calc(100% - 64px));margin:auto}.site-header{min-height:106px;display:flex;align-items:center;justify-content:space-between;gap:24px;border-bottom:1px solid var(--line)}.brand{display:flex;align-items:center;gap:11px;text-decoration:none;font-size:28px;line-height:1;font-weight:760;letter-spacing:-.06em}.brand svg{width:37px;height:37px;fill:var(--accent);flex:none}.header-link{font-size:13px;text-decoration:none;min-height:44px;display:flex;align-items:center;gap:12px;color:var(--muted)}.header-link:hover{color:var(--text)}
main{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(330px,.95fr);gap:clamp(32px,6vw,78px);align-items:start;padding:66px 0 76px}.intro{padding-top:20px}.eyebrow{margin:0;color:var(--accent);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;letter-spacing:.15em;font-weight:500;display:flex;gap:9px;align-items:center}.eyebrow>span{width:6px;height:6px;border-radius:50%;background:var(--accent)}h1{font-size:clamp(42px,4.7vw,62px);font-weight:550;letter-spacing:-.055em;line-height:1.13;margin:21px 0 25px}h1 em{font-style:normal;color:var(--accent)}.lead{max-width:450px;font-size:17px;line-height:1.75;color:var(--muted);margin:0}.steps{margin:32px 0 27px;border-top:1px solid var(--line)}.steps p{display:flex;gap:19px;margin:0;padding:14px 0;border-bottom:1px solid var(--line);font-size:14px}.steps p span{font-family:ui-monospace,monospace;color:var(--accent);font-size:11px;padding-top:3px}.device-note{font-size:12px;max-width:410px;line-height:1.7;color:var(--muted)}
.access-card{min-width:0;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:32px}.card-top{display:flex;align-items:center;justify-content:space-between;gap:16px}.small-badge{border:1px solid #405c60;border-radius:30px;padding:3px 9px;color:var(--muted);font-size:10px;white-space:nowrap}.access-card h2{font-size:29px;font-weight:550;letter-spacing:-.04em;line-height:1.2;margin:25px 0 10px}.destination{margin:0 0 25px;font-size:14px;color:var(--muted);overflow-wrap:anywhere}fieldset{margin:0;padding:0;border:0;min-width:0}.field-label{display:block;font-size:13px;font-weight:600;margin-bottom:9px}input[type=email],input[type=text]{display:block;width:100%;height:54px;min-width:0;border:1px solid #526b70;border-radius:9px;background:#101a1c;color:var(--text);font-size:16px;padding:12px 14px}input::placeholder{color:#849ca2;opacity:1}.field-help{color:var(--muted);font-size:12px;line-height:1.65;margin:10px 0 0}.consent{display:flex;align-items:flex-start;gap:11px;font-size:12px;line-height:1.55;margin:24px 0;cursor:pointer}.consent input{width:18px;height:18px;flex:none;accent-color:var(--accent);margin:2px 0 0}.consent small{display:block;margin-top:5px;font-size:11px;color:var(--muted)}
.button{min-height:51px;border:1px solid var(--accent);border-radius:9px;background:var(--accent);color:#10292d;font-size:14px;font-weight:650;padding:12px 17px;display:flex;justify-content:center;align-items:center;gap:14px;width:100%;text-decoration:none}.button:hover:not(:disabled){background:#c1eef3}.text-button{min-height:44px;padding:7px 0;background:none;border:0;color:var(--muted);font-size:12px;text-decoration:underline;text-underline-offset:4px}.text-button:hover:not(:disabled){color:var(--text)}.secondary-actions{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-top:13px}.sent-to{font-size:13px;color:var(--muted);margin:0 0 21px;overflow-wrap:anywhere}.sent-to strong{display:block;color:var(--text);font-weight:550;margin-top:3px}.code-input{font-family:ui-monospace,monospace!important;font-size:25px!important;letter-spacing:.2em}.expiry{font-size:12px;min-height:20px;color:var(--muted);margin:11px 0 21px}.loading{font-size:13px;color:var(--muted);margin:20px 0}.status:empty{display:none}.status{border-left:2px solid var(--accent);background:#102023;border-radius:0 7px 7px 0;font-size:13px;padding:12px 14px;margin:0 0 22px;overflow-wrap:anywhere}.status[data-error=true]{border-color:var(--error);color:var(--error)}.privacy-note{padding-top:23px;margin:27px 0 0;border-top:1px solid var(--line);font-size:11px;line-height:1.8;color:var(--muted)}.privacy-note a{white-space:nowrap;text-underline-offset:3px}.signed-in-box{border:1px solid #395d61;background:#102023;padding:17px 15px;border-radius:10px;margin:0 0 21px;display:flex;gap:12px;align-items:flex-start;overflow-wrap:anywhere}.verified-mark{color:var(--accent);border:1px solid #497d83;border-radius:50%;width:24px;height:24px;flex:none;text-align:center;font-size:14px;line-height:22px}.signed-in-box p{font-size:12px;color:var(--muted);margin:0 0 3px}.signed-in-box strong{font-size:14px;font-weight:500;display:block;word-break:break-word}.signout{display:block;margin:12px auto 0}#restart-panel p{font-size:14px;color:var(--muted)}
footer{border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:20px;align-items:center;padding:20px 0 30px;color:var(--muted);font-size:11px}footer p{margin:0}footer a{min-height:44px;display:flex;align-items:center;gap:9px;text-underline-offset:4px}.skip{position:absolute;left:16px;top:-100px;padding:12px 16px;background:var(--accent);color:var(--bg);z-index:2}.skip:focus{top:12px}.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:760px){.shell{width:min(510px,calc(100% - 36px))}.site-header{min-height:84px}.brand{font-size:25px}.brand svg{width:32px;height:32px}.header-link{font-size:11px;gap:7px}main{grid-template-columns:1fr;padding:31px 0 40px;gap:26px}.intro{padding-top:0}h1{font-size:clamp(39px,9.7vw,53px);margin:17px 0 17px}.lead{font-size:15px}.steps{display:none}.device-note{font-size:11px;margin:16px 0 0;max-width:none}.access-card{padding:26px 23px;border-radius:14px}.access-card h2{margin-top:22px;font-size:27px}footer{display:block;font-size:10px;padding-top:20px}footer a{margin-top:5px}.code-input{font-size:24px!important;letter-spacing:.14em}}
@media(max-width:360px){.shell{width:calc(100% - 28px)}.access-card{padding:23px 18px}.header-link{max-width:105px;line-height:1.4}.small-badge{font-size:9px}.card-top{gap:8px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
`;

// Kept self-contained so the exact function below is also the browser asset.
export function mountAccessUI({document = globalThis.document, location = globalThis.location,
  fetch = globalThis.fetch, now = Date.now, schedule = setTimeout, cancel = clearTimeout,
  every = setInterval, stopEvery = clearInterval} = {}) {
  const byId = id => document.getElementById(id);
  const elements = Object.fromEntries(['loading','access-status','restart-panel','access-form','email-fields',
    'access-email','access-updates','send-code','code-form','code-fields','sent-email','access-code',
    'code-expiry','verify-code','resend-code','change-email','signed-in','signed-email','continue-app',
    'manage-apps','sign-out','destination','form-title'].map(id => [id, byId(id)]));
  if (Object.values(elements).some(value => !value)) return null;
  const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
  const allowedOrigins = new Set(['https://vellivex.com','https://www.vellivex.com','https://call.vellivex.com',
    'https://vphone.vellivex.com','https://vdecoy.vellivex.com','https://vkey.vellivex.com','https://private.vellivex.com']);
  let flowId = '', csrf = '', challengeId = '', selectedEmail = '', selectedOptIn = false;
  let signedIn = false, management = false, busy = false, ready = false, stopped = false, generation = 0;
  let resendAt = 0, expiresAt = 0, expiredNotice = false, interval = null, activeControl = null;
  const text = (id, value) => { elements[id].textContent = value; };
  function status(message = '', error = false) {
    text('access-status', message);
    elements['access-status'].dataset.error = error ? 'true' : 'false';
  }
  function render() {
    elements.loading.hidden = ready;
    elements['access-form'].hidden = !ready || management || signedIn || Boolean(challengeId);
    elements['code-form'].hidden = !ready || signedIn || !challengeId;
    elements['signed-in'].hidden = !ready || !signedIn;
    elements['continue-app'].hidden = management;
    elements['manage-apps'].hidden = !management;
    elements['email-fields'].disabled = busy;
    elements['code-fields'].disabled = busy;
    elements['change-email'].disabled = busy;
    elements['sign-out'].disabled = busy;
    elements['continue-app'].disabled = busy;
    elements['access-form'].setAttribute('aria-busy', String(busy));
    elements['code-form'].setAttribute('aria-busy', String(busy));
    updateClocks();
  }
  function updateClocks() {
    if (stopped) return;
    const remaining = Math.max(0, Math.ceil((resendAt - now()) / 1000));
    elements['resend-code'].disabled = busy || remaining > 0 || !challengeId;
    text('resend-code', remaining > 0 ? `Send a new code in ${remaining}s` : 'Send a new code');
    if (!challengeId) { text('code-expiry', ''); return; }
    const seconds = Math.max(0, Math.ceil((expiresAt - now()) / 1000));
    text('code-expiry', seconds > 0 ? `Code expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'This code has expired. Send a new code to continue.');
    elements['verify-code'].disabled = busy || seconds <= 0;
    if (seconds <= 0 && !expiredNotice && !busy) {
      expiredNotice = true;
      elements['access-code'].value = '';
      status('This code has expired. Send a new code to continue.', true);
    }
  }
  function fatal(message) {
    generation++;
    ready = false;
    busy = false;
    challengeId = '';
    csrf = '';
    render();
    elements.loading.hidden = true;
    elements['restart-panel'].hidden = false;
    status(message, true);
  }
  function safeRedirect(value) {
    if (typeof value !== 'string' || value.length > 600) throw new Error('The app link could not be verified. Open the app again.');
    let target;
    try { target = new URL(value); } catch { throw new Error('The app link could not be verified. Open the app again.'); }
    if (!allowedOrigins.has(target.origin) || target.username || target.password ||
        target.pathname !== '/__access/finish' || target.hash !== '#_' ||
        [...target.searchParams.keys()].length !== 2 || target.searchParams.getAll('code').length !== 1 ||
        target.searchParams.getAll('state').length !== 1 || !token(target.searchParams.get('code')) ||
        !token(target.searchParams.get('state'))) throw new Error('The app link could not be verified. Open the app again.');
    elements['access-code'].value = '';
    challengeId = '';
    csrf = '';
    location.replace(target.href);
  }
  function errorMessage(data, statusCode) {
    const code = typeof data?.error === 'string' ? data.error : '';
    if (code === 'email_invalid') return 'Enter a valid email address.';
    if (code === 'flow_expired' || code === 'flow_invalid' || code === 'invalid_flow') return 'This sign-in link has expired. Open the app again to start a new sign-in.';
    if (code === 'mail_limit') return 'Verification emails have reached the free sending limit. Please try again later.';
    if (code === 'email_unavailable') return 'The verification email could not be sent. Please try again later.';
    if (statusCode === 429) return 'Too many requests. Please wait before trying again.';
    if (statusCode === 503) return 'Sign-in is temporarily unavailable. Please try again later.';
    if (statusCode === 401 || code === 'verification_failed') return 'The code or sign-in could not be verified. Check the latest code, or send a new one.';
    return 'The request could not be completed. Check your details and try again.';
  }
  async function request(path, payload) {
    const control = new AbortController();
    activeControl = control;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = schedule(() => { control.abort(); reject(new Error('The request timed out. Please try again.')); }, 15000);
    });
    const operation = async () => {
      const options = {method: payload === undefined ? 'GET' : 'POST', credentials:'same-origin',
        cache:'no-store', redirect:'error', referrerPolicy:'no-referrer', signal:control.signal,
        headers:{Accept:'application/json'}};
      if (payload !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify({...payload, flowId, csrf});
      }
      const response = await fetch('/api/app-access/' + path, options);
      if (response.redirected || response.headers?.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new Error('The sign-in service returned an unexpected response. Please try again.');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d{1,5}$/.test(length) || Number(length) > 8192)) {
        response.body?.cancel().catch(() => {});
        throw new Error('The sign-in service returned an unexpected response. Please try again.');
      }
      if (!response.body) throw new Error('The sign-in service returned an unexpected response. Please try again.');
      const reader = response.body.getReader(), chunks = [];
      let size = 0, count = 0, complete = false;
      const stopReading = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* no private logging */ } };
      control.signal.addEventListener('abort', stopReading, {once:true});
      let body;
      try {
        for (;;) {
          const part = await reader.read();
          if (control.signal.aborted) throw new Error('The request timed out. Please try again.');
          if (part.done) break;
          if (!(part.value instanceof Uint8Array) || ++count > 64 || (size += part.value.byteLength) > 8192) throw new Error('The sign-in service returned an unexpected response. Please try again.');
          chunks.push(part.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        body = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
        complete = true;
      } finally {
        control.signal.removeEventListener('abort', stopReading);
        if (!complete) stopReading();
        try { reader.releaseLock(); } catch { /* no private logging */ }
      }
      let data;
      try { data = JSON.parse(body); } catch { throw new Error('The sign-in service returned an unexpected response. Please try again.'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The sign-in service returned an unexpected response. Please try again.');
      if (!response.ok) {
        const error = new Error(errorMessage(data, response.status));
        error.code = data.error;
        error.status = response.status;
        throw error;
      }
      return data;
    };
    try { return await Promise.race([operation(), timeout]); }
    finally { cancel(timer); control.abort(); if (activeControl === control) activeControl = null; }
  }
  async function run(work) {
    if (busy || stopped || !ready) return;
    const current = generation;
    busy = true;
    status();
    render();
    try { await work(current); }
    catch (error) {
      if (current !== generation || stopped) return;
      if (['flow_expired','flow_invalid','invalid_flow'].includes(error?.code)) fatal(error.message);
      else status(error?.message || 'Sign-in could not be completed. Please try again.', true);
    } finally {
      if (current === generation && !stopped) { busy = false; render(); }
    }
  }
  async function bootstrap() {
    const current = ++generation;
    busy = false;
    ready = false;
    elements['restart-panel'].hidden = true;
    render();
    try {
      const params = new URL(location.href).searchParams;
      const flowCount = params.getAll('flow').length;
      const manageRequested = flowCount === 0;
      if (!manageRequested && (flowCount !== 1 || !token(params.get('flow')))) {
        fatal('This sign-in link could not be verified. Open the app again to get started.');
        return;
      }
      flowId = manageRequested ? '' : params.get('flow');
      const data = await request(manageRequested ? 'bootstrap' : 'bootstrap?flow=' + encodeURIComponent(flowId));
      if (stopped || current !== generation) return;
      if (!token(data.flowId) || (!manageRequested && data.flowId !== flowId) ||
          (manageRequested ? data.management !== true : data.management === true) ||
          !token(data.csrf) || typeof data.signedIn !== 'boolean' ||
          typeof data.appName !== 'string' || !data.appName || data.appName.length > 80 ||
          (data.signedIn && (typeof data.email !== 'string' || data.email.length > 254))) throw new Error('The sign-in page could not be verified. Open the app again.');
      flowId = data.flowId;
      csrf = data.csrf;
      management = manageRequested;
      signedIn = data.signedIn;
      challengeId = '';
      text('destination', management ? 'Manage your app access on this browser.' : 'Continue to ' + data.appName + '.');
      text('continue-app', 'Open ' + data.appName + ' →');
      text('sign-out', management ? 'Sign out of all apps in this browser' : 'Sign out and use another email');
      text('signed-email', data.email || '');
      text('form-title', management ? 'Your Vellivex access.' : signedIn ? 'Ready when you are.' : 'Let’s get you in.');
      ready = true;
      elements['restart-panel'].hidden = !management || signedIn;
      status();
      render();
      if (!signedIn && !management) elements['access-email'].focus();
    } catch (error) {
      if (current === generation && !stopped) fatal(error?.message || 'Sign-in is temporarily unavailable. Please try again later.');
    }
  }
  async function sendCode(isResend = false) {
    if (busy || stopped || !ready || management) return;
    if (isResend && (!challengeId || now() < resendAt)) return;
    if (!isResend) {
      const input = elements['access-email'];
      const email = input.value.trim();
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || (input.checkValidity && !input.checkValidity())) {
        status('Enter a valid email address.', true);
        input.focus();
        return;
      }
      selectedEmail = email;
      selectedOptIn = elements['access-updates'].checked === true;
    }
    await run(async current => {
      // A resend can retire the prior code even when its delivery acknowledgement
      // is lost. Never present the earlier challenge as usable after this point.
      if (isResend) { challengeId = ''; elements['access-code'].value = ''; }
      const data = await request('request-code', {email:selectedEmail, marketingOptIn:selectedOptIn});
      if (current !== generation || stopped) return;
      if (!token(data.challengeId) || data.expiresIn !== 600 || data.resendAfter !== 60) throw new Error('The code request could not be confirmed. Please try again.');
      challengeId = data.challengeId;
      resendAt = now() + data.resendAfter * 1000;
      expiresAt = now() + data.expiresIn * 1000;
      expiredNotice = false;
      elements['access-code'].value = '';
      text('sent-email', selectedEmail);
      status(isResend ? 'A new code has been sent. Only the latest code will work.' : 'Your code has been sent. It expires in ten minutes.');
      render();
    });
    if (!stopped && ready && !busy && challengeId) elements['access-code'].focus();
  }
  elements['access-form'].addEventListener('submit', event => { event.preventDefault(); return sendCode(); });
  elements['resend-code'].addEventListener('click', () => sendCode(true));
  elements['code-form'].addEventListener('submit', event => {
    event.preventDefault();
    if (busy || stopped || !ready) return;
    if (!challengeId || now() >= expiresAt) { updateClocks(); return; }
    const code = elements['access-code'].value.replace(/[\s-]/g, '');
    if (!/^\d{8}$/.test(code)) { status('Enter the eight-digit code from your email.', true); elements['access-code'].focus(); return; }
    return run(async current => {
      const data = await request('verify-code', {challengeId, code});
      if (current !== generation || stopped) return;
      safeRedirect(data.redirectTo);
    }).finally(() => { elements['access-code'].value = ''; });
  });
  elements['change-email'].addEventListener('click', () => {
    if (busy || stopped) return;
    generation++;
    challengeId = '';
    elements['access-code'].value = '';
    selectedEmail = '';
    selectedOptIn = false;
    resendAt = expiresAt = 0;
    status();
    render();
    elements['access-email'].focus();
  });
  elements['continue-app'].addEventListener('click', () => management ? undefined : run(async current => {
    const data = await request('continue', {});
    if (current === generation && !stopped) safeRedirect(data.redirectTo);
  }));
  elements['sign-out'].addEventListener('click', () => run(async current => {
    const data = await request('logout', {});
    if (current !== generation || stopped) return;
    if (data.ok !== true) throw new Error('Sign-out could not be confirmed. Please try again.');
    signedIn = false;
    challengeId = '';
    elements['access-email'].value = '';
    elements['access-updates'].checked = false;
    elements['access-code'].value = '';
    text('signed-email', '');
    text('form-title', 'Let’s get you in.');
    status('You’re signed out. Enter the email you want to use.');
    // Logout may rotate its browser/CSRF binding. Always obtain a fresh one.
    await bootstrap();
  }));
  interval = every(updateClocks, 1000);
  const started = bootstrap();
  return {started, destroy() {
    stopped = true;
    generation++;
    activeControl?.abort();
    if (interval !== null) stopEvery(interval);
    challengeId = csrf = selectedEmail = '';
    elements['access-code'].value = '';
  }};
}

export const ACCESS_JS = `'use strict';\n(${mountAccessUI.toString()})();\n`;
export function accessUiAsset(path) {
  if (path === '/access-ui.js') return {body:ACCESS_JS,type:'text/javascript; charset=utf-8'};
  if (path === '/access.css') return {body:ACCESS_CSS,type:'text/css; charset=utf-8'};
  return null;
}
