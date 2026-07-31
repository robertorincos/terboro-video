import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // youtube-dl-exec resolves its bundled yt-dlp binary relative to __dirname at
  // runtime. Bundling it into the server build rewrites that path and breaks
  // spawn() (ENOENT), so it must run as plain, un-bundled Node.js `require`.
  serverExternalPackages: ["youtube-dl-exec"],
};

export default nextConfig;
