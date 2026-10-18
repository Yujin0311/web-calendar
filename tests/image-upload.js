"use strict";
// Encoder failures must not replace a valid original with data:,; small files must not grow.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
let png, jpeg, decodeFails = false, dimensions;
const original = "data:image/png;base64," + "A".repeat(100);
class Reader {
  readAsDataURL() { this.result = original; this.onload(); this.onloadend(); }
}
class Image {
  naturalWidth = 4000; naturalHeight = 2000;
  async decode() { if (decodeFails) throw Error("decoder failed"); }
}
const window = {};
vm.runInNewContext(fs.readFileSync(require.resolve("../image-upload"), "utf8"), {
  window, FileReader: Reader, Image, DOMException,
  URL: { createObjectURL() { return "blob:test"; }, revokeObjectURL() {} },
  document: { createElement() { const canvas = { getContext() { return { fillRect() {}, drawImage() { dimensions = [canvas.width, canvas.height]; } }; }, toDataURL(type) { return type === "image/png" ? png : jpeg; } }; return canvas; } }
});
(async () => {
  png = "data:,"; jpeg = "data:,";
  assert.equal(await window.QingxuImageUpload.prepare({}), original);
  png = "data:image/png;base64," + "A".repeat(200);
  jpeg = "data:image/jpeg;base64," + "A".repeat(20);
  assert.equal(await window.QingxuImageUpload.prepare({}), jpeg);
  assert.deepEqual(dimensions, [2560, 1280], "resize must preserve aspect ratio");
  jpeg = "data:image/jpeg;base64," + "A".repeat(200);
  assert.equal(await window.QingxuImageUpload.prepare({}), original);
  decodeFails = true;
  assert.equal(await window.QingxuImageUpload.prepare({}), original);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(window.QingxuImageUpload.prepare({}, controller.signal), { name: "AbortError" });
  console.log("Image upload size/fallback/cancellation tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
