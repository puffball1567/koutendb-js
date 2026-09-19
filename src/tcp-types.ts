import { Buffer } from "node:buffer";
export const HEADER = 8192;
export const MAX_FRAME = 64 * 1024 * 1024;
export class TcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class ConnectionException extends TcpError {}
export class ConnectionTimeoutException extends ConnectionException {}
export class AuthenticationException extends TcpError {}
export class ProtocolException extends TcpError {}
export class VersionMismatchException extends ProtocolException {}
export class ServerException extends TcpError {}
export class IndeterminateWriteException extends TcpError {}
export const protocol = () => new ProtocolException("Invalid wire response");
export type TcpCodec = "raw" | "json" | "nif" | "bif";
export function codec(s: string): TcpCodec {
  if (!["raw", "json", "nif", "bif"].includes(s)) throw protocol();
  return s as TcpCodec;
}
function uint(s: string, max: bigint): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(s) || s.length > 20) throw protocol();
  const n = BigInt(s);
  if (n > max) throw protocol();
  return n;
}
export function length(s: string, max: number): number {
  return Number(uint(s, BigInt(max)));
}
export interface TcpId {
  parent: bigint;
  epoch: number;
  seq: number;
  tWrite: number;
  period: number;
  head: number;
}
export function parseTcpId(s: string): TcpId {
  const p = s.split(":");
  if (p.length !== 6) throw protocol();
  const coords = p.slice(3).map((v) => {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v))
      throw protocol();
    return Number(v);
  });
  if (!coords.every(Number.isFinite) || coords[1] <= 0) throw protocol();
  return {
    parent: uint(p[0], (1n << 64n) - 1n),
    epoch: length(p[1], 0xffffffff),
    seq: length(p[2], 0xffffffff),
    tWrite: coords[0],
    period: coords[1],
    head: coords[2],
  };
}
export function formatTcpId(id: TcpId): string {
  const s = `${id.parent}:${id.epoch}:${id.seq}:${id.tWrite}:${id.period}:${id.head}`;
  parseTcpId(s);
  return s;
}
export interface TcpOptions {
  timeout?: number;
  readTimeout?: number;
  writeTimeout?: number;
  maxFrameBytes?: number;
  maxRedirects?: number;
  retryReads?: boolean;
  username?: string;
  password?: string;
  authToken?: string;
  secretKey?: string;
  galaxy?: string;
  tls?: boolean;
  tlsCaFile?: string;
  tlsServerName?: string;
  tlsInsecureSkipVerify?: boolean;
}
export type Options = Required<TcpOptions>;
const defaults: Options = {
  timeout: 3,
  readTimeout: 5,
  writeTimeout: 5,
  maxFrameBytes: MAX_FRAME,
  maxRedirects: 8,
  retryReads: true,
  username: "",
  password: "",
  authToken: "",
  secretKey: "",
  galaxy: "",
  tls: false,
  tlsCaFile: "",
  tlsServerName: "",
  tlsInsecureSkipVerify: false,
};
export function options(input: TcpOptions): Options {
  const o = {
    ...defaults,
    ...Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ),
  } as Options;
  for (const key of Object.keys(o) as (keyof Options)[]) {
    if (!(key in defaults) || typeof o[key] !== typeof defaults[key])
      throw new TypeError("Invalid TCP option");
  }
  for (const t of [o.timeout, o.readTimeout, o.writeTimeout])
    if (!Number.isFinite(t) || t <= 0 || t > 3600)
      throw new TypeError("Timeout must be in (0, 3600] seconds");
  if (
    !Number.isInteger(o.maxFrameBytes) ||
    o.maxFrameBytes < 1 ||
    o.maxFrameBytes > MAX_FRAME ||
    !Number.isInteger(o.maxRedirects) ||
    o.maxRedirects < 0 ||
    o.maxRedirects > 32
  )
    throw new TypeError("Invalid TCP limit");
  if (!o.username && o.authToken) {
    o.username = "token";
    o.password = o.authToken;
  }
  for (const f of [o.username, o.password, o.galaxy])
    if (Buffer.byteLength(f) > 1024 || /[\x00-\x20\x7f]/.test(f))
      throw new TypeError("Invalid authentication or galaxy field");
  if (!o.username && (o.password || o.secretKey))
    throw new TypeError("Authentication requires username");
  if (!o.tls && (o.tlsCaFile || o.tlsServerName || o.tlsInsecureSkipVerify))
    throw new TypeError("TLS options require tls=true");
  return o;
}
export function endpoint(s: string): { host: string; port: number } {
  if (typeof s !== "string") throw new TypeError("Invalid TCP peer");
  const m = /^(?:([a-zA-Z0-9._-]+)|\[([a-fA-F0-9:]+)\]):([0-9]{1,5})$/.exec(s);
  if (!m || Number(m[3]) < 1 || Number(m[3]) > 65535)
    throw new TypeError("Invalid TCP peer");
  return { host: m[1] ?? m[2], port: Number(m[3]) };
}
export function expect(
  p: string[],
  tag: string,
  n: number,
  auth = false,
): void {
  if (p[0] === "ERR")
    throw auth
      ? new AuthenticationException("Authentication or galaxy rejected")
      : new ServerException("Server rejected request");
  if (p.length !== n || p[0] !== tag) throw protocol();
}
