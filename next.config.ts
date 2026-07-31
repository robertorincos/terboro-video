import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // youtube-dl-exec resolves its bundled yt-dlp binary relative to __dirname at
  // runtime. Bundling it into the server build rewrites that path and breaks
  // spawn() (ENOENT), so it must run as plain, un-bundled Node.js `require`.
  serverExternalPackages: ["youtube-dl-exec"],
  // Produces .next/standalone with only the files needed to run `node server.js`,
  // so the Docker image doesn't need a full `npm install` in the runtime layer.
  output: "standalone",
};

export default nextConfig;
