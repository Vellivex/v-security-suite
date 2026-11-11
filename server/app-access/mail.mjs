// Transactional verification only. No audience subscription or tracking pixels.
const keyPattern = /^re_[A-Za-z0-9_-]{1,256}$/;
const cancel = stream => { try { void Promise.resolve(stream?.cancel()).catch(() => {}); } catch {} };

export function createVerificationMailer(key, { transport = fetch, timeoutMs = 8000 } = {}) {
  if (typeof key !== 'string' || !keyPattern.test(key)) return null;
  return async ({ email, code, id }) => {
    if (typeof email !== 'string' || email.length > 254 || /[\r\n\0]/.test(email) ||
        typeof code !== 'string' || !/^\d{8}$/.test(code) ||
        typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id)) throw Error('Verification unavailable');
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(Error('Verification unavailable')); }, timeoutMs);
    });
    const send = async () => {
      const response = await transport('https://api.resend.com/emails', {
        method: 'POST', redirect: 'manual', credentials: 'omit', signal: controller.signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': `va-signin-${id}` },
        body: JSON.stringify({
          from: 'Vellivex <v@vellivex.com>', to: [email], reply_to: 'v@vellivex.com',
          subject: 'Your Vellivex sign-in code',
          text: `Your Vellivex sign-in code is ${code}.\n\nEnter it only on the Vellivex page where you requested it. It expires in 10 minutes and works once.\n\nThis verifies your email for access to Vellivex apps. If you did not request it, ignore this email. Never share this code.\n\nVellivex\nv@vellivex.com`
        })
      });
      const length = response.headers.get('content-length');
      if (response.status !== 200 || controller.signal.aborted || !response.body ||
          response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
          (length !== null && (!/^\d{1,4}$/.test(length) || Number(length) > 2048))) {
        cancel(response.body); throw Error('Verification unavailable');
      }
      const reader = response.body.getReader(), chunks = [];
      let bytes = 0, count = 0, done = false;
      const abort = () => cancel(reader);
      controller.signal.addEventListener('abort', abort, { once: true });
      try {
        for (;;) {
          const item = await reader.read();
          if (controller.signal.aborted) throw Error('Verification unavailable');
          if (item.done) break;
          if (!(item.value instanceof Uint8Array) || ++count > 128 || (bytes += item.value.byteLength) > 2048) throw Error('Verification unavailable');
          chunks.push(item.value.slice());
        }
        done = true;
        const body = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
        const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
        if (!result || Array.isArray(result) || typeof result.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(result.id)) throw Error('Verification unavailable');
      } finally {
        controller.signal.removeEventListener('abort', abort);
        if (!done) cancel(reader);
        try { reader.releaseLock(); } catch {}
      }
    };
    try { await Promise.race([send(), deadline]); }
    catch { throw Error('Verification unavailable'); }
    finally { clearTimeout(timer); controller.abort(); }
  };
}
