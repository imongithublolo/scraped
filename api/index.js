const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 1. Centralized Secret & Hashing Setup
const SALT = process.env.AUTH_SALT || 'app_secure_salt_v1';
const AUTH_COOKIE_NAME = 'site_access_token';

function hashPassword(plainTextPassword) {
  return crypto.scryptSync(plainTextPassword, SALT, 64).toString('hex');
}

// Pre-hashed password map (Stored as hashes, never plain-text)
const HASHED_PASSWORDS = {
  MAIN: hashPassword(process.env.APP_MAIN_PASSWORD || 'MarkX99'),
  IDIOT: hashPassword('67'),
  COMING_SOON: hashPassword('310554'),
  CREDITS: hashPassword('credits99x55')
};

// Generates an HMAC-signed token to verify session role without state
function createSignedToken(role) {
  const payload = Buffer.from(JSON.stringify({ role, exp: Date.now() + 86400000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', SALT).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expectedSignature = crypto.createHmac('sha256', SALT).update(payload).digest('base64url');
  
  if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (data.exp > Date.now()) return data.role;
    } catch (e) {
      return null;
    }
  }
  return null;
}

// In-memory rate limiting store: key -> { failures: number, blockedUntil: number }
const rateLimitMap = new Map();

function checkRateLimit(key) {
  const now = Date.now();
  const record = rateLimitMap.get(key);
  if (!record) return { isBlocked: false, remainingMs: 0 };
  if (record.blockedUntil > now) {
    return { isBlocked: true, remainingMs: record.blockedUntil - now };
  }
  return { isBlocked: false, remainingMs: 0 };
}

function registerFailedAttempt(key) {
  const now = Date.now();
  let record = rateLimitMap.get(key) || { failures: 0, blockedUntil: 0 };
  record.failures += 1;

  if (record.failures >= 5) {
    const extraFailures = record.failures - 5;
    const durationSeconds = 5 * Math.pow(2, extraFailures);
    record.blockedUntil = now + (durationSeconds * 1000);
  }

  rateLimitMap.set(key, record);
  return record;
}

function resetFailedAttempts(key) {
  rateLimitMap.delete(key);
}

function getCookieValue(cookieHeader, name) {
  const match = cookieHeader.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? match[2] : null;
}

module.exports = async (req, res) => {
  try {
    const host = req.headers.host || 'localhost';
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const url = new URL(req.url, `${protocol}://${host}`);
    const pathname = url.pathname;

    const cookies = req.headers.cookie || '';
    const token = getCookieValue(cookies, AUTH_COOKIE_NAME);
    const userRole = verifyToken(token);

    // 1. Serve static local assets
    if (pathname === '/opsec.webp' || pathname === '/guby.mp3') {
      const filePath = path.join(process.cwd(), pathname.slice(1));
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath);
        const contentType = ext === '.webp' ? 'image/webp' : 'audio/mpeg';
        res.setHeader('Content-Type', contentType);
        return res.status(200).end(fs.readFileSync(filePath));
      }
      return res.status(404).end('Not found');
    }

    // 2. Password Verification Endpoint (Constant-Time Verification)
    if (req.method === 'POST' && pathname === '/auth_login') {
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown_ip';
      const clientKey = `${clientIp}`;

      const { isBlocked, remainingMs } = checkRateLimit(clientKey);
      if (isBlocked) {
        const waitSec = Math.ceil(remainingMs / 1000);
        res.setHeader('Content-Type', 'application/json');
        return res.status(429).end(JSON.stringify({ 
          success: false, 
          message: `Too many failed attempts. Try again in ${waitSec} second(s).` 
        }));
      }

      let bodyStr = '';
      for await (const chunk of req) {
        bodyStr += chunk;
      }

      let inputPassword = '';
      try {
        const json = JSON.parse(bodyStr);
        inputPassword = json.password || '';
      } catch (e) {}

      const inputHash = hashPassword(inputPassword);

      let grantedRole = null;
      if (crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(HASHED_PASSWORDS.IDIOT))) {
        grantedRole = 'idiot';
      } else if (crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(HASHED_PASSWORDS.COMING_SOON))) {
        grantedRole = 'coming_soon';
      } else if (crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(HASHED_PASSWORDS.CREDITS))) {
        grantedRole = 'credits';
      } else if (crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(HASHED_PASSWORDS.MAIN))) {
        grantedRole = 'main';
      }

      if (grantedRole) {
        resetFailedAttempts(clientKey);
        const signedToken = createSignedToken(grantedRole);
        res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${signedToken}; Path=/; HttpOnly; SameSite=Lax`);
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).end(JSON.stringify({ success: true, role: grantedRole }));
      } else {
        const record = registerFailedAttempt(clientKey);
        const newlyBlocked = record.blockedUntil > Date.now();
        const waitSec = newlyBlocked ? Math.ceil((record.blockedUntil - Date.now()) / 1000) : 0;

        res.setHeader('Content-Type', 'application/json');
        return res.status(401).end(JSON.stringify({ 
          success: false,
          blocked: newlyBlocked,
          message: newlyBlocked ? `Too many wrong attempts! Blocked for ${waitSec}s.` : 'Wrong password'
        }));
      }
    }

    // 3. Render Views Based on Session Role Inside the Application
    if (!userRole) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(getParticlesAuthHtml());
    }

    if (userRole === 'idiot') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(getIdiotHtml());
    }

    if (userRole === 'coming_soon') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(getComingSoonHtml());
    }

    if (userRole === 'credits') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(getCreditsHtml());
    }

    // 4. Proxy Target Handling for Main User Role
    let targetPath = pathname;
    if (targetPath === '/' || targetPath === '/index.html') {
      targetPath = '/embed/python';
    }

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

    if (contentType.includes('text/html')) {
      let html = await targetRes.text();

      const injectedPayload = `
        <link rel="icon" type="image/png" href="https://ssl.gstatic.com/classroom/favicon.png">
        <link rel="shortcut icon" href="https://ssl.gstatic.com/classroom/favicon.png">
        <style>
          button[class*="run"], button[class*="Run"], .run-button {
            background-color: #0066ff !important;
            background: #0066ff !important;
            border-color: #0066ff !important;
            color: #ffffff !important;
          }
        </style>
        <script>
          (function() {
            document.title = "Classes";
          })();
        </script>
      `;

      html = html.replace('</head>', `${injectedPayload}</head>`);
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

function getParticlesAuthHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Classes</title>
  <link rel="icon" type="image/png" href="https://ssl.gstatic.com/classroom/favicon.png">
  <style>
    body { background: #000; color: #fff; height: 100vh; display: flex; align-items: center; justify-content: center; font-family: monospace; }
    input { background: #000; border: 2px solid #fff; color: #fff; padding: 12px; text-align: center; font-size: 16px; }
  </style>
</head>
<body>
  <input type="password" id="pass" placeholder="Password..." autofocus onkeydown="if(event.key==='Enter') submitAuth()">
  <script>
    async function submitAuth() {
      const pass = document.getElementById('pass').value;
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
        el.placeholder = data.message || 'Wrong Password';
      }
    }
  </script>
</body>
</html>`;
}

function getComingSoonHtml() {
  return `<!DOCTYPE html><html><body style="background:#000;color:#fff;font-family:monospace;display:flex;justify-content:center;align-items:center;height:100vh;"><h1>Proxy coming soon...</h1></body></html>`;
}

function getCreditsHtml() {
  return `<!DOCTYPE html><html><body style="background:#000;color:#fff;font-family:monospace;display:flex;justify-content:center;align-items:center;height:100vh;"><h1>CREDITS</h1></body></html>`;
}

function getIdiotHtml() {
  return `<!DOCTYPE html><html><body style="background:#000;color:#f00;font-family:sans-serif;text-align:center;padding-top:20%;"><h1>YOU ARE AN IDIOT</h1></body></html>`;
}
