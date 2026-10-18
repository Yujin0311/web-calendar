"use strict";

// Negotiate progress only with new clients; existing API callers retain JSON responses.
function startImageResponse(req, res) {
  const stream = (req.get("Accept") || "").split(",").some(type => type.trim().split(";")[0] === "application/x-ndjson");
  const controller = new AbortController();
  let heartbeat;
  function send(frame) {
    if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(frame) + "\n");
  }
  const onClose = () => { if (!res.writableEnded) controller.abort(); clearInterval(heartbeat); };
  res.once("close", onClose);
  if (stream) {
    res.set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    send({ type: "pending" });
    heartbeat = setInterval(() => { if (!res.writableNeedDrain) send({ type: "pending" }); }, 15_000);
    heartbeat.unref();
  }
  function finish(frame, status, data) {
    clearInterval(heartbeat);
    if (res.destroyed || res.writableEnded) return;
    if (stream) { send(frame); res.end(); }
    else res.status(status).json(data);
  }
  return {
    signal: controller.signal,
    succeed(data) { finish({ type: "result", data }, 200, data); },
    fail(status, error) { finish({ type: "error", status, error }, status, { error }); },
    dispose() { clearInterval(heartbeat); res.removeListener("close", onClose); }
  };
}
module.exports = { startImageResponse };
