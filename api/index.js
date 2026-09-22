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

    // 1. Password Verification Endpoint
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

    let targetPath = pathname;
    if (targetPath === '/' || targetPath === '/index.html') {
      targetPath = '/embed/python';
    }

    // 3. Serve Minimal Pure-Black Password Screen if unauthenticated
    const acceptHeader = req.headers.accept || '';
    const isHtmlRequest = acceptHeader.includes('text/html') || targetPath === '/embed/python';

    if (isHtmlRequest && !isAuthenticated) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(getMinimalAuthHtml());
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

    // 5. Inject Blue style ONLY for the Run button
    if (contentType.includes('text/html')) {
      let html = await targetRes.text();

      const blueStyle = `
        <style>
          button[class*="run"], button[class*="Run"], .run-button {
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
      const buffer = Buffer.from(await targetRes.arrayBuffer());
      if (contentType) res.setHeader('Content-Type', contentType);
      return res.status(targetRes.status).end(buffer);
    }

  } catch (err) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).end(`<h3>Server Proxy Error</h3><pre>${err.message}</pre>`);
  }
};

function getMinimalAuthHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #000000; color: #ffffff; height: 100vh; display: flex; align-items: center; justify-content: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    input { background: #000000; border: 1px solid #222222; border-radius: 6px; color: #ffffff; padding: 12px 16px; font-size: 14px; outline: none; width: 260px; text-align: center; transition: border-color 0.2s; }
    input:focus { border-color: #0066ff; }
  </style>
</head>
<body>
  <input type="password" id="pass" placeholder="Password..." autofocus onkeydown="if(event.key==='Enter') submitAuth()">
  <script>
    async function submitAuth() {
      const pass = document.getElementById('pass').value;
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
          const el = document.getElementById('pass');
          el.value = '';
          el.placeholder = 'Wrong Password';
        }
      } catch (e) {}
    }
  </script>
</body>
</html>`;
}
