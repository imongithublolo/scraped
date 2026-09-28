const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Generate SHA-256 hashes of the actual passwords on the server
// Pro-tip: Set these in Vercel Environment Variables so they aren't hardcoded in your git repo!
const rawCompilerPass = process.env.COMPILER_PASS || 'GiveMePython';
const rawMurkePass = process.env.MURKE_PASS || 'DanIsOpsec310554';

const hashString = (str) => crypto.createHash('sha256').update(str).digest('hex');
const TARGET_COMPILER_HASH = hashString(rawCompilerPass);
const TARGET_MURKE_HASH = hashString(rawMurkePass);

// Timing-safe comparison prevents side-channel timing attacks
const secureCompare = (inputHash, targetHash) => {
  if (!inputHash || inputHash.length !== targetHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(targetHash));
};

module.exports = async (req, res) => {
  try {
    const host = req.headers.host || 'localhost';
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const url = new URL(req.url, `${protocol}://${host}`);
    const pathname = url.pathname;

    // --- ENCRYPTED AUTHENTICATION ---
    if (req.method === 'POST' && pathname === '/auth_login') {
      let bodyStr = '';
      for await (const chunk of req) { bodyStr += chunk; }

      let incomingHash = '';
      try {
        incomingHash = JSON.parse(bodyStr).payload || '';
      } catch (e) {}

      res.setHeader('Content-Type', 'application/json');

      // Verify hashes securely
      if (secureCompare(incomingHash, TARGET_COMPILER_HASH)) {
        return res.status(200).end(JSON.stringify({ success: true, redirect: '/compiler' }));
      } else if (secureCompare(incomingHash, TARGET_MURKE_HASH)) {
        return res.status(200).end(JSON.stringify({ success: true, redirect: '/murke' }));
      } else {
        return res.status(401).end(JSON.stringify({ success: false, message: 'Access Denied.' }));
      }
    }

    // --- ROUTING FROM "public" FOLDER ---
    if (pathname === '/compiler') {
      const html = fs.readFileSync(path.join(process.cwd(), 'public', 'compiler.html'), 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(html);
    }

    if (pathname === '/murke') {
      const html = fs.readFileSync(path.join(process.cwd(), 'public', 'murke.html'), 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(html);
    }

    // --- PROXY HANDLER ---
    if (pathname.startsWith('/__proxy/')) {
      let targetPath = pathname.replace('/__proxy', '');
      if (!targetPath || targetPath === '/') targetPath = '/embed/python';

      const targetUrl = `https://onecompiler.com${targetPath}${url.search}`;
      const targetRes = await fetch(targetUrl, {
        method: req.method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Referer': 'https://onecompiler.com/',
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

    // --- DEFAULT: SERVE LOCK SCREEN ---
    const lockHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'lock.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).end(lockHtml);

  } catch (err) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).end(`<h3>Server Error</h3><pre>${err.message}</pre>`);
  }
};
