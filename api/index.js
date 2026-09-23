const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PASSWORD = 'MarkX99';
const AUTH_COOKIE_NAME = 'site_access_token';
const AUTH_TOKEN = crypto.createHash('sha256').update(PASSWORD + '_secret_salt').digest('hex');

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

module.exports = async (req, res) => {
  try {
    const host = req.headers.host || 'localhost';
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const url = new URL(req.url, `${protocol}://${host}`);
    const pathname = url.pathname;

    const cookies = req.headers.cookie || '';
    const isAuthenticated = cookies.includes(`${AUTH_COOKIE_NAME}=${AUTH_TOKEN}`);

    // 1. Handle Special Routes
    if (pathname === '/idiot') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(getIdiotHtml());
    }

    if (pathname === '/proxy-coming-soon') {
      if (!isAuthenticated) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).end(getParticlesAuthHtml());
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(getComingSoonHtml());
    }

    if (pathname === '/credits') {
      if (!isAuthenticated) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).end(getParticlesAuthHtml());
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(getCreditsHtml());
    }

    // Serve local static assets (opsec.webp and guby.mp3)
    if (pathname === '/opsec.webp' || pathname === '/guby.mp3') {
      const filePath = path.join(process.cwd(), pathname);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath);
        const contentType = ext === '.webp' ? 'image/webp' : 'audio/mpeg';
        res.setHeader('Content-Type', contentType);
        return res.status(200).end(fs.readFileSync(filePath));
      }
      return res.status(404).end('Not found');
    }

    // 2. Password Verification Endpoint with Rate Limiting
    if (req.method === 'POST' && pathname === '/auth_login') {
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown_ip';
      const clientKey = `${clientIp}_${cookies}`;

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
      let password = '';
      try {
        const json = JSON.parse(bodyStr);
        password = json.password;
      } catch (e) {}

      if (password === '67') {
        resetFailedAttempts(clientKey);
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).end(JSON.stringify({ redirect: '/idiot' }));
      }

      if (password === '310554') {
        resetFailedAttempts(clientKey);
        res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Lax`);
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).end(JSON.stringify({ redirect: '/proxy-coming-soon' }));
      }

      if (password === 'credits99x55') {
        resetFailedAttempts(clientKey);
        res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Lax`);
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).end(JSON.stringify({ redirect: '/credits' }));
      }

      if (password === PASSWORD) {
        resetFailedAttempts(clientKey);
        res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Lax`);
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).end(JSON.stringify({ success: true }));
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

    let targetPath = pathname;
    if (targetPath === '/' || targetPath === '/index.html') {
      targetPath = '/embed/python';
    }

    // 3. Check if request is for main HTML page
    const acceptHeader = req.headers.accept || '';
    const isHtmlRequest = acceptHeader.includes('text/html') || targetPath === '/embed/python';

    if (isHtmlRequest && !isAuthenticated) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(getParticlesAuthHtml());
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

    // 5. Inject Google Classroom Favicon/Title + UI & Code State
    if (contentType.includes('text/html')) {
      let html = await targetRes.text();

      // Clear cookie immediately so next refresh demands password again
      res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);

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

                // 1. Synchronize Code with Monaco Editor
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

                // 2. Restore Theme via Native UI Button
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

                // Track manual Theme Button Clicks
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

                // 3. Synchronize STDIN and Input Fields
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

function getParticlesAuthHtml() {
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
    .auth-box { position: relative; z-index: 2; }
    input { 
      background: #000000; 
      border: 2px solid #ffffff; 
      border-radius: 4px; 
      color: #ffffff; 
      padding: 12px 18px; 
      font-size: 16px; 
      font-family: 'Courier New', Courier, monospace; 
      outline: none; 
      width: 280px; 
      text-align: center; 
      transition: all 0.2s; 
      box-shadow: 0 0 15px rgba(255, 255, 255, 0.15); 
    }
    input::placeholder { color: #666666; font-family: 'Courier New', Courier, monospace; }
    input:focus { border-color: #ffffff; box-shadow: 0 0 25px rgba(255, 255, 255, 0.6); }
  </style>
</head>
<body>
  <div id="particles-js"></div>
  <div class="auth-box">
    <input type="password" id="pass" placeholder="Password..." autofocus onkeydown="if(event.key==='Enter') submitAuth()">
  </div>

  <script src="https://cdn.jsdelivr.net/npm/particles.js@2.0.0/particles.min.js"></script>
  <script>
    const isRainbow = Math.floor(Math.random() * 1000) === 0;
    const particleColors = isRainbow 
      ? ['#ff0000', '#ff7f00', '#ffff00', '#00ff00', '#0000ff', '#4b0082', '#8b00ff']
      : '#ffffff';

    particlesJS('particles-js', {
      particles: {
        number: { value: 80, density: { enable: true, value_area: 800 } },
        color: { value: particleColors },
        shape: { type: 'circle' },
        opacity: { value: 0.6, random: false },
        size: { value: 3, random: true },
        line_linked: {
          enable: true,
          distance: 140,
          color: '#ffffff',
          opacity: 0.4,
          width: 1
        },
        move: {
          enable: true,
          speed: 2,
          direction: 'none',
          random: false,
          straight: false,
          out_mode: 'out',
          bounce: false
        }
      },
      interactivity: {
        detect_on: 'canvas',
        events: {
          onhover: { enable: true, mode: 'repulse' },
          onclick: { enable: true, mode: 'push' },
          resize: true
        },
        modes: {
          repulse: { distance: 100, duration: 0.4 },
          grab: { distance: 140, line_linked: { opacity: 0.8 } },
          push: { particles_nb: 4 }
        }
      },
      retina_detect: true
    });

    async function submitAuth() {
      const pass = document.getElementById('pass').value;
      if (pass === '67') {
        window.location.href = '/idiot';
        return;
      }
      try {
        const res = await fetch('/auth_login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pass })
        });
        const data = await res.json();
        if (data.redirect) {
          window.location.href = data.redirect;
          return;
        }
        if (data.success) {
          window.location.reload();
        } else {
          const el = document.getElementById('pass');
          el.value = '';
          el.placeholder = data.message || 'Wrong Password';
        }
      } catch (e) {}
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
      position: relative;
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
    @keyframes blink {
      from, to { border-color: transparent }
      50% { border-color: #ffffff; }
    }
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
        opacity: { value: 0.5, random: false },
        size: { value: 3, random: true },
        line_linked: {
          enable: true,
          distance: 130,
          color: '#ffffff',
          opacity: 0.3,
          width: 1
        },
        move: { enable: true, speed: 1.5, direction: 'none', out_mode: 'out' }
      },
      interactivity: {
        detect_on: 'canvas',
        events: { onhover: { enable: true, mode: 'repulse' }, resize: true },
        modes: { repulse: { distance: 100, duration: 0.4 } }
      },
      retina_detect: true
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
      position: relative;
    }
    #particles-js { position: absolute; width: 100%; height: 100%; top: 0; left: 0; z-index: 1; }
    .credits-box {
      position: relative;
      z-index: 2;
      border: 2px solid #ffffff;
      padding: 30px 40px;
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.85);
      box-shadow: 0 0 20px rgba(255, 255, 255, 0.2);
      text-align: center;
      max-width: 500px;
      width: 90%;
    }
    h1 {
      font-size: 26px;
      margin-bottom: 25px;
      letter-spacing: 2px;
      text-transform: uppercase;
      border-bottom: 1px solid #333333;
      padding-bottom: 10px;
    }
    .credit-item {
      font-size: 18px;
      margin: 15px 0;
      line-height: 1.5;
      color: #dddddd;
    }
    .role {
      color: #888888;
      font-size: 14px;
      display: block;
      margin-bottom: 2px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .name {
      color: #ffffff;
      font-weight: bold;
    }
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
        opacity: { value: 0.5, random: false },
        size: { value: 3, random: true },
        line_linked: {
          enable: true,
          distance: 130,
          color: '#ffffff',
          opacity: 0.3,
          width: 1
        },
        move: { enable: true, speed: 1.5, direction: 'none', out_mode: 'out' }
      },
      interactivity: {
        detect_on: 'canvas',
        events: { onhover: { enable: true, mode: 'repulse' }, resize: true },
        modes: { repulse: { distance: 100, duration: 0.4 } }
      },
      retina_detect: true
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
    @keyframes blink {
      0% { opacity: 1; }
      50% { opacity: 0; }
      100% { opacity: 1; }
    }
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
    button:hover {
      background: #ffff00;
    }
  </style>
</head>
<body>
  <audio id="bg-audio" autoplay loop>
    <source src="/guby.mp3" type="audio/mpeg">
  </audio>
  <script>
    document.addEventListener('click', () => {
      const audio = document.getElementById('bg-audio');
      if (audio.paused) {
        audio.play().catch(e => {});
      }
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
