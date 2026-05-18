import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs-dist must stay external on the server so its dynamically spawned worker
  // (loaded from `pdfjs-dist/legacy/build/pdf.worker.mjs`) can be resolved at runtime.
  // mammoth and playwright also dislike being bundled.
  serverExternalPackages: ["pdf2json", "mammoth", "playwright"],
  // Next 16 blocks cross-origin dev resources by default. Without this, opening
  // the app via a LAN IP causes JS chunks to 403, React never hydrates, and
  // click/drop handlers on FileDrop stay unattached.
  allowedDevOrigins: ["192.168.18.35", "*.local"],
};

export default nextConfig;
