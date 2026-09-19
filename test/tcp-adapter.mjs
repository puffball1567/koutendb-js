import { createInterface } from "node:readline";
import { inspect } from "node:util";
import { TcpClient, formatTcpId, parseTcpId } from "../dist/index.js";

let db;
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  try {
    const op = JSON.parse(line);
    let result;
    switch (op.op) {
      case "connect":
        db?.close();
        db = await TcpClient.connect(op.peers, {
          timeout: op.timeout ?? 1,
          readTimeout: op.readTimeout ?? 1,
          writeTimeout: op.writeTimeout ?? 1,
          ...op.options,
        });
        result = "connected";
        break;
      case "put":
        result = formatTcpId(
          await db.putCodec(
            op.ring,
            Buffer.from(op.payload, "base64"),
            op.codec ?? "raw",
          ),
        );
        break;
      case "putJson":
        result = formatTcpId(await db.putJson(op.ring, op.value));
        break;
      case "get": {
        const v = await db.getEncoded(parseTcpId(op.id));
        result =
          v === null
            ? null
            : { payload: v.payload.toString("base64"), codec: v.codec };
        break;
      }
      case "getJson":
        result = await db.getJson(parseTcpId(op.id));
        break;
      case "query":
        result = await db.queryJson(parseTcpId(op.id), op.selection);
        break;
      case "health":
        result = await db.health();
        break;
      case "debug":
        result = inspect(db);
        break;
      case "close":
        db?.close();
        result = "closed";
        break;
      default:
        throw new Error("Unknown adapter operation");
    }
    console.log(JSON.stringify({ ok: true, result }));
  } catch (e) {
    console.log(
      JSON.stringify({ ok: false, error: e.name, message: e.message }),
    );
  }
}
db?.close();
