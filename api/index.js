const { createProxyMiddleware } = require('http-proxy-middleware');
const crypto = require('crypto');

// Master Password & Cryptographic Config
const PASSWORD = 'MarkX99';
const SALT = crypto.createHash('sha256').update(PASSWORD + '_salt').digest();
const KEY = crypto.pbkdf2Sync(PASSWORD, SALT, 100000, 32, 'sha256'); // AES-256 Key

// Pre-calculate SHA-256 hash of password for client-side quick validation
const PASSWORD_HASH = crypto.createHash('sha256').update(PASSWORD).digest('hex');

const proxy = createProxyMiddleware({
  target: 'https://onecompiler.com',
  changeOrigin: true,
  selfHandleResponse: true,
  pathRewrite: (path, req) => {
    if (path === '/' || path === '/index.html') {
      return '/embed/python';
    }
    return path;
  },
  headers: {
    'Referer': 'https://onecompiler.com/embed/python',
    'Origin': 'https://onecompiler.com',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
  },
  onProxyRes: function (proxyRes, req, res) {
    delete proxyRes.headers['x-frame-options'];
    delete proxyRes.headers['content-security-policy'];
    delete proxyRes.headers['access-control-allow-origin'];
    res.setHeader('Access-Control-Allow-Origin', '*');

    const contentType = proxyRes.headers['content-type'] || '';
    if (contentType.includes('text/html')) {
      let body = Buffer.from([]);

      proxyRes.on('data', (chunk) => {
        body = Buffer.concat([body, chunk]);
      });

      proxyRes.on('end', () => {
        let html = body.toString('utf8');

        // 1. Force Run Button to remain permanently locked as Blue (#0066ff)
        const blueStyle = `
          <style>
            button[class*="run"], button[class*="Run"], .run-button, button:has(svg) {
              background-color: #0066ff !important;
              background: #0066ff !important;
              border-color: #0066ff !important;
              color: #ffffff !important;
            }
            button[class*="run"]:hover, button[class*="Run"]:hover {
              background-color: #0052cc !important;
              background: #0052cc !important;
            }
          </style>
        `;
        html = html.replace('</head>', `${blueStyle}</head>`);

        // 2. AES-256-GCM Encrypt the entire HTML page payload
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
        let encrypted = cipher.update(html, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag().toString('hex');

        // 3. Return an uncrackable Lock Screen wrapper containing only the encrypted ciphertext
        const lockScreenHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Protected Environment</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 32px; width: 100%; max-width: 360px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center; }
    h2 { font-size: 18px; margin-bottom: 8px; color: #58a6ff; }
    p { font-size: 12px; color: #8b949e; margin-bottom: 20px; }
    input { width: 100%; padding: 10px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #fff; font-size: 14px; outline: none; margin-bottom: 12px; }
    input:focus { border-color: #58a6ff; }
    button { width: 100%; padding: 10px; background: #0066ff; color: #fff; border: none; border-radius: 6px; font-weight: 600; font-size: 14px; cursor: pointer; }
    button:hover { background: #0052cc; }
    .error { color: #f85149; font-size: 12px; margin-top: 10px; display: none; }
  </style>
</head>
<body>
  <div class="card" id="lock-card">
    <h2>🔒 Access Restricted</h2>
    <p>Enter the encryption key to unlock workspace</p>
    <input type="password" id="pass" placeholder="Enter key..." onkeydown="if(event.key==='Enter') unlock()">
    <button onclick="unlock()">Decrypt & Unlock</button>
    <div id="err" class="error">Invalid Key</div>
  </div>

  <script>
    const CIPHERTEXT = "${encrypted}";
    const IV = "${iv.toString('hex')}";
    const AUTH_TAG = "${authTag}";
    const EXPECTED_HASH = "${PASSWORD_HASH}";

    async function unlock() {
      const input = document.getElementById('pass').value;
      const errEl = document.getElementById('err');
      
      // Hash check
      const msgUint8 = new TextEncoder().encode(input);
      const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

      if (hashHex !== EXPECTED_HASH) {
        errEl.style.display = 'block';
        return;
      }

      try {
        // Derive key client-side with PBKDF2
        const keyMaterial = await crypto.subtle.importKey("raw", msgUint8, "PBKDF2", false, ["deriveKey"]);
        const salt = new TextEncoder().encode("MarkX99_salt");
        const aesKey = await crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
          keyMaterial,
          { name: "AES-GCM", length: 256 },
          false,
          ["decrypt"]
        );

        // Decrypt AES-256-GCM payload
        const hexToBuf = hex => new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        const ctBuf = hexToBuf(CIPHERTEXT);
        const tagBuf = hexToBuf(AUTH_TAG);
        const combined = new Uint8Array(ctBuf.length + tagBuf.length);
        combined.set(ctBuf);
        combined.set(tagBuf, ctBuf.length);

        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: hexToBuf(IV) },
          aesKey,
          combined
        );

        const decryptedHtml = new TextDecoder().decode(decrypted);
        document.open();
        document.write(decryptedHtml);
        document.close();
      } catch (e) {
        errEl.style.display = 'block';
      }
    }
  </script>
</body>
</html>`;

        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(lockScreenHtml);
      });
    } else {
      proxyRes.pipe(res);
    }
  }
});

module.exports = (req, res) => {
  return proxy(req, res);
};
