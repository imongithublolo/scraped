const crypto = require('crypto');

const PASSWORD = 'MarkX99';
const AUTH_COOKIE_NAME = 'site_access_token';
const AUTH_TOKEN = crypto.createHash('sha256').update(PASSWORD + '_secret_salt').digest('hex');

module.exports = async (req, res) => {
  try {
    const host = req.headers.host || 'localhost';
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const url = new URL(req.url, `${protocol}://${host}`);
    const pathname = url.pathname;

    // 1. Handle Password Verification Endpoint
    if (req.method === 'POST' && pathname === '/auth_login') {
      let bodyStr = '';
      for await (const chunk of req) {
        bodyStr += chunk;
      }
      let password = '';
      try {
        const json = JSON.parse(bodyStr);
        password = json.password;
      } catch (e) {}

      if (password === PASSWORD) {
        res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).end(JSON.stringify({ success: true }));
      } else {
        res.setHeader('Content-Type', 'application/json');
        return res.status(401).end(JSON.stringify({ success: false }));
      }
    }

    // 2. Read Authentication Cookie
    const cookies = req.headers.cookie || '';
    const isAuthenticated = cookies.includes(`${AUTH_COOKIE_NAME}=${AUTH_TOKEN}`);

    // Map root to OneCompiler python embed
    let targetPath = pathname;
    if (targetPath === '/' || targetPath === '/index.html') {
      targetPath = '/embed/python';
    }

    // 3. Serve Password Menu if user is not authenticated and requesting the HTML page
    const acceptHeader = req.headers.accept || '';
    const isHtmlRequest = acceptHeader.includes('text/html') || targetPath === '/embed/python';

    if (isHtmlRequest && !isAuthenticated) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(getMenuHtml());
    }

    // 4. Fetch target directly from OneCompiler
    const targetUrl = `https://onecompiler.com${targetPath}${url.search}`;
    
    const forwardHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://onecompiler.com/embed/python',
      'Origin': 'https://onecompiler.com',
    };

    if (req.headers['content-type']) {
      forwardHeaders['Content-Type'] = req.headers['content-type'];
    }

    let reqBody = undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      reqBody = Buffer.concat(chunks);
    }

    const targetRes = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: reqBody
    });

    const contentType = targetRes.headers.get('content-type') || '';

    res.setHeader('Access-Control-Allow-Origin', '*');

    // If HTML, inject Blue Run Button CSS
    if (contentType.includes('text/html')) {
      let html = await targetRes.text();

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

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(targetRes.status).end(html);
    } else {
      // Pass through static chunks / assets / JSON responses
      const buffer = Buffer.from(await targetRes.arrayBuffer());
      if (contentType) res.setHeader('Content-Type', contentType);
      return res.status(targetRes.status).end(buffer);
    }

  } catch (err) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).end(`<h3>Server Proxy Error</h3><pre>${err.message}</pre>`);
  }
};

function getMenuHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dev Workspace Menu</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; height: 100vh; display: flex; align-items: center; justify-content: center; }
    .container { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 36px; width: 100%; max-width: 400px; box-shadow: 0 15px 35px rgba(0,0,0,0.6); text-align: center; }
    .icon { font-size: 38px; margin-bottom: 12px; }
    h1 { font-size: 20px; font-weight: 700; color: #f0f6fc; margin-bottom: 6px; }
    p { font-size: 13px; color: #8b949e; margin-bottom: 24px; line-height: 1.4; }
    .input-group { margin-bottom: 16px; text-align: left; }
    label { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #8b949e; display: block; margin-bottom: 6px; }
    input { width: 100%; padding: 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #fff; font-size: 14px; outline: none; transition: border 0.2s; }
    input:focus { border-color: #0066ff; }
    button { width: 100%; padding: 12px; background: #0066ff; color: #fff; border: none; border-radius: 6px; font-weight: 600; font-size: 14px; cursor: pointer; transition: background 0.2s; }
    button:hover { background: #0052cc; }
    .error { color: #f85149; font-size: 12px; margin-top: 12px; display: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">🐍</div>
    <h1>Python Workspace</h1>
    <p>Select your option below and enter your access key to enter the environment.</p>
    
    <div class="input-group">
      <label>Encryption Key</label>
      <input type="password" id="pass" placeholder="Enter password..." onkeydown="if(event.key==='Enter') submitAuth()">
    </div>

    <button onclick="submitAuth()">Launch Workspace</button>
    <div id="err-msg" class="error">Incorrect encryption key.</div>
  </div>

  <script>
    async function submitAuth() {
      const pass = document.getElementById('pass').value;
      const err = document.getElementById('err-msg');
      err.style.display = 'none';

      try {
        const res = await fetch('/auth_login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pass })
        });
        const data = await res.json();
        if (data.success) {
          window.location.reload();
        } else {
          err.style.display = 'block';
        }
      } catch (e) {
        err.style.display = 'block';
      }
    }
  </script>
</body>
</html>`;
}
