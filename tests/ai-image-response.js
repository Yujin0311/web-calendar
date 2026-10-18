"use strict";
// Exercise the real HTTP wire format, heartbeat and cancellation of abandoned calls.
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { once } = require("node:events");
const { startImageResponse } = require("../services/aiImageResponse");
async function main() {
  const app = express();
  let finish, abandoned;
  const cancelled = new Promise(resolve => { abandoned = resolve; });
  app.get("/wait", (req, res) => {
    const transfer = startImageResponse(req, res);
    transfer.signal.addEventListener("abort", abandoned, { once: true });
    finish = () => { transfer.succeed({ isValid: false, courses: [] }); transfer.dispose(); };
  });
  app.get("/error", (req, res) => {
    const transfer = startImageResponse(req, res);
    transfer.fail(504, "AI 解析超时（180 秒）"); transfer.dispose();
  });
  const server = http.createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(url + "/wait", { headers: { Accept: "application/x-ndjson" } });
    assert.match(response.headers.get("content-type"), /ndjson/);
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    const reader = response.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"pending"/);
    assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"pending"/);
    finish();
    assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"result"/);
    await reader.cancel();
    const legacy = await fetch(url + "/error");
    assert.equal(legacy.status, 504);
    assert.equal((await legacy.json()).error, "AI 解析超时（180 秒）");
    const streamed = await fetch(url + "/error", { headers: { Accept: "application/x-ndjson" } });
    assert.equal(streamed.status, 200);
    assert.match(await streamed.text(), /"type":"error","status":504/);
    const controller = new AbortController();
    const disconnected = await fetch(url + "/wait", { signal: controller.signal, headers: { Accept: "application/x-ndjson" } });
    controller.abort();
    await disconnected.body.cancel().catch(() => {});
    await Promise.race([cancelled, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("upstream not cancelled")), 1500); timer.unref(); })]);
    console.log("AI image response HTTP/heartbeat/cancellation tests passed");
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
