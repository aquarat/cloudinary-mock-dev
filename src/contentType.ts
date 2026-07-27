const FORMAT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  pdf: "application/pdf",
};

export function mimeForFormat(format: string | null): string {
  if (!format) return "application/octet-stream";
  return FORMAT_TO_MIME[format.toLowerCase()] ?? "application/octet-stream";
}
