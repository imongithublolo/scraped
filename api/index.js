const fs = require('fs');
const path = require('path');

const PASSWORDS = {
  'GiveMePython': 'compiler',
  'DanIsOpsec310554': 'murke'
};

module.exports = async (req, res) => {
  try {
    const host = req.headers.host || 'localhost';
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const url = new URL(req.url, `${protocol}://${host}`);
    const pathname = url.pathname;

    // Authentication Endpoint
    if (req.method === 'POST' && pathname === '/auth_login') {
      let bodyStr = '';
      for await (const chunk of req) { bodyStr += chunk; }

      let inputPassword = '';
      try {
        const json = JSON.parse(bodyStr);
        inputPassword = (json.password || '').trim();
      } catch (e) {}

      const dest = PASSWORDS[inputPassword];

      if (dest) {
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).end(JSON.stringify({ 
          success: true, 
          redirect: `/${dest}` 
        }));
      } else {
        res.setHeader('Content-Type', 'application/json');
        return res.status(401).end(JSON.stringify({ 
          success: false, 
          message: 'Access Denied.' 
        }));
      }
    }

    // Direct Route Views
    if (pathname === '/compiler') {
      const html = fs.readFileSync(path.join(process.cwd(), 'views', 'compiler.html'), 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(html);
    }

    if (pathname === '/murke') {
      const html = fs.readFileSync(path.join(process.cwd(), 'views', 'murke.html'), 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(html);
    }

    // Proxy Handler for Python Compiler
    if (pathname.startsWith('/__proxy/')) {
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

    // Default: Lock Screen
    const lockHtml = fs.readFileSync(path.join(process.cwd(), 'views', 'lock.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).end(lockHtml);

  } catch (err) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).end(`<h3>Server Error</h3><pre>${err.message}</pre>`);
  }
};
