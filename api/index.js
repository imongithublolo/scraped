const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Centralized Secret & Hashing Setup
const SALT = process.env.AUTH_SALT || 'app_secure_salt_v1';
const AUTH_COOKIE_NAME = 'site_access_token';

function hashPassword(plainTextPassword) {
  return crypto.scryptSync(plainTextPassword, SALT, 64).toString('hex');
}

// Multi-User Database Architecture
const USERS = {
  b29s: {
    passwordHash: hashPassword('Wspeed67.100.455310'),
    role: 'admin'
  },
  main_user: {
    passwordHash: hashPassword(process.env.APP_MAIN_PASSWORD || 'MarkX99'),
    role: 'main'
  },
  idiot_user: {
    passwordHash: hashPassword('67'),
    role: 'idiot'
  },
  coming_soon_user: {
    passwordHash: hashPassword('310554'),
    role: 'coming_soon'
  },
  credits_user: {
    passwordHash: hashPassword('credits99x55'),
    role: 'credits'
  }
};

function createSignedToken(username, role, isMain = false) {
  const ttl = isMain ? 10000 : 86400000; // Main sessions expire quickly so refreshes trigger re-auth
  const payload = Buffer.from(JSON.stringify({ username, role, exp: Date.now() + ttl })).toString('base64url');
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
      if (data.exp > Date.now()) return data;
    } catch (e) {
      return null;
    }
  }
  return null;
}

// In-memory rate limiting store
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
    const authData = verifyToken(token);
    const userRole = authData ? authData.role : null;
    const username = authData ? authData.username : null;

    // Public Authentication API Endpoint
    if (req.method === 'POST' && pathname === '/auth_login') {
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown_ip';
      const clientKey = `${clientIp}`;

      const { isBlocked, remainingMs } = checkRateLimit(clientKey);
      if (isBlocked) {
        const waitSec = Math.ceil(remainingMs / 1000);
        res.setHeader('Content-Type', 'application/json');
        return res.status(429).end(JSON.stringify({ 
          success: false, 
          message: `System locked. Retry in ${waitSec}s.` 
        }));
      }

      let bodyStr = '';
      for await (const chunk of req) {
        bodyStr += chunk;
      }

      let inputUsername = '';
      let inputPassword = '';
      let command = '';
      try {
        const json = JSON.parse(bodyStr);
        inputUsername = (json.username || '').trim();
        inputPassword = (json.password || '').trim();
        command = (json.command || '').trim();
      } catch (e) {}

      // Handle CLI Command Routing
      if (command.toLowerCase() === 'help') {
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).end(JSON.stringify({ success: false, cliOutput: 'Good luck' }));
      }

      const targetPass = inputPassword || command;

      if ((!inputUsername && targetPass === 'admin') || command === 'admin') {
        resetFailedAttempts(clientKey);
        const signedToken = createSignedToken('guest_admin', 'admin_prompt');
        res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${signedToken}; Path=/; HttpOnly; SameSite=Lax`);
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).end(JSON.stringify({ success: true, redirect: '/admin' }));
      }

      const inputHash = hashPassword(targetPass);
      let matchedUser = null;
      let matchedUsername = null;

      if (inputUsername && USERS[inputUsername]) {
        const candidate = USERS[inputUsername];
        if (crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(candidate.passwordHash))) {
          matchedUser = candidate;
          matchedUsername = inputUsername;
        }
      } else {
        for (const [uname, userObj] of Object.entries(USERS)) {
          if (crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(userObj.passwordHash))) {
            matchedUser = userObj;
            matchedUsername = uname;
            break;
          }
        }
      }

      if (matchedUser) {
        resetFailedAttempts(clientKey);
        const isMain = matchedUser.role === 'main';
        const signedToken = createSignedToken(matchedUsername, matchedUser.role, isMain);
        res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${signedToken}; Path=/; HttpOnly; SameSite=Lax`);
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).end(JSON.stringify({ success: true, role: matchedUser.role, username: matchedUsername }));
      } else {
        const record = registerFailedAttempt(clientKey);
        const newlyBlocked = record.blockedUntil > Date.now();
        const waitSec = newlyBlocked ? Math.ceil((record.blockedUntil - Date.now()) / 1000) : 0;

        res.setHeader('Content-Type', 'application/json');
        return res.status(401).end(JSON.stringify({ 
          success: false,
          blocked: newlyBlocked,
          cliOutput: newlyBlocked ? `ACCESS DENIED: Locked out for ${waitSec}s.` : `command not found: ${command || targetPass}`
        }));
      }
    }

    // REQUIRE AUTHENTICATION FOR ALL OTHER PATHS & ASSETS
    if (!userRole) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(getHyprlandCliAuthHtml(false));
    }

    // Serving Authenticated Local Static Assets
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

    // Admin Route Handling
    if (pathname === '/admin') {
      if (userRole === 'admin') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).end(getHyprlandAdminShellHtml(username));
      } else if (userRole === 'admin_prompt') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).end(getHyprlandCliAuthHtml(true));
      } else {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).end(getHyprlandCliAuthHtml(false));
      }
    }

    // Special Role Views & Token Invalidation
    if (userRole === 'idiot') {
      res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(getIdiotHtml());
    }

    if (userRole === 'coming_soon') {
      res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(getComingSoonHtml());
    }

    if (userRole === 'credits') {
      res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(getCreditsHtml());
    }

    // Clear main user token on serve so any sub-request/refresh locks page
    if (userRole === 'main') {
      res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    }

    // Proxy Request for Authenticated Main/Admin Session
    let targetPath = pathname;
    let targetHost = 'onecompiler.com';

    if (pathname.startsWith('/__glasspane/')) {
      targetHost = 'glasspane.pages.dev';
      targetPath = pathname.replace('/__glasspane', '');
    } else if (targetPath === '/' || targetPath === '/index.html') {
      targetPath = '/embed/python';
    }

    const targetUrl = `https://${targetHost}${targetPath}${url.search}`;
    
    const forwardHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': `https://${targetHost}/`,
      'Origin': `https://${targetHost}`,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.5'
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', '*');

    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');

    if (contentType.includes('text/html')) {
      let html = await targetRes.text();
      html = html.replace(/https?:\/\/glasspane\.pages\.dev/g, `${protocol}://${host}/__glasspane`);

      html = html.replace(/(href|src)=["']\/([^"']+)["']/g, (match, attr, path) => {
        if (path.startsWith('http') || path.startsWith('//')) return match;
        return `${attr}="/${path}"`;
      });

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
          button[class*="run"]:hover, button[class*="Run"]:hover {
            background-color: #0052cc !important;
            background: #0052cc !important;
          }
        </style>
        <script>
          (function() {
            document.title = "Classes";

            const origFetch = window.fetch;
            window.fetch = function(url, options) {
              if (typeof url === 'string' && url.includes('glasspane.pages.dev')) {
                url = url.replace(/https?:\/\/glasspane\.pages\.dev/, '/__glasspane');
              }
              return origFetch.apply(this, arguments);
            };

            const STATE_KEY = 'oc_full_user_state';

            function getSavedState() {
              try { return JSON.parse(localStorage.getItem(STATE_KEY)) || {}; }
              catch(e) { return {}; }
            }

            function saveState(key, val) {
              const state = getSavedState();
              state[key] = val;
              localStorage.setItem(STATE_KEY, JSON.stringify(state));
            }

            function isPageDark() {
              return document.documentElement.classList.contains('dark') || 
                     document.body.classList.contains('dark') || 
                     !!document.querySelector('.dark, [data-theme="dark"]');
            }

            function findThemeBtn() {
              return Array.from(document.querySelectorAll('button, div[role="button"], a, svg')).find(el => {
                const text = (el.innerText || el.getAttribute('aria-label') || el.title || el.className || '').toLowerCase();
                return text.includes('theme') || text.includes('mode') || text.includes('dark') || text.includes('light');
              });
            }

            function initSync() {
              let restoredCode = false;
              let restoredTheme = false;

              setInterval(() => {
                if (document.title !== "Classes") document.title = "Classes";

                const state = getSavedState();

                if (window.monaco && window.monaco.editor) {
                  const editors = window.monaco.editor.getEditors();
                  if (editors.length > 0) {
                    const editor = editors[0];

                    if (state.code && (!restoredCode || editor.getValue() !== state.code)) {
                      if (!restoredCode) {
                        editor.setValue(state.code);
                        restoredCode = true;
                      }
                    }

                    if (!editor.datasetBound) {
                      editor.datasetBound = true;
                      editor.onDidChangeModelContent(() => {
                        saveState('code', editor.getValue());
                      });
                    }
                  }
                }

                if (state.theme && !restoredTheme) {
                  const currentlyDark = isPageDark();
                  if ((state.theme === 'dark' && !currentlyDark) || (state.theme === 'light' && currentlyDark)) {
                    const themeBtn = findThemeBtn();
                    if (themeBtn) {
                      themeBtn.click();
                      restoredTheme = true;
                    }
                  } else {
                    restoredTheme = true;
                  }
                }

                document.querySelectorAll('button, div[role="button"], a').forEach(btn => {
                  if (btn.dataset.themeTracker) return;
                  const text = (btn.innerText || btn.getAttribute('aria-label') || btn.title || btn.className || '').toLowerCase();
                  if (text.includes('theme') || text.includes('mode') || text.includes('dark') || text.includes('light')) {
                    btn.dataset.themeTracker = 'true';
                    btn.addEventListener('click', () => {
                      setTimeout(() => {
                        saveState('theme', isPageDark() ? 'dark' : 'light');
                      }, 300);
                    });
                  }
                });

                document.querySelectorAll('textarea, input[type="text"]').forEach((el, idx) => {
                  const key = 'input_' + (el.id || el.placeholder || idx);

                  if (state[key] !== undefined && !el.dataset.restored) {
                    el.value = state[key];
                    el.dataset.restored = 'true';
                  }

                  if (!el.dataset.tracker) {
                    el.dataset.tracker = 'true';
                    el.addEventListener('input', () => {
                      saveState(key, el.value);
                    });
                  }
                });

              }, 250);
            }

            if (document.readyState === 'complete') initSync();
            else window.addEventListener('load', initSync);
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

// Admin View with Frosted Glass & Dragging
function getHyprlandAdminShellHtml(username) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Classes</title>
  <link rel="icon" type="image/png" href="https://ssl.gstatic.com/classroom/favicon.png">
  <link rel="shortcut icon" href="https://ssl.gstatic.com/classroom/favicon.png">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #000000;
      color: #ffffff;
      height: 100vh;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Courier New', Courier, monospace;
    }
    #particles-js { position: absolute; width: 100%; height: 100%; top: 0; left: 0; z-index: 1; }
    
    .hypr-window {
      position: absolute;
      z-index: 2;
      width: 850px;
      height: 520px;
      background: rgba(18, 18, 18, 0.55);
      border: 1px solid rgba(255, 255, 255, 0.25);
      border-radius: 8px;
      box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.7);
      display: flex;
      flex-direction: column;
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
    }
    .hypr-header {
      background: rgba(255, 255, 255, 0.05);
      padding: 10px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      cursor: move;
      user-select: none;
    }
    .hypr-title { font-size: 13px; color: #aaaaaa; font-weight: bold; }
    .hypr-dots { display: flex; gap: 6px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; background: #444444; }

    .hypr-body {
      padding: 20px;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 15px;
    }
    .admin-badge {
      border: 1px solid rgba(255, 255, 255, 0.3);
      color: #ffffff;
      padding: 10px;
      border-radius: 4px;
      font-size: 14px;
      background: rgba(255, 255, 255, 0.03);
    }
    .terminal-out {
      color: #cccccc;
      font-size: 14px;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div id="particles-js"></div>
  <div class="hypr-window" id="drag-win">
    <div class="hypr-header" id="drag-header">
      <div class="hypr-title">tty2 ~ user@murke</div>
      <div class="hypr-dots">
        <span class="dot"></span>
        <span class="dot"></span>
        <span class="dot"></span>
      </div>
    </div>
    <div class="hypr-body">
      <div class="admin-badge">LOGGED IN AS: [${username || 'b29s'}]</div>
      <div class="terminal-out">
        > SYSTEM STATE: SECURE<br>
        > ROLES LOADED: admin, main, idiot, coming_soon, credits<br>
        > CONTROL SHELL ACTIVE.
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/particles.js@2.0.0/particles.min.js"></script>
  <script>
    particlesJS('particles-js', {
      particles: {
        number: { value: 60, density: { enable: true, value_area: 800 } },
        color: { value: '#ffffff' },
        shape: { type: 'circle' },
        opacity: { value: 0.3 },
        size: { value: 2 },
        line_linked: { enable: true, distance: 120, color: '#ffffff', opacity: 0.15, width: 1 },
        move: { enable: true, speed: 1.2 }
      }
    });

    // Window Dragging Logic
    const win = document.getElementById('drag-win');
    const header = document.getElementById('drag-header');
    let isDragging = false, startX, startY, initialLeft, initialTop;

    header.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = win.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      win.style.margin = '0';
      win.style.left = initialLeft + 'px';
      win.style.top = initialTop + 'px';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      win.style.left = (initialLeft + dx) + 'px';
      win.style.top = (initialTop + dy) + 'px';
    });

    document.addEventListener('mouseup', () => { isDragging = false; });
  </script>
</body>
</html>`;
}

// Hyprland Floating Window CLI Interface with Frosted Glass & Dragging
function getHyprlandCliAuthHtml(isAdminPrompt = false) {
  const murkeBanner = `
  ███▄ ▄███▓ █    ██  ██▀███   ██ ▄█▀ ▓█████ 
 ▓██▒▀█▀ ██▒ ██   ▓██▒▓██ ▒ ██▒ ██▄█▒ ▓█   ▀ 
 ▓██    ▓██░▓██   ▒██░▓██ ░▄█ ▒▓███▄░ ▒███   
 ▒██    ▒██ ▓▓█   ░██░▒██▀▀█▄  ▓██ █▄ ▒▓█  ▄ 
 ▒██▒   ░██▒▒▒█████▓ ░██▓ ▒██▒▒██▒ █▄░▒████▒
 ░ ▒░   ░ ░ ░▒▓▒ ▒ ▒ ░ ▒▓ ░▒▓░▒ ▒▒ ▓▒░░ ▒░ ░
 ░  ░     ░ ░░▒░ ░ ░   ░▒ ░ ▒░░ ░▒ ▒░ ░ ░  ░
 ░      ░    ░░░ ░ ░   ░░   ░ ░ ░░ ░    ░   
        ░      ░        ░     ░  ░      ░  ░`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Classes</title>
  <link rel="icon" type="image/png" href="https://ssl.gstatic.com/classroom/favicon.png">
  <link rel="shortcut icon" href="https://ssl.gstatic.com/classroom/favicon.png">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      background: #000000; 
      color: #ffffff; 
      height: 100vh; 
      overflow: hidden; 
      display: flex; 
      align-items: center; 
      justify-content: center; 
      font-family: 'Courier New', Courier, monospace; 
      position: relative; 
    }
    #particles-js { position: absolute; width: 100%; height: 100%; top: 0; left: 0; z-index: 1; }

    /* Frosted Glass Hyprland Window */
    .hypr-window {
      position: absolute;
      z-index: 2;
      width: 850px;
      height: 520px;
      background: rgba(15, 15, 15, 0.55);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 8px;
      box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.8);
      display: flex;
      flex-direction: column;
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
    }
    .hypr-header {
      background: rgba(255, 255, 255, 0.05);
      padding: 10px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      cursor: move;
      user-select: none;
    }
    .hypr-title { font-size: 12px; color: #888888; }
    .hypr-dots { display: flex; gap: 6px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; background: #333333; }

    .cli-body {
      flex: 1;
      padding: 18px;
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      gap: 10px;
    }
    .ascii-banner {
      font-size: 11px;
      line-height: 1.1;
      color: #ffffff;
      white-space: pre;
      margin-bottom: 10px;
      user-select: none;
    }
    .cli-log { font-size: 13px; color: #aaaaaa; line-height: 1.4; white-space: pre-wrap; }
    .cli-input-row { display: flex; align-items: center; gap: 8px; margin-top: 5px; }
    .prompt { color: #ffffff; font-weight: bold; font-size: 14px; }
    input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: #ffffff;
      font-family: 'Courier New', Courier, monospace;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div id="particles-js"></div>
  <div class="hypr-window" id="drag-win">
    <div class="hypr-header" id="drag-header">
      <div class="hypr-title">kitty ~ user@murke</div>
      <div class="hypr-dots">
        <span class="dot"></span>
        <span class="dot"></span>
        <span class="dot"></span>
      </div>
    </div>
    <div class="cli-body" id="cli-body" onclick="document.getElementById('cmd-input').focus()">
      <pre class="ascii-banner">${murkeBanner}</pre>
      <div class="cli-log" id="cli-log">Hyprland v0.35.0 (tty1)
Type command or passphrase to authenticate...</div>
      ${isAdminPrompt ? '<div class="cli-input-row"><span class="prompt">admin@murke:~$</span><input type="text" id="uname" placeholder="username" autofocus></div>' : ''}
      <div class="cli-input-row">
        <span class="prompt">${isAdminPrompt ? 'pass@murke:~$ ' : 'user@murke:~$ '}</span>
        <input type="password" id="cmd-input" autofocus onkeydown="handleCli(event)">
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/particles.js@2.0.0/particles.min.js"></script>
  <script>
    particlesJS('particles-js', {
      particles: {
        number: { value: 70, density: { enable: true, value_area: 800 } },
        color: { value: '#ffffff' },
        shape: { type: 'circle' },
        opacity: { value: 0.4 },
        size: { value: 2, random: true },
        line_linked: { enable: true, distance: 130, color: '#ffffff', opacity: 0.2, width: 1 },
        move: { enable: true, speed: 1.5 }
      },
      retina_detect: true
    });

    // Window Dragging Logic
    const win = document.getElementById('drag-win');
    const header = document.getElementById('drag-header');
    let isDragging = false, startX, startY, initialLeft, initialTop;

    header.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = win.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      win.style.margin = '0';
      win.style.left = initialLeft + 'px';
      win.style.top = initialTop + 'px';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      win.style.left = (initialLeft + dx) + 'px';
      win.style.top = (initialTop + dy) + 'px';
    });

    document.addEventListener('mouseup', () => { isDragging = false; });

    async function handleCli(e) {
      if (e.key !== 'Enter') return;
      
      const inputEl = document.getElementById('cmd-input');
      const unameEl = document.getElementById('uname');
      const logEl = document.getElementById('cli-log');
      
      const cmd = inputEl.value.trim();
      const uname = unameEl ? unameEl.value.trim() : '';

      if (cmd === 'clear') {
        logEl.innerHTML = '';
        inputEl.value = '';
        return;
      }

      try {
        const res = await fetch('/auth_login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: uname, command: cmd })
        });
        const data = await res.json();
        
        if (data.success) {
          if (data.redirect) window.location.href = data.redirect;
          else window.location.reload();
        } else {
          logEl.innerHTML += '\\n> ' + (data.cliOutput || data.message || 'Error: Unauthorized access');
          inputEl.value = '';
          const body = document.getElementById('cli-body');
          body.scrollTop = body.scrollHeight;
        }
      } catch (err) {
        logEl.innerHTML += '\\n> System network error.';
      }
    }
  </script>
</body>
</html>`;
}

function getComingSoonHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Classes</title>
  <link rel="icon" type="image/png" href="https://ssl.gstatic.com/classroom/favicon.png">
  <link rel="shortcut icon" href="https://ssl.gstatic.com/classroom/favicon.png">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #000000;
      color: #ffffff;
      height: 100vh;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Courier New', Courier, monospace;
    }
    #particles-js { position: absolute; width: 100%; height: 100%; top: 0; left: 0; z-index: 1; }
    .text-box {
      position: relative;
      z-index: 2;
      font-size: 28px;
      letter-spacing: 2px;
      white-space: nowrap;
      border-right: 3px solid #ffffff;
      padding-right: 5px;
      animation: blink 0.75s step-end infinite;
    }
    @keyframes blink { from, to { border-color: transparent } 50% { border-color: #ffffff; } }
  </style>
</head>
<body>
  <div id="particles-js"></div>
  <div class="text-box" id="typewriter"></div>
  <script src="https://cdn.jsdelivr.net/npm/particles.js@2.0.0/particles.min.js"></script>
  <script>
    particlesJS('particles-js', {
      particles: {
        number: { value: 60, density: { enable: true, value_area: 800 } },
        color: { value: '#ffffff' },
        shape: { type: 'circle' },
        opacity: { value: 0.5 },
        size: { value: 3 },
        line_linked: { enable: true, distance: 130, color: '#ffffff', opacity: 0.3, width: 1 },
        move: { enable: true, speed: 1.5 }
      }
    });

    const text = "proxy coming soon...";
    let i = 0;
    function type() {
      if (i < text.length) {
        document.getElementById('typewriter').innerHTML += text.charAt(i);
        i++;
        setTimeout(type, 120);
      }
    }
    window.onload = type;
  </script>
</body>
</html>`;
}

function getCreditsHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Classes</title>
  <link rel="icon" type="image/png" href="https://ssl.gstatic.com/classroom/favicon.png">
  <link rel="shortcut icon" href="https://ssl.gstatic.com/classroom/favicon.png">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #000000;
      color: #ffffff;
      height: 100vh;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Courier New', Courier, monospace;
    }
    #particles-js { position: absolute; width: 100%; height: 100%; top: 0; left: 0; z-index: 1; }
    .credits-box {
      position: relative;
      z-index: 2;
      border: 1px solid rgba(255, 255, 255, 0.3);
      padding: 30px 40px;
      border-radius: 8px;
      background: rgba(15, 15, 15, 0.65);
      backdrop-filter: blur(16px);
      box-shadow: 0 0 30px rgba(0, 0, 0, 0.8);
      text-align: center;
      max-width: 500px;
      width: 90%;
    }
    h1 {
      font-size: 26px;
      margin-bottom: 25px;
      letter-spacing: 2px;
      text-transform: uppercase;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      padding-bottom: 10px;
    }
    .credit-item { font-size: 18px; margin: 15px 0; line-height: 1.5; color: #dddddd; }
    .role { color: #888888; font-size: 14px; display: block; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 1px; }
    .name { color: #ffffff; font-weight: bold; }
  </style>
</head>
<body>
  <div id="particles-js"></div>
  <div class="credits-box">
    <h1>CREDITS</h1>
    <div class="credit-item">
      <span class="role">Opsec demon</span>
      <span class="name">Mark b</span>
    </div>
    <div class="credit-item">
      <span class="role">One that did everything</span>
      <span class="name">Dan m</span>
    </div>
    <div class="credit-item">
      <span class="role">Emotional Support</span>
      <span class="name">Alfie n</span>
    </div>
    <div class="credit-item">
      <span class="role">Gay Twat</span>
      <span class="name">claude</span>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/particles.js@2.0.0/particles.min.js"></script>
  <script>
    particlesJS('particles-js', {
      particles: {
        number: { value: 60, density: { enable: true, value_area: 800 } },
        color: { value: '#ffffff' },
        shape: { type: 'circle' },
        opacity: { value: 0.5 },
        size: { value: 3 },
        line_linked: { enable: true, distance: 130, color: '#ffffff', opacity: 0.3, width: 1 },
        move: { enable: true, speed: 1.5 }
      }
    });
  </script>
</body>
</html>`;
}

function getIdiotHtml() {
  return `<!DOCTYPE html>
<html>
<head>
  <title>WARNING: IDIOT DETECTED</title>
  <style>
    body {
      background: url('/opsec.webp') no-repeat center center fixed;
      background-size: 100% 100%;
      color: #00ff00;
      font-family: "Comic Sans MS", "Comic Sans", cursive, sans-serif;
      text-align: center;
      padding: 30px;
      margin: 0;
      min-height: 100vh;
      overflow-y: auto;
    }
    h1 {
      font-size: 55px;
      color: #ffff00;
      text-shadow: 5px 5px #ff0000;
      animation: blink 0.4s infinite;
      margin-bottom: 20px;
    }
    @keyframes blink { 0% { opacity: 1; } 50% { opacity: 0; } 100% { opacity: 1; } }
    .box {
      background: #00ffff;
      border: 8px dashed #ff0000;
      padding: 30px;
      font-size: 26px;
      color: #000000;
      margin: 20px auto;
      max-width: 600px;
      font-weight: bold;
    }
    marquee {
      font-size: 32px;
      background: #0000ff;
      color: #ffffff;
      padding: 10px;
      font-weight: bold;
      border: 3px solid #ffff00;
    }
    button {
      font-size: 22px;
      padding: 12px 24px;
      background: #00ff00;
      color: #000000;
      font-family: "Comic Sans MS", cursive;
      border: 4px outset #ffffff;
      cursor: pointer;
      margin-top: 20px;
      font-weight: bold;
    }
    button:hover { background: #ffff00; }
  </style>
</head>
<body>
  <audio id="bg-audio" autoplay loop>
    <source src="/guby.mp3" type="audio/mpeg">
  </audio>
  <script>
    document.addEventListener('click', () => {
      const audio = document.getElementById('bg-audio');
      if (audio.paused) { audio.play().catch(e => {}); }
    }, { once: true });
  </script>
  <marquee behavior="alternate">*** ERROR 404: BRAIN CELL NOT FOUND ***</marquee>
  <h1>YOU ARE AN IDIOT HAHAHAHAHA!!</h1>
  <div class="box">
    <p>WHY WOULD YOU TYPE "67"?! ARE YOU A RETARD??!</p>
    <br>
    <p>WRONG PASSWORD!1!</p>
  </div>
  <p style="font-size: 20px; color: #ffffff; background: #000000; display: inline-block; padding: 10px;">[ CREDITS TO @Mark FOR NOTHING ]</p>
  <br><br>
  <button onclick="window.location.href='/'">CLICK HERE TO GO BACK AND THINK ABOUT WHAT YOU DID</button>
</body>
</html>`;
}
