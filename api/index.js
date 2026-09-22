{
  "rewrites": [
    {
      "source": "/api/:path*",
      "destination": "/api"
    },
    {
      "source": "/_next/:path*",
      "destination": "https://onecompiler.com/_next/:path*"
    }
  ]
}
