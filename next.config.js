/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // FFmpeg binaries are read from node_modules at runtime and must not be bundled.
    serverComponentsExternalPackages: ['ffmpeg-static', 'ffprobe-static', '@google/genai'],
  },
};

module.exports = nextConfig;
