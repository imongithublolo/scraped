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
  b29s: { passwordHash: hashPassword('Wspeed67.100.455310'), role: 'admin' },
  main_user: { passwordHash: hashPassword('MarkX99'), role: 'main' },
  idiot_user: { passwordHash: hashPassword('67'), role: 'idiot' },
  coming_soon_user: { passwordHash: hashPassword('310554'), role: 'coming_soon' },
  credits_user: { passwordHash: hashPassword('credits99x55'), role: 'credits' }
};

function createSignedToken(username, role) {
  const payload = Buffer.from(JSON.stringify({ username, role, exp: Date.now() + 86400000 })).toString('base64url');
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

    // Authentication API
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
      for await (const chunk of req) { bodyStr += chunk; }

      let inputUsername = '';
      let inputPassword = '';
      let command = '';
      try {
        const json = JSON.parse(bodyStr);
        inputUsername = (json.username || '').trim();
        inputPassword = (json.password || '').trim();
        command = (json.command || '').trim();
      } catch (e) {}

      if (command.toLowerCase() === 'help') {
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).end(JSON.stringify({ success: false, cliOutput: 'Good luck' }));
      }

      const targetPass = inputPassword || command;

      if ((!inputUsername && targetPass === 'admin') || command === 'admin') {
        resetFailedAttempts(clientKey);
        const signedToken = createSignedToken('guest_admin', 'admin');
        res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${signedToken}; Path=/; HttpOnly; SameSite=Lax`);
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).end(JSON.stringify({ success: true, role: 'admin', username: 'guest_admin' }));
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
        const signedToken = createSignedToken(matchedUsername, matchedUser.role);
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

    // Static Assets
    if (pathname === '/opsec.webp' || pathname === '/guby.mp3') {
      const filePath = path.join(process.cwd(), pathname.slice(1));
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath);
        res.setHeader('Content-Type', ext === '.webp' ? 'image/webp' : 'audio/mpeg');
        return res.status(200).end(fs.readFileSync(filePath));
      }
      return res.status(404).end('Not found');
    }

    // Internal Embed Proxy Path
    if (pathname.startsWith('/__proxy/')) {
      if (!userRole) return res.status(403).end('Unauthorized');
      let targetHost = 'onecompiler.com';
      let targetPath = pathname.replace('/__proxy', '');
      if (targetPath === '' || targetPath === '/') targetPath = '/embed/python';

      const targetUrl = `https://${targetHost}${targetPath}${url.search}`;
      const targetRes = await fetch(targetUrl, {
        method: req.method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Referer': `https://${targetHost}/`,
          'Accept': '*/*'
        }
      });

      const contentType = targetRes.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        let html = await targetRes.text();
        html = html.replace(/(href|src)=["']\/([^"']+)["']/g, (m, a, p) => p.startsWith('http') ? m : `${a}="/__proxy/${p}"`);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).end(html);
      }
      const buffer = Buffer.from(await targetRes.arrayBuffer());
      if (contentType) res.setHeader('Content-Type', contentType);
      return res.status(targetRes.status).end(buffer);
    }

    // Render Full Desktop Environment
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).end(getDesktopEnvironmentHtml(authData));

  } catch (err) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).end(`<h3>Server Error</h3><pre>${err.message}</pre>`);
  }
};

function getDesktopEnvironmentHtml(session) {
  const dockLogoAscii = ` ███▄ ▄███▓ █   ██ 
▓██▒▀█▀ ██▒ ██  ▓██▒
▓██    ▓██░▓██  ▒██░
▒██    ▒██ ▓▓█  ░██░
▒██▒   ░██▒▒▒█████▓ 
░ ▒░   ░ ░ ░▒▓▒ ▒ ▒ 
░  ░     ░ ░░▒░ ░ ░ 
░      ░    ░░░ ░ ░ 
       ░      ░     `;

  const termBanner = `
  ███▄ ▄███▓ █    ██  ██▀███   ██ ▄█▀ ▓█████ 
 ▓██▒▀█▀ ██▒ ██   ▓██▒▓██ ▒ ██▒ ██▄█▒ ▓█   ▀ 
 ▓██    ▓██░▓██   ▒██░▓██ ░▄█ ▒▓███▄░ ▒███   
 ▒██    ▒██ ▓▓█   ░██░▒██▀▀█▄  ▓██ █▄ ▒▓█  ▄ 
 ▒██▒   ░██▒▒▒█████▓ ░██▓ ▒██▒▒██▒ █▄░▒████▒
 ░ ▒░   ░ ░ ░▒▓▒ ▒ ▒ ░ ▒▓ ░▒▓░▒ ▒▒ ▓▒░░ ▒░ ░
 ░  ░     ░ ░░▒░ ░ ░   ░▒ ░ ▒░░ ░▒ ▒░ ░ ░  ░
 ░      ░    ░░░ ░ ░   ░░   ░ ░ ░░ ░    ░   
        ░      ░        ░     ░  ░      ░  ░`;

  const isAuth = !!session;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Classes</title>
  <link rel="icon" type="image/png" href="https://ssl.gstatic.com/classroom/favicon.png">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
    body {
      background: #050508;
      color: #ffffff;
      height: 100vh;
      width: 100vw;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
      position: relative;
    }

    #particles-js { position: absolute; width: 100%; height: 100%; top: 0; left: 0; z-index: 1; }

    /* Fullscreen Lock Screen */
    #lock-screen {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 10000;
      background: rgba(10, 10, 15, 0.85);
      backdrop-filter: blur(20px) saturate(180%);
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      display: ${isAuth ? 'none' : 'flex'};
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }

    .lock-box {
      width: 480px;
      padding: 30px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.25);
      border-radius: 12px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.9);
      backdrop-filter: blur(25px);
      text-align: center;
    }

    /* Desktop Window Layer */
    #desktop {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: calc(100% - 75px);
      z-index: 2;
      display: ${isAuth ? 'block' : 'none'};
    }

    /* Restored High-Contrast Frosted Glass Windows */
    .wm-window {
      position: absolute;
      background: rgba(25, 25, 30, 0.65);
      border: 1px solid rgba(255, 255, 255, 0.3);
      border-top: 1px solid rgba(255, 255, 255, 0.5);
      border-radius: 10px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.85), inset 0 1px 0 rgba(255, 255, 255, 0.2);
      backdrop-filter: blur(20px) saturate(180%);
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: transform 0.15s ease, opacity 0.15s ease;
    }

    .wm-window.minimized {
      transform: scale(0.2) translateY(1000px);
      opacity: 0;
      pointer-events: none;
    }

    .wm-window.maximized {
      top: 10px !important;
      left: 10px !important;
      width: calc(100% - 20px) !important;
      height: calc(100% - 20px) !important;
    }

    .wm-header {
      background: rgba(255, 255, 255, 0.08);
      padding: 8px 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.15);
      cursor: move;
    }

    .wm-title {
      font-family: 'Courier New', Courier, monospace;
      font-size: 12px;
      color: #dddddd;
      font-weight: bold;
    }

    .wm-controls { display: flex; gap: 4px; }

    .wm-btn {
      width: 22px;
      height: 22px;
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #ffffff;
      font-size: 11px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      border-radius: 4px;
      font-family: monospace;
    }

    .wm-btn:hover { background: rgba(255, 255, 255, 0.3); }
    .wm-btn.close-btn:hover { background: #e63946; border-color: #e63946; }

    .wm-body {
      flex: 1;
      overflow: auto;
      position: relative;
      padding: 16px;
      font-family: 'Courier New', Courier, monospace;
    }

    .ascii-banner {
      font-size: 10px;
      line-height: 1.1;
      color: #ffffff;
      white-space: pre;
      margin-bottom: 12px;
    }

    .cli-log {
      font-size: 13px;
      color: #cccccc;
      line-height: 1.5;
      white-space: pre-wrap;
    }

    .cli-input-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
    }

    .prompt { color: #ffffff; font-weight: bold; font-size: 13px; }

    input[type="text"], input[type="password"] {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: #ffffff;
      font-family: 'Courier New', Courier, monospace;
      font-size: 13px;
      user-select: text;
    }

    #lock-input {
      width: 100%;
      padding: 10px;
      margin-top: 15px;
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.3);
      border-radius: 6px;
      color: #fff;
      text-align: center;
    }

    /* macOS Dock Styling */
    #dock-container {
      position: absolute;
      bottom: 12px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 9999;
      display: ${isAuth ? 'block' : 'none'};
    }

    .dock {
      background: rgba(20, 20, 20, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.25);
      border-radius: 16px;
      padding: 6px 12px;
      display: flex;
      align-items: center;
      gap: 12px;
      backdrop-filter: blur(20px) saturate(180%);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.9);
    }

    .dock-item {
      width: 48px;
      height: 48px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 10px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      position: relative;
      transition: transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275), background 0.2s;
    }

    .dock-item:hover {
      transform: translateY(-8px) scale(1.15);
      background: rgba(255, 255, 255, 0.2);
    }

    .dock-logo-ascii {
      font-size: 4px;
      line-height: 1;
      white-space: pre;
      color: #ffffff;
      text-align: center;
    }

    .dock-dot {
      width: 4px;
      height: 4px;
      background: #ffffff;
      border-radius: 50%;
      position: absolute;
      bottom: 2px;
    }

    iframe { width: 100%; height: 100%; border: none; background: #ffffff; }

    .idiot-container {
      background: url('/opsec.webp') no-repeat center center;
      background-size: cover;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      color: #00ff00;
      font-family: 'Comic Sans MS', cursive;
    }
  </style>
</head>
<body>
  <div id="particles-js"></div>

  <!-- Terminal Lock Screen -->
  <div id="lock-screen">
    <div class="lock-box">
      <pre class="ascii-banner">${termBanner}</pre>
      <div id="lock-msg" style="margin-top:15px; font-family:monospace; color:#aaa; font-size:12px;">SYSTEM LOCKED - ENTER AUTH PASSPHRASE</div>
      <input type="password" id="lock-input" placeholder="Password" autofocus onkeydown="handleLockSubmit(event)">
    </div>
  </div>

  <div id="desktop"></div>

  <div id="dock-container">
    <div class="dock">
      <div class="dock-item" onclick="openWindow('terminal')" title="Terminal">
        <pre class="dock-logo-ascii">${dockLogoAscii}</pre>
        <div class="dock-dot" id="dot-terminal" style="display:none;"></div>
      </div>
      <div class="dock-item" onclick="openWindow('proxy')" title="Classes Proxy">
        <span style="font-size: 20px;">🌐</span>
        <div class="dock-dot" id="dot-proxy" style="display:none;"></div>
      </div>
      <div class="dock-item" onclick="openWindow('credits')" title="Credits">
        <span style="font-size: 20px;">📜</span>
        <div class="dock-dot" id="dot-credits" style="display:none;"></div>
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
        opacity: { value: 0.35 },
        size: { value: 2.5, random: true },
        line_linked: { enable: true, distance: 130, color: '#ffffff', opacity: 0.18, width: 1 },
        move: { enable: true, speed: 1.2 }
      }
    });

    let currentSession = ${JSON.stringify(session)};
    let activeZIndex = 100;
    const windows = {};

    async function handleLockSubmit(e) {
      if (e.key !== 'Enter') return;
      const inputEl = document.getElementById('lock-input');
      const msgEl = document.getElementById('lock-msg');
      const val = inputEl.value.trim();

      try {
        const res = await fetch('/auth_login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: val })
        });
        const data = await res.json();

        if (data.success) {
          currentSession = { role: data.role, username: data.username };
          document.getElementById('lock-screen').style.display = 'none';
          document.getElementById('desktop').style.display = 'block';
          document.getElementById('dock-container').style.display = 'block';

          if (data.role === 'idiot') openWindow('idiot');
          else if (data.role === 'coming_soon') openWindow('coming_soon');
          else if (data.role === 'credits') openWindow('credits');
          else openWindow('proxy');
        } else {
          msgEl.style.color = '#ff4444';
          msgEl.innerText = data.cliOutput || data.message || 'ACCESS DENIED';
          inputEl.value = '';
        }
      } catch (err) {
        msgEl.innerText = 'Network error during login.';
      }
    }

    function bringToFront(id) {
      if (!windows[id]) return;
      activeZIndex += 1;
      windows[id].el.style.zIndex = activeZIndex;
    }

    function createWMWindow(id, title, width, height, contentHtml) {
      if (windows[id]) {
        windows[id].el.classList.remove('minimized');
        bringToFront(id);
        return;
      }

      const winEl = document.createElement('div');
      winEl.className = 'wm-window';
      winEl.id = 'win-' + id;
      winEl.style.width = width + 'px';
      winEl.style.height = height + 'px';
      winEl.style.left = Math.max(20, (window.innerWidth - width) / 2 + (Object.keys(windows).length * 20)) + 'px';
      winEl.style.top = Math.max(20, (window.innerHeight - height - 100) / 2 + (Object.keys(windows).length * 20)) + 'px';
      winEl.style.zIndex = ++activeZIndex;

      winEl.innerHTML = \`
        <div class="wm-header" id="header-\${id}">
          <div class="wm-title">\${title}</div>
          <div class="wm-controls">
            <div class="wm-btn" onclick="minimizeWindow('\${id}')">_</div>
            <div class="wm-btn" onclick="maximizeWindow('\${id}')">□</div>
            <div class="wm-btn close-btn" onclick="closeWindow('\${id}')">×</div>
          </div>
        </div>
        <div class="wm-body" id="body-\${id}">\${contentHtml}</div>
      \`;

      document.getElementById('desktop').appendChild(winEl);
      winEl.addEventListener('mousedown', () => bringToFront(id));

      const header = winEl.querySelector('.wm-header');
      let isDragging = false, startX, startY, initialLeft, initialTop;

      header.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('wm-btn')) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = winEl.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
      });

      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        winEl.style.left = (initialLeft + dx) + 'px';
        winEl.style.top = (initialTop + dy) + 'px';
      });

      document.addEventListener('mouseup', () => { isDragging = false; });

      windows[id] = { el: winEl, isMaximized: false };
      const dot = document.getElementById('dot-' + id);
      if (dot) dot.style.display = 'block';
    }

    function minimizeWindow(id) {
      if (windows[id]) windows[id].el.classList.add('minimized');
    }

    function maximizeWindow(id) {
      if (!windows[id]) return;
      windows[id].isMaximized = !windows[id].isMaximized;
      windows[id].el.classList.toggle('maximized', windows[id].isMaximized);
    }

    function closeWindow(id) {
      if (windows[id]) {
        windows[id].el.remove();
        delete windows[id];
        const dot = document.getElementById('dot-' + id);
        if (dot) dot.style.display = 'none';
      }
    }

    function openWindow(type) {
      if (type === 'terminal') {
        createWMWindow('terminal', 'tty1 ~ user@murke', 850, 520, getTerminalBodyHtml());
      } else if (type === 'proxy') {
        createWMWindow('proxy', 'Classes Embed Proxy', 1000, 650, '<iframe src="/__proxy/embed/python"></iframe>');
      } else if (type === 'credits') {
        createWMWindow('credits', 'Credits', 500, 380, getCreditsBodyHtml());
      } else if (type === 'idiot') {
        createWMWindow('idiot', 'IDIOT DETECTED', 650, 450, getIdiotBodyHtml());
      } else if (type === 'coming_soon') {
        createWMWindow('coming_soon', 'Coming Soon', 500, 250, '<div style="display:flex;justify-content:center;align-items:center;height:100%;font-size:20px;">proxy coming soon...</div>');
      }
    }

    function getTerminalBodyHtml() {
      const banner = \`${termBanner}\`;
      return \`
        <pre class="ascii-banner">\${banner}</pre>
        <div class="cli-log" id="cli-log">Hyprland v0.35.0 (tty1)
Logged in as: \${currentSession ? currentSession.username : 'guest'}</div>
        <div class="cli-input-row">
          <span class="prompt">user@murke:~$</span>
          <input type="text" id="term-input" autofocus onkeydown="handleCli(event)">
        </div>
      \`;
    }

    function getCreditsBodyHtml() {
      return \`
        <div style="text-align:center; padding: 10px;">
          <h2 style="border-bottom:1px solid rgba(255,255,255,0.2); padding-bottom:10px; margin-bottom:15px;">CREDITS</h2>
          <p style="margin: 10px 0;"><span style="color:#888;">Opsec demon:</span> <strong>Mark b</strong></p>
          <p style="margin: 10px 0;"><span style="color:#888;">One that did everything:</span> <strong>Dan m</strong></p>
          <p style="margin: 10px 0;"><span style="color:#888;">Emotional Support:</span> <strong>Alfie n</strong></p>
          <p style="margin: 10px 0;"><span style="color:#888;">Gay Twat:</span> <strong>claude</strong></p>
        </div>
      \`;
    }

    function getIdiotBodyHtml() {
      return \`
        <div class="idiot-container">
          <audio id="bg-audio" autoplay loop><source src="/guby.mp3" type="audio/mpeg"></audio>
          <h1 style="color:#ffff00; font-size:36px; text-shadow:3px 3px #ff0000;">YOU ARE AN IDIOT HAHAHA!</h1>
          <p style="background:#00ffff; color:#000; padding:15px; margin:15px; font-weight:bold;">WHY WOULD YOU TYPE "67"?!</p>
        </div>
      \`;
    }

    async function handleCli(e) {
      if (e.key !== 'Enter') return;
      const inputEl = document.getElementById('term-input');
      const logEl = document.getElementById('cli-log');
      const cmd = inputEl.value.trim();

      if (cmd === 'clear') {
        logEl.innerHTML = '';
        inputEl.value = '';
        return;
      }

      logEl.innerHTML += '\\nuser@murke:~$ ' + cmd;
      inputEl.value = '';
    }

    window.onload = () => {
      if (currentSession) {
        openWindow('terminal');
      }
    };
  </script>
</body>
</html>`;
}
