const v = await (await fetch("http://127.0.0.1:9333/json/version")).json();
console.log("1. version OK:", v.Browser);
console.log("2. ws url:", v.webSocketDebuggerUrl);
const t0 = Date.now();
const ws = new WebSocket(v.webSocketDebuggerUrl);
const opened = await new Promise((res) => {
  ws.addEventListener("open", () => res("open"), { once: true });
  ws.addEventListener("error", (e) => res("error " + (e.message || "?")), { once: true });
  setTimeout(() => res("timeout"), 8000);
});
console.log("3. ws " + opened + " after " + (Date.now() - t0) + "ms");
if (opened === "open") {
  ws.send(JSON.stringify({ id: 1, method: "Target.getTargets", params: {} }));
  const reply = await new Promise((res) => {
    ws.addEventListener("message", (ev) => res(JSON.parse(ev.data.toString())), { once: true });
    setTimeout(() => res({ id: 1, timeout: true }), 8000);
  });
  console.log("4. getTargets ->", reply.timeout ? "TIMEOUT" : (reply.result.targetInfos.length + " targets"));
  ws.close();
}
process.exit(0);
