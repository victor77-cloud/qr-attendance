/* QR helpers — wrappers over the two vendored libraries:
 *   - qrcode-generator (global `qrcode`): encode text to a canvas
 *   - jsQR (global `jsQR`): decode a video frame
 */

export function qrEncodeToCanvas(text, canvas, scale = 8) {
  const lib = globalThis.qrcode;
  if (!lib) throw new Error('qrcode-generator library not loaded');
  const qr = lib(0, 'M'); // typeNumber 0 => auto-size
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  // 4-module white quiet zone on every side (required by the QR spec):
  // without it the code sits directly on the dark app background and
  // scanners cannot locate the corner finder patterns.
  const quiet = 4;
  const size = (n + quiet * 2) * scale;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
  return n;
}

/* Capture the current video frame and try to decode a QR from it. */
export function decodeVideoFrame(video, canvas) {
  if (!video.videoWidth || !globalThis.jsQR) return null;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = globalThis.jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
  return code ? code.data : null;
}
