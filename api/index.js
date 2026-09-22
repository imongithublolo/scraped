const { createProxyMiddleware } = require('http-proxy-middleware');

const proxy = createProxyMiddleware({
  target: 'https://onecompiler.com',
  changeOrigin: true,
  pathRewrite: (path, req) => {
    // When someone opens your site, secretly serve the Python embed page
    if (path === '/' || path === '/index.html') {
      return '/embed/python';
    }
    // Let Next.js assets and API calls pass through normally
    return path;
  },
  headers: {
    // Trick their backend into thinking we are the official site
    'Referer': 'https://onecompiler.com/embed/python',
    'Origin': 'https://onecompiler.com',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
  },
  onProxyRes: function (proxyRes) {
    // Nuke their security headers so it runs perfectly on your domain
    delete proxyRes.headers['x-frame-options'];
    delete proxyRes.headers['content-security-policy'];
    delete proxyRes.headers['access-control-allow-origin'];
    proxyRes.headers['Access-Control-Allow-Origin'] = '*';
  }
});

module.exports = (req, res) => {
  return proxy(req, res);
};
