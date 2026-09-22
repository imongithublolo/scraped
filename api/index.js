const { createProxyMiddleware } = require('http-proxy-middleware');
const crypto = require('crypto');

const PASSWORD = 'MarkX99';
const AUTH_COOKIE_NAME = 'site_access_token';

// Generate a secure token hash based on the password
const AUTH_TOKEN = crypto.createHash('sha256').update(PASSWORD + '_secret_salt').digest('hex');

const proxy = createProxyMiddleware({
  target: 'https://onecompiler.com',
  changeOrigin: true,
  selfHandleResponse: true,
  pathRewrite: (path) => {
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

    // If request is for main HTML page, check authentication
    if (contentType.includes('text/html')) {
      // Parse cookies
      const cookieHeader = req.headers.cookie || '';
      const isAuthenticated = cookieHeader.includes(`${AUTH_COOKIE_NAME}=${AUTH_TOKEN}`);

      // Handle Password Verification API Post
      if (req.method === 'POST' && req.url.includes('auth_login')) {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.password === PASSWORD) {
              res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
              res.setHeader('Content-Type', 'application/json');
              return res.end(JSON.stringify({ success: true }));
            }
          } catch (e) {}
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({ success: false }));
        });
        return;
      }

      // If NOT authenticated, serve the Menu / Unlock Dashboard
      if (!isAuthenticated) {
        const menuHtml = `<!DOCTYPE html>
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
        res.setHeader('content-type', 'text/html; charset=utf-8');
        return res.end(menuHtml);
      }

      // If Authenticated, serve OneCompiler with forced Blue Run button
      let body = Buffer.from([]);
      proxyRes.on('data', chunk => { body = Buffer.concat([body, chunk]); });
      proxyRes.on('end', () => {
        let html = body.toString('utf8');

        // Force Run Button to remain permanently blue
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

        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(html);
      });
    } else {
      proxyRes.pipe(res);
    }
  }
});

module.exports = (req, res) => {
  return proxy(req, res);
};
