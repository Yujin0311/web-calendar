"use strict";

// Keep the original preview; only optimize the copy sent for recognition.
window.QingxuImageUpload = (() => {
  function read(file, signal) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const abort = () => reader.abort();
      signal?.throwIfAborted();
      signal?.addEventListener("abort", abort, { once: true });
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(Error("图片读取失败，请重试。"));
      reader.onabort = () => reject(new DOMException("Aborted", "AbortError"));
      reader.onloadend = () => signal?.removeEventListener("abort", abort);
      reader.readAsDataURL(file);
    });
  }
  async function prepare(file, signal) {
    const original = await read(file, signal);
    signal?.throwIfAborted();
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      signal?.throwIfAborted();
      // A generous resolution cap preserves small timetable text while reducing camera photos.
      const scale = Math.min(1, 2560 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return original;
      ctx.imageSmoothingQuality = "high";
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      // PNG preserves screenshot text losslessly; high-quality JPEG helps camera photos.
      // Never upload a larger re-encoding, and never upscale a small image.
      const png = canvas.toDataURL("image/png");
      const jpeg = canvas.toDataURL("image/jpeg", 0.9);
      return [original, png, jpeg].filter(value => /^data:image\/(png|jpeg|gif|webp);base64,/.test(value)).reduce((best, candidate) => candidate.length < best.length ? candidate : best);
    } catch (error) {
      signal?.throwIfAborted();
      // Older browsers or decoder limitations can still use the validated original.
      return original;
    } finally { URL.revokeObjectURL(url); }
  }
  return { prepare };
})();
