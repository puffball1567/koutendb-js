import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect as netConnect, Socket } from "node:net";
import { connect as tlsConnect, TLSSocket } from "node:tls";
import { performance } from "node:perf_hooks";
import { xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { blake2b } from "@noble/hashes/blake2.js";
import {
  HEADER,
  ConnectionException,
  ConnectionTimeoutException,
  ProtocolException,
  protocol,
  length,
  endpoint,
  type Options,
} from "./tcp-types.js";
export function derive(s: string): Uint8Array {
  return blake2b(Buffer.from(s), { dkLen: 32 });
}
export function encrypt(key: Uint8Array, body: Uint8Array): Buffer {
  const nonce = randomBytes(24);
  return Buffer.concat([nonce, xsalsa20poly1305(key, nonce).encrypt(body)]);
}

export class Connection {
  #socket: Socket | TLSSocket;
  #failed = false;
  #key?: Uint8Array;
  #plain: Buffer = Buffer.alloc(0);
  #offset = 0;
  #deadline = 0;
  constructor(socket: Socket | TLSSocket) {
    this.#socket = socket;
    socket.on("error", () => {
      this.#failed = true;
    });
    socket.on("end", () => {
      this.#failed = true;
    });
    socket.on("close", () => {
      this.#failed = true;
    });
  }
  static async open(peer: string, o: Options): Promise<Connection> {
    const address = endpoint(peer);
    let socket: Socket | TLSSocket;
    try {
      socket = o.tls
        ? tlsConnect({
            ...address,
            servername: o.tlsServerName || address.host,
            rejectUnauthorized: !o.tlsInsecureSkipVerify,
            minVersion: "TLSv1.2",
            ca: o.tlsCaFile ? readFileSync(o.tlsCaFile) : undefined,
          })
        : netConnect(address);
    } catch {
      throw new ConnectionException("Unable to connect or configure TLS");
    }
    const c = new Connection(socket);
    socket.setNoDelay(true);
    try {
      await c.#wait(
        o.tls ? "secureConnect" : "connect",
        performance.now() + o.timeout * 1000,
      );
      return c;
    } catch (e) {
      c.close();
      throw e;
    }
  }
  close(): void {
    this.#failed = true;
    this.#socket.destroy();
    this.#key?.fill(0);
    this.#key = undefined;
    this.#plain = Buffer.alloc(0);
    this.#offset = 0;
  }
  secure(key: Uint8Array): void {
    this.#key = key;
  }
  #wait(event: string, deadline: number): Promise<void> {
    if (this.#failed)
      return Promise.reject(new ConnectionException("TCP connection closed"));
    const ms = deadline - performance.now();
    if (ms <= 0)
      return Promise.reject(
        new ConnectionTimeoutException("TCP operation timed out"),
      );
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.#socket.off(event, ready);
        this.#socket.off("error", failed);
        this.#socket.off("end", failed);
        this.#socket.off("close", failed);
        error ? reject(error) : resolve();
      };
      const ready = () => finish();
      const failed = () =>
        finish(new ConnectionException("TCP connection closed"));
      const timer = setTimeout(
        () => finish(new ConnectionTimeoutException("TCP operation timed out")),
        ms,
      );
      this.#socket.once(event, ready);
      this.#socket.once("error", failed);
      this.#socket.once("end", failed);
      this.#socket.once("close", failed);
    });
  }
  async send(
    header: string,
    body: Uint8Array,
    o: Options,
    attempt?: { sent: boolean },
  ): Promise<void> {
    if (
      header.length > HEADER ||
      /[\r\n\0]/.test(header) ||
      body.length > o.maxFrameBytes
    )
      throw new TypeError("Request exceeds bounds");
    let frame: Buffer = Buffer.concat([Buffer.from(header + "\n"), body]);
    if (this.#key) {
      const enc = encrypt(this.#key, frame);
      frame = Buffer.concat([Buffer.from(`SEC ${enc.length}\n`), enc]);
    }
    if (this.#failed) throw new ConnectionException("TCP connection closed");
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.#socket.off("error", failed);
        this.#socket.off("close", failed);
        error ? reject(error) : resolve();
      };
      const failed = () => finish(new ConnectionException("TCP write failed"));
      const timer = setTimeout(
        () => finish(new ConnectionTimeoutException("TCP write timed out")),
        o.writeTimeout * 1000,
      );
      this.#socket.once("error", failed);
      this.#socket.once("close", failed);
      if (attempt) attempt.sent = true;
      this.#socket.write(frame, (error) => (error ? failed() : finish()));
    });
    this.#deadline = performance.now() + o.readTimeout * 1000;
  }
  async #raw(n: number): Promise<Buffer> {
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      if (performance.now() >= this.#deadline)
        throw new ConnectionTimeoutException("TCP read timed out");
      const available = this.#socket.readableLength;
      const chunk: Buffer | null =
        available > 0
          ? this.#socket.read(Math.min(n - offset, available, 8192))
          : this.#socket.read(0);
      if (chunk) {
        chunk.copy(out, offset);
        offset += chunk.length;
      } else await this.#wait("readable", this.#deadline);
    }
    return out;
  }
  async #rawLine(): Promise<Buffer> {
    const out = Buffer.allocUnsafe(HEADER);
    let size = 0;
    for (;;) {
      const b = (await this.#raw(1))[0];
      if (b === 10) return out.subarray(0, size);
      if (size === HEADER) throw protocol();
      out[size++] = b;
    }
  }
  async #fill(max: number): Promise<void> {
    const header = await this.#rawLine();
    if (!header.every((b) => b >= 32 && b <= 126)) throw protocol();
    const p = header.toString("ascii").split(" ");
    if (p.length !== 2 || p[0] !== "SEC") throw protocol();
    const n = length(p[1], max + HEADER + 41);
    if (n < 40) throw protocol();
    const enc = await this.#raw(n);
    let value: Uint8Array;
    try {
      value = xsalsa20poly1305(this.#key!, enc.subarray(0, 24)).decrypt(
        enc.subarray(24),
      );
    } catch {
      throw new ProtocolException("Encrypted frame authentication failed");
    }
    if (this.#plain.length - this.#offset + value.length > max + HEADER + 1)
      throw protocol();
    this.#plain = Buffer.concat([this.#plain.subarray(this.#offset), value]);
    this.#offset = 0;
  }
  async bytes(n: number, max: number): Promise<Buffer> {
    if (!this.#key) return this.#raw(n);
    while (this.#plain.length - this.#offset < n) await this.#fill(max);
    const out = this.#plain.subarray(this.#offset, this.#offset + n);
    this.#offset += n;
    return out;
  }
  async header(max: number): Promise<string[]> {
    let line: Buffer;
    if (!this.#key) line = await this.#rawLine();
    else {
      const out = Buffer.allocUnsafe(HEADER);
      let size = 0;
      for (;;) {
        const b = (await this.bytes(1, max))[0];
        if (b === 10) break;
        if (size === HEADER) throw protocol();
        out[size++] = b;
      }
      line = out.subarray(0, size);
    }
    if (line.at(-1) === 13) line = line.subarray(0, -1);
    if (!line.length || !line.every((b) => b >= 32 && b <= 126))
      throw protocol();
    return line.toString("ascii").split(" ");
  }
}
