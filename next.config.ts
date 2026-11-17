import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Media binaries and Prisma must be loaded from node_modules at runtime, not bundled.
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static", "@prisma/client", "@anthropic-ai/sdk"],
  poweredByHeader: false,
};

export default nextConfig;
