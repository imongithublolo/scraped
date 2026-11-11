import { client as wisp } from "@mercuryworkshop/wisp-js/client";

const conn = new wisp.ClientConnection("ws://localhost:3031/wisp/");
await new Promise((res, rej) => { conn.onopen = res; conn.onclose = () => rej(new Error("closed")); setTimeout(()=>rej(new Error("timeout")), 4000); });
console.log("wisp connection established. version:", conn.wisp_version, "motd:", conn.server_motd ?? "(none)");

const stream = conn.create_stream("example.com", 80);
// send immediately — buffers until the server grants CONTINUE
stream.send("GET / HTTP/1.1\r\nHost: example.com\r\nUser-Agent: murke-test\r\nConnection: close\r\n\r\n");

const data = await new Promise((res, rej) => {
  let buf = "";
  stream.onmessage = (msg) => { buf += new TextDecoder().decode(msg); };
  stream.onclose = (code) => { if (code === 0) res(buf); else rej(new Error("stream close " + code)); };
  setTimeout(() => rej(new Error("no response")), 6000);
});
console.log("HTTP status line:", data.split("\r\n")[0]);
console.log("Contains Example Domain:", data.includes("Example Domain"));
conn.ws.close();
process.exit(0);
