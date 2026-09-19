import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import {
  TcpClient,
  formatTcpId,
  parseTcpId,
  ProtocolException,
} from "../dist/index.js";
test("native import and complete ID roundtrip need no addon", () => {
  const id =
    "18446744073709551615:4294967295:4294967295:1.2345678901234567:60:0.5";
  assert.equal(formatTcpId(parseTcpId(id)), id);
});
test("ID bounds and finite coordinates", () => {
  for (const id of [
    "18446744073709551616:1:1:1:60:0",
    "1:4294967296:1:1:60:0",
    "1:1:1:NaN:60:0",
    "1:1:1:1:0:0",
    "1:1:1:1:60:Infinity",
  ])
    assert.throws(() => parseTcpId(id), ProtocolException);
});
test("invalid configuration fails before opening a socket", async () => {
  for (const peers of [
    [],
    ["localhost:0"],
    ["tcp://localhost:1"],
    ["localhost:99999"],
  ])
    await assert.rejects(TcpClient.connect(peers), TypeError);
  for (const options of [
    { timeout: 0 },
    { timeout: NaN },
    { readTimeout: Infinity },
    { maxFrameBytes: 0 },
    { maxRedirects: 33 },
    { tlsCaFile: "ca.pem" },
    { password: "secret" },
    { retryReads: "false" },
    { other: true },
  ])
    await assert.rejects(
      TcpClient.connect(["localhost:1"], options),
      TypeError,
    );
});

test("queued calls preserve frame boundaries and close is terminal", async () => {
  const sockets = new Set();
  const requests = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString();
      for (;;) {
        const n = pending.indexOf("\n");
        if (n < 0) return;
        const request = pending.slice(0, n);
        pending = pending.slice(n + 1);
        requests.push(request);
        if (request === "WIREVER") socket.write("WIREVER 1\n");
        else if (request === "CODECMETA ON")
          socket.write("OK codec-metadata\n");
        else if (request === "HEALTH") socket.write("OK node=0 ready\n");
        else socket.destroy();
      }
    });
  });
  let db;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    db = await TcpClient.connect([`127.0.0.1:${server.address().port}`], {
      password: undefined,
    });
    const replies = await Promise.all(
      Array.from({ length: 20 }, () => db.health()),
    );
    assert.deepEqual(replies, Array(20).fill("node=0 ready"));
    assert.equal(requests.filter((x) => x === "WIREVER").length, 1);
    db.close();
    db.close();
    await assert.rejects(db.health(), { name: "ConnectionException" });
  } finally {
    db?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
