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
    // 1 in 1000 chance roll for Rainbow mode
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
          color: isRainbow ? '#ffffff' : '#ffffff',
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
          onhover: { 
            enable: true, 
            mode: 'repulse' // Sets particles to dodge the mouse cursor
          },
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
          el.placeholder = 'Wrong Password';
        }
      } catch (e) {}
    }
  </script>
</body>
</html>`;
}
