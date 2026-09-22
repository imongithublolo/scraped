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

    // 1. Handle Ugly 90s Idiot Page Route
    if (pathname === '/idiot') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(getIdiotHtml());
    }

    // 2. Password Verification Endpoint
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

      if (password === '67') {
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).end(JSON.stringify({ redirect: '/idiot' }));
      }

      if (password === PASSWORD) {
        res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Lax`);
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).end(JSON.stringify({ success: true }));
      } else {
        res.setHeader('Content-Type', 'application/json');
        return res.status(401).end(JSON.stringify({ success: false }));
      }
    }

    // 3. Read Authentication Cookie
    const cookies = req.headers.cookie || '';
    const isAuthenticated = cookies.includes(`${AUTH_COOKIE_NAME}=${AUTH_TOKEN}`);

    let targetPath = pathname;
    if (targetPath === '/' || targetPath === '/index.html') {
      targetPath = '/embed/python';
    }

    // 4. Check if request is for main HTML page
    const acceptHeader = req.headers.accept || '';
    const isHtmlRequest = acceptHeader.includes('text/html') || targetPath === '/embed/python';

    if (isHtmlRequest && !isAuthenticated) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(getParticlesAuthHtml());
    }

    // 5. Fetch target directly from OneCompiler
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

    // 6. Inject Blue Run Button + Robust Auto-Save / Auto-Restore Script
    if (contentType.includes('text/html')) {
      let html = await targetRes.text();

      // Clear cookie immediately so next refresh demands password again
      res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);

      const injectedPayload = `
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
            let isRestored = false;

            function initAutoSave() {
              const pollInterval = setInterval(() => {
                if (window.monaco && window.monaco.editor) {
                  const editors = window.monaco.editor.getEditors();
                  if (editors.length > 0) {
                    const editor = editors[0];
                    const savedCode = localStorage.getItem('oc_saved_code');

                    // 1. Restore code if present
                    if (savedCode && savedCode.trim() !== '' && !isRestored) {
                      editor.setValue(savedCode);
                      isRestored = true;
                    }

                    // 2. Continuous save on model change
                    editor.onDidChangeModelContent(() => {
                      const currentVal = editor.getValue();
                      if (currentVal.trim() !== '') {
                        localStorage.setItem('oc_saved_code', currentVal);
                      }
                    });

                    // 3. Keep reinforcing restored code against React re-render resets for 3 seconds
                    let protectCount = 0;
                    const protectInterval = setInterval(() => {
                      protectCount++;
                      const currentVal = editor.getValue();
                      if (savedCode && savedCode.trim() !== '' && currentVal !== savedCode && protectCount < 10) {
                        editor.setValue(savedCode);
                      }
                      if (protectCount >= 10) {
                        clearInterval(protectInterval);
                      }
                    }, 300);

                    // 4. Auto-save STDIN input text
                    setInterval(() => {
                      const stdinEl = document.querySelector('textarea, input[placeholder*="Input"]');
                      if (stdinEl) {
                        const savedStdin = localStorage.getItem('oc_saved_stdin');
                        if (savedStdin && !stdinEl.dataset.restored) {
                          stdinEl.value = savedStdin;
                          stdinEl.dataset.restored = "true";
                        }
                        stdinEl.addEventListener('input', () => {
                          localStorage.setItem('oc_saved_stdin', stdinEl.value);
                        });
                      }
                    }, 500);

                    clearInterval(pollInterval);
                  }
                }
              }, 200);
            }

            if (document.readyState === 'complete') initAutoSave();
            else window.addEventListener('load', initAutoSave);
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
  <title>Access</title>
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
    particlesJS('particles-js', {
      particles: {
        number: { value: 80, density: { enable: true, value_area: 800 } },
        color: { value: '#ffffff' },
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
          onhover: { enable: true, mode: 'grab' },
          onclick: { enable: true, mode: 'push' },
          resize: true
        },
        modes: {
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
          el.placeholder = 'Wrong Password';
        }
      } catch (e) {}
    }
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
      background-color: #ff00ff;
      color: #00ff00;
      font-family: "Comic Sans MS", "Comic Sans", cursive, sans-serif;
      text-align: center;
      padding: 30px;
      margin: 0;
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
  <marquee behavior="alternate">*** ERROR 404: BRAIN CELL NOT FOUND ***</marquee>
  <h1>YOU ARE AN IDIOT HAHAHAHAHA!!</h1>
  <div class="box">
    <p>WHY WOULD YOU TYPE "67"?! ARE YOU STUPID?!</p>
    <br>
    <p>CONGRATULATIONS! YOU UNLOCKED THIS PAGE</p>
  </div>
  <p style="font-size: 20px; color: #ffffff; background: #000000; display: inline-block; padding: 10px;">[ CREDITS TO @Mark FOR NOTHING ]</p>
  <br><br>
  <button onclick="window.location.href='/'">CLICK HERE TO GO BACK AND THINK ABOUT WHAT YOU DID</button>
</body>
</html>`;
}
