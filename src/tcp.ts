import { Buffer } from "node:buffer";
import { Connection, derive, encrypt } from "./tcp-connection.js";
import {
  options,
  endpoint,
  expect,
  length,
  codec,
  protocol,
  formatTcpId,
  parseTcpId,
  ConnectionException,
  ProtocolException,
  VersionMismatchException,
  ServerException,
  IndeterminateWriteException,
  type Options,
  type TcpOptions,
  type TcpId,
  type TcpCodec,
} from "./tcp-types.js";
export {
  TcpError,
  ConnectionException,
  ConnectionTimeoutException,
  AuthenticationException,
  ProtocolException,
  VersionMismatchException,
  ServerException,
  IndeterminateWriteException,
  formatTcpId,
  parseTcpId,
  type TcpOptions,
  type TcpId,
  type TcpCodec,
} from "./tcp-types.js";

/** Native TCP connection. Calls are serialized on this instance. */
export class TcpClient {
  #peers: string[];
  #options: Options;
  #connections = new Map<number, Connection>();
  #closed = false;
  #queue: Promise<unknown> = Promise.resolve();
  private constructor(peers: string[], o: Options) {
    this.#peers = peers;
    this.#options = o;
  }
  static async connect(
    peers: string[],
    input: TcpOptions = {},
  ): Promise<TcpClient> {
    const o = options(input);
    if (!Array.isArray(peers) || !peers.length || peers.length > 64)
      throw new TypeError("Provide 1..64 ordered peers");
    for (const p of peers) endpoint(p);
    const c = new TcpClient([...peers], o);
    await c.#connection(0);
    return c;
  }
  close(): void {
    this.#closed = true;
    this.#drop();
  }
  #drop(): void {
    for (const c of this.#connections.values()) c.close();
    this.#connections.clear();
  }
  #serial<T>(op: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(op);
    this.#queue = result.catch(() => {});
    return result;
  }
  async #connection(node: number): Promise<Connection> {
    if (this.#closed) throw new ConnectionException("TCP client is closed");
    if (!Number.isInteger(node) || node < 0 || node >= this.#peers.length)
      throw protocol();
    const cached = this.#connections.get(node);
    if (cached) return cached;
    const o = this.#options;
    const c = await Connection.open(this.#peers[node], o);
    const exchange = async (header: string) => {
      await c.send(header, Buffer.alloc(0), o);
      return c.header(o.maxFrameBytes);
    };
    try {
      if (o.username) {
        if (!o.secretKey)
          expect(
            await exchange(`AUTH ${o.username} ${o.password}`),
            "OK",
            2,
            true,
          );
        else {
          const chal = await exchange(`AUTHCHAL ${o.username}`);
          expect(chal, "CHAL", 2, true);
          if (!/^[a-fA-F0-9]{64}$/.test(chal[1])) throw protocol();
          const key = derive(`koutendb-auth-v1\0box\0${o.secretKey}`);
          const msg = Buffer.from(
            `koutendb-auth-v1\n${o.username}\n${o.password}\n${chal[1]}`,
          );
          let enc: Buffer;
          try {
            enc = encrypt(key, msg);
          } finally {
            key.fill(0);
            msg.fill(0);
          }
          expect(
            await exchange(`AUTHRESP ${enc.toString("hex")}`),
            "OK",
            2,
            true,
          );
          c.secure(
            derive(`koutendb-auth-v1\0transport\0${chal[1]}\0${o.secretKey}`),
          );
        }
      }
      if (o.galaxy) expect(await exchange(`HELLO ${o.galaxy}`), "OK", 2, true);
      const v = await exchange("WIREVER");
      expect(v, "WIREVER", 2, true);
      if (v[1] !== "1")
        throw new VersionMismatchException("Unsupported KoutenDB wire version");
      const ack = await exchange("CODECMETA ON");
      expect(ack, "OK", 2);
      if (ack[1] !== "codec-metadata") throw protocol();
      if (this.#closed) throw new ConnectionException("TCP client is closed");
      this.#connections.set(node, c);
      return c;
    } catch (e) {
      c.close();
      throw e;
    }
  }
  put(ring: string, payload: Uint8Array): Promise<TcpId> {
    return this.putCodec(ring, payload, "raw");
  }
  putJson(ring: string, value: unknown): Promise<TcpId> {
    return this.putCodec(ring, Buffer.from(JSON.stringify(value)), "json");
  }
  putCodec(ring: string, payload: Uint8Array, type: TcpCodec): Promise<TcpId> {
    codec(type);
    const r = Buffer.from(ring);
    if (!r.length || r.length + payload.length > this.#options.maxFrameBytes)
      throw new TypeError("Invalid ring or payload size");
    const body = Buffer.concat([r, payload]);
    return this.#serial(async () => {
      const attempt = { sent: false };
      try {
        const c = await this.#connection(0);
        await c.send(
          `PUTR ${r.length} ${body.length - r.length} 0 ${type}`,
          body,
          this.#options,
          attempt,
        );
        const id = await c.header(this.#options.maxFrameBytes);
        expect(id, "ID", 7);
        return parseTcpId(id.slice(1).join(":"));
      } catch (e) {
        this.#drop();
        if (
          attempt.sent &&
          (e instanceof ConnectionException || e instanceof ProtocolException)
        )
          throw new IndeterminateWriteException(
            "Write outcome unknown; do not automatically retry",
          );
        throw e;
      }
    });
  }
  async #retry<T>(op: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await op();
      } catch (e) {
        this.#drop();
        if (
          this.#closed ||
          !this.#options.retryReads ||
          attempt ||
          !(e instanceof ConnectionException)
        )
          throw e;
      }
    }
  }
  health(): Promise<string> {
    return this.#serial(() =>
      this.#retry(async () => {
        const c = await this.#connection(0);
        await c.send("HEALTH", Buffer.alloc(0), this.#options);
        const r = await c.header(this.#options.maxFrameBytes);
        if (r[0] === "ERR")
          throw new ServerException("Health request rejected");
        if (r[0] !== "OK" || !/^node=\d+$/.test(r[1] ?? "")) throw protocol();
        return r.slice(1).join(" ");
      }),
    );
  }
  #read(
    id: TcpId,
    selection?: string,
  ): Promise<{ payload: Buffer; codec: TcpCodec } | null> {
    const original = formatTcpId(id);
    const body = Buffer.from(selection ?? "");
    if (body.length > this.#options.maxFrameBytes)
      throw new TypeError("Selection exceeds limit");
    return this.#serial(() =>
      this.#retry(async () => {
        let fields = original.replaceAll(":", " ");
        let node = 0;
        for (let redirects = 0; ; redirects++) {
          const c = await this.#connection(node);
          await c.send(
            selection === undefined
              ? `GETID ${fields}`
              : `QRYID ${fields} ${body.length}`,
            body,
            this.#options,
          );
          const r = await c.header(this.#options.maxFrameBytes);
          if (r[0] === "MISS" || r[0] === "GONE") {
            expect(r, r[0], 1);
            return null;
          }
          if (r[0] === "FWD") {
            if (
              redirects >= this.#options.maxRedirects ||
              ![7, 8].includes(r.length)
            )
              throw protocol();
            fields = formatTcpId(
              parseTcpId(r.slice(1, 7).join(":")),
            ).replaceAll(":", " ");
            if (r.length === 8) node = length(r[7], this.#peers.length - 1);
            continue;
          }
          expect(r, "VAL", 4);
          length(r[1], this.#peers.length - 1);
          const n = length(r[2], this.#options.maxFrameBytes);
          const type = codec(r[3]);
          return {
            payload: await c.bytes(n, this.#options.maxFrameBytes),
            codec: type,
          };
        }
      }),
    );
  }
  getEncoded(id: TcpId): Promise<{ payload: Buffer; codec: TcpCodec } | null> {
    return this.#read(id);
  }
  async get(id: TcpId): Promise<Buffer | null> {
    return (await this.getEncoded(id))?.payload ?? null;
  }
  async getJson(id: TcpId): Promise<unknown> {
    const b = await this.get(id);
    return b === null ? null : JSON.parse(b.toString("utf8"));
  }
  async query(id: TcpId, selection: string): Promise<Buffer | null> {
    return (await this.#read(id, selection))?.payload ?? null;
  }
  async queryJson(id: TcpId, selection: string): Promise<unknown> {
    const b = await this.query(id, selection);
    return b === null ? null : JSON.parse(b.toString("utf8"));
  }
}
