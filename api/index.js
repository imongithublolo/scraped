const { createProxyMiddleware } = require('http-proxy-middleware');

const proxy = createProxyMiddleware({
  target: 'https://onecompiler.com',
  changeOrigin: true,
  headers: {
    'Referer': 'https://onecompiler.com/embed/python',
    'Origin': 'https://onecompiler.com',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
  },
  onProxyRes: function (proxyRes) {
    delete proxyRes.headers['access-control-allow-origin'];
    proxyRes.headers['Access-Control-Allow-Origin'] = '*';
    proxyRes.headers['Access-Control-Allow-Headers'] = '*';
  }
});

module.exports = (req, res) => {
  return proxy(req, res);
};
