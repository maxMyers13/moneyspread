/** @type {import('next').NextConfig} */

// The glasses' REST API is plain http on the local network and may not send
// permissive CORS headers. We let the Next dev server act as a same-origin
// reverse proxy: the browser calls /g3/*, Next forwards to the glasses.
// This dodges both CORS and (if you ever served the app over https) mixed
// content for the *signaling* calls. WebRTC media still flows browser<->glasses
// directly and is not proxied here.
const G3_HOST_INTERNAL = process.env.G3_HOST_INTERNAL; // e.g. http://tg03b-080200000000.local

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    if (!G3_HOST_INTERNAL) return [];
    return [
      {
        source: "/g3/:path*",
        destination: `${G3_HOST_INTERNAL}/:path*`,
      },
    ];
  },
};

export default nextConfig;
