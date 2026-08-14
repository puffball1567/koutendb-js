import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface KoutenId {
  parent: bigint;
  epoch: number;
  seq: number;
  tWrite: number;
}

export type KoutenDbErrorKind =
  | "abi"
  | "abi_version_mismatch"
  | "closed"
  | "invalid_id"
  | "not_found"
  | "nul_byte"
  | "utf8"
  | "type"
  | "unknown";

export class KoutenDbError extends Error {
  readonly kind: KoutenDbErrorKind;
  readonly cause?: unknown;

  constructor(kind: KoutenDbErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = "KoutenDbError";
    this.kind = kind;
    this.cause = cause;
  }
}

export function isKoutenDbError(value: unknown): value is KoutenDbError {
  return value instanceof KoutenDbError;
}

export function formatKoutenId(id: KoutenId): string {
  return `${id.parent}:${id.epoch}:${id.seq}:${id.tWrite}`;
}

export function parseKoutenId(value: string): KoutenId {
  const parts = value.split(":");
  if (parts.length !== 4) {
    throw new KoutenDbError(
      "invalid_id",
      `invalid KoutenDB id '${value}': expected parent:epoch:seq:tWrite`,
    );
  }

  try {
    return {
      parent: BigInt(parts[0]),
      epoch: parseUint32Part(parts[1], "epoch"),
      seq: parseUint32Part(parts[2], "seq"),
      tWrite: parseNumberPart(parts[3], "tWrite"),
    };
  } catch (error) {
    if (error instanceof KoutenDbError) throw error;
    throw new KoutenDbError("invalid_id", `invalid KoutenDB id '${value}'`, error);
  }
}

export interface ConnectOptions {
  username?: string;
  password?: string;
  authToken?: string;
  secretKey?: string;
  galaxy?: string;
  /** Enable TLS. Requires a KoutenDB core built with `-d:ssl`. */
  tls?: boolean;
  /**
   * Verify the server against a CA or self-signed certificate PEM, and enable
   * TLS. Certificate verification stays on, so this is the right way to reach a
   * server with a private CA or self-signed certificate.
   */
  tlsCaFile?: string;
  /** Override the hostname used for verification and SNI, and enable TLS. */
  tlsServerName?: string;
  /**
   * Disable certificate verification entirely, and enable TLS. The connection
   * is then encrypted but unauthenticated and trivially impersonable, so this
   * is for local smoke tests only — never a production server. Prefer
   * `tlsCaFile` for self-signed certificates.
   */
  dangerouslyAcceptInvalidCerts?: boolean;
}

export interface OpenDirOptions {
  nodes?: number;
  strongDurability?: boolean;
  diskBacked?: boolean;
}

export type MetricsFormat = "key-value" | "prometheus" | "openmetrics";

export interface SegmentMaintenancePolicy {
  staleRatio?: number;
  minStaleRecords?: number;
  maxRings?: number;
  maxBytes?: number | bigint;
  maxElapsedMs?: number | bigint;
}

export interface RetrieveOptions {
  ring?: string;
  budget?: number;
  topRings?: number;
  focus?: number;
}

export type PayloadCodec = "raw" | "json" | "nif" | "bif";

export interface ReadRingOptions {
  filter?: Record<string, unknown>;
  filterJson?: string;
  selection?: string;
  limit?: number;
  cursor?: string;
  pagination?: boolean;
  page?: number;
  pageLimit?: number;
  sort?: "id" | "time" | "write" | string;
  rsort?: "id" | "time" | "write" | string;
}

export interface ReadRingItem {
  id: string;
  rawId: string;
  codec: PayloadCodec;
  encoding: string;
  payload: unknown;
}

export interface ReadRingPage {
  ring: string;
  count: number;
  pagination: "on" | "off";
  page: number;
  pageLimit: number;
  sort: string;
  sortDirection: "asc" | "desc";
  items: ReadRingItem[];
  nextCursor: string;
}

export interface RetrieveStats {
  totalVectors: number;
  scanned: number;
  skippedVectors: number;
  returned: number;
  ringsTouched: number;
  payloadBytes: number;
  estimatedTokens: number;
  fanoutNodes: number;
  candidateReduction: number;
}

export interface RetrieveHit {
  id: KoutenId;
  score: number;
  payload: Uint8Array;
}

export interface EncodedPayload {
  data: Uint8Array;
  codec: PayloadCodec;
}

export interface RetrieveResult {
  hits: RetrieveHit[];
  stats: RetrieveStats;
}

interface NativeBinding {
  open(nodes: number): unknown;
  openDir(nodes: number, dir: string): unknown;
  openDirOptions(nodes: number, dir: string, strongDurability: number, diskBacked: number): unknown;
  connect(peers: string): unknown;
  connectAuth(
    peers: string,
    username: string,
    password: string,
    authToken: string,
    secretKey: string,
    galaxy: string,
  ): unknown;
  connectAuthTls(
    peers: string,
    username: string,
    password: string,
    authToken: string,
    secretKey: string,
    galaxy: string,
    tls: number,
    tlsCaFile: string,
    tlsServerName: string,
    tlsInsecureSkipVerify: number,
  ): unknown;
  abiVersion(): number;
  close(db: unknown): void;
  put(db: unknown, ring: string, data: Uint8Array | string, vec?: Float32Array): KoutenId;
  putCodec(
    db: unknown,
    ring: string,
    data: Uint8Array | ArrayBuffer | string,
    codec: number,
    vec?: Float32Array,
  ): KoutenId;
  get(db: unknown, id: KoutenId): Uint8Array | null;
  getEncoded(db: unknown, id: KoutenId): EncodedPayload | null;
  exists(db: unknown, id: KoutenId): boolean;
  update(db: unknown, id: KoutenId, data: Uint8Array | ArrayBuffer | string, codec?: number): void;
  remove(db: unknown, id: KoutenId): void;
  batchGet(db: unknown, ids: KoutenId[]): Array<Uint8Array | null>;
  query(db: unknown, id: KoutenId, selection: string): Uint8Array;
  readRingJson(
    db: unknown,
    ring: string,
    filterJson: string,
    selection: string,
    limit: number,
    cursor: string,
    pagination: number,
    page: number,
    pageLimit: number,
    sortField: string,
    sortDesc: number,
  ): string;
  retrieve(
    db: unknown,
    vec: Float32Array,
    ring: string,
    budget: number,
    topRings: number,
    focus: number,
  ): RetrieveResult;
  atlas(db: unknown, vec: Float32Array | undefined, maxCentroidDims: number): string;
  metrics(db: unknown, format: number): string;
  segmentStatus(db: unknown, staleRatio: number, minStaleRecords: number): string;
  segmentMaintenancePlan(db: unknown, staleRatio: number, minStaleRecords: number, maxRings: number, maxBytes: number | bigint, maxElapsedMs: number | bigint): string;
  segmentMaintenanceRun(db: unknown, staleRatio: number, minStaleRecords: number, maxRings: number, maxBytes: number | bigint, maxElapsedMs: number | bigint): string;
  segmentMaintenanceStatus(db: unknown): string;
  segmentMaintenanceRecover(db: unknown): boolean;
  checkpointCreate(db: unknown, root: string, checkpointId: string): string;
  checkpointStatus(checkpointDir: string): string;
  checkpointList(root: string): string;
  checkpointCleanup(root: string, keep: number): string;
  checkpointRestore(checkpointDir: string, dataDir: string, overwrite: number): string;
  checkpointMetrics(root: string, format: number): string;
  locate(db: unknown, id: KoutenId, at: number): number;
  now(db: unknown): number;
  advance(db: unknown, dt: number): void;
  nextVisit(db: unknown, id: KoutenId, node: number): number;
  nextJoin(db: unknown, a: KoutenId, b: KoutenId): number;
  configureRing(db: unknown, ring: string, period: number): void;
  setGalaxyDescription(db: unknown, description: string): void;
  setRingDescription(db: unknown, ring: string, description: string): void;
}

function loadNative(): NativeBinding {
  const require = createRequire(import.meta.url);
  const here = dirname(fileURLToPath(import.meta.url));
  const nativePath =
    process.env.KOUTENDB_NATIVE_PATH ??
    join(here, "..", "build", "Release", "koutendb_native.node");
  return require(nativePath) as NativeBinding;
}

const native = loadNative();

function parseUint32Part(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new KoutenDbError("invalid_id", `invalid KoutenDB id field '${name}': ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new KoutenDbError("invalid_id", `invalid KoutenDB id field '${name}' is out of range`);
  }
  return parsed;
}

function parseNumberPart(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new KoutenDbError("invalid_id", `invalid KoutenDB id field '${name}': ${value}`);
  }
  return parsed;
}

function classifyNativeError(error: unknown): KoutenDbErrorKind {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("abi version")) return "abi_version_mismatch";
  if (lower.includes("closed")) return "closed";
  if (lower.includes("not found")) return "not_found";
  if (lower.includes("nul") || lower.includes("null byte")) return "nul_byte";
  if (lower.includes("utf")) return "utf8";
  if (lower.includes("must be") || lower.includes("requires")) return "type";
  if (lower.includes("abi")) return "abi";
  return "unknown";
}

// On Node the built-in OpenSSL and the system libssl that the core dlopens can
// collide, leaving the error queue empty on the copy the core reads. TLS
// failures then surface as this sentinel with no detail. The failure itself is
// unaffected (connections still fail closed); only the message is lost.
const OPENSSL_EMPTY_SENTINEL = "No error reported.";

function enrichNativeMessage(message: string): string {
  if (message.trim() !== OPENSSL_EMPTY_SENTINEL) return message;
  return (
    "TLS operation failed, but OpenSSL reported no detail. On Node this usually " +
    "means certificate verification failed — check tlsCaFile, tlsServerName, or " +
    "the server certificate. Original: " +
    OPENSSL_EMPTY_SENTINEL
  );
}

function wrapNative<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof KoutenDbError) throw error;
    const raw = error instanceof Error ? error.message : String(error);
    const message = enrichNativeMessage(raw);
    throw new KoutenDbError(classifyNativeError(error), message, error);
  }
}

/** KoutenDB C ABI version the loaded native library was built against. */
export function abiVersion(): number {
  return wrapNative(() => native.abiVersion());
}

function bytes(data: string | Uint8Array | ArrayBuffer): string | Uint8Array {
  if (typeof data === "string") return Buffer.from(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

function vector(vec: number[] | Float32Array): Float32Array {
  return vec instanceof Float32Array ? vec : new Float32Array(vec);
}

function codecCode(codec: PayloadCodec): number {
  switch (codec) {
    case "raw":
      return 0;
    case "json":
      return 1;
    case "nif":
      return 2;
    case "bif":
      return 3;
    default:
      throw new KoutenDbError("type", `unsupported payload codec: ${codec}`);
  }
}

function metricsFormatCode(format: MetricsFormat): number {
  switch (format) {
    case "key-value": return 0;
    case "prometheus": return 1;
    case "openmetrics": return 2;
  }
}

function parseNativeJson(raw: string, operation: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new KoutenDbError("utf8", `KoutenDB ${operation} returned invalid JSON`, error);
  }
}

export class KoutenDb {
  #handle: unknown;
  #closed = false;

  private constructor(handle: unknown) {
    this.#handle = handle;
  }

  static open(nodes = 8): KoutenDb {
    return wrapNative(() => new KoutenDb(native.open(nodes)));
  }

  static openDir(nodes: number, dir: string): KoutenDb {
    return wrapNative(() => new KoutenDb(native.openDir(nodes, dir)));
  }

  static openDirWith(dir: string, options: OpenDirOptions = {}): KoutenDb {
    return wrapNative(() => new KoutenDb(native.openDirOptions(
      options.nodes ?? 8,
      dir,
      options.strongDurability === true ? 1 : 0,
      options.diskBacked === true ? 1 : 0,
    )));
  }

  static connect(peers: string, options: ConnectOptions = {}): KoutenDb {
    const useTls =
      options.tls === true ||
      options.tlsCaFile !== undefined ||
      options.tlsServerName !== undefined ||
      options.dangerouslyAcceptInvalidCerts === true;
    if (useTls) {
      return wrapNative(
        () => new KoutenDb(native.connectAuthTls(
          peers,
          options.username ?? "",
          options.password ?? "",
          options.authToken ?? "",
          options.secretKey ?? "",
          options.galaxy ?? "",
          1,
          options.tlsCaFile ?? "",
          options.tlsServerName ?? "",
          options.dangerouslyAcceptInvalidCerts === true ? 1 : 0,
        )),
      );
    }
    const hasAuth =
      options.username !== undefined ||
      options.password !== undefined ||
      options.authToken !== undefined ||
      options.secretKey !== undefined ||
      options.galaxy !== undefined;
    if (!hasAuth) {
      return wrapNative(() => new KoutenDb(native.connect(peers)));
    }
    return wrapNative(
      () => new KoutenDb(native.connectAuth(
        peers,
        options.username ?? "",
        options.password ?? "",
        options.authToken ?? "",
        options.secretKey ?? "",
        options.galaxy ?? "",
      )),
    );
  }

  close(): void {
    if (!this.#closed) {
      wrapNative(() => native.close(this.#handle));
      this.#closed = true;
    }
  }

  put(ring: string, data: string | Uint8Array): KoutenId {
    return wrapNative(() => native.put(this.#handle, ring, bytes(data)));
  }

  putCodec(ring: string, data: string | Uint8Array | ArrayBuffer, codec: PayloadCodec): KoutenId {
    return wrapNative(() => native.putCodec(this.#handle, ring, bytes(data), codecCode(codec)));
  }

  putJson(ring: string, value: unknown): KoutenId {
    return this.putCodec(ring, JSON.stringify(value), "json");
  }

  putNif(ring: string, text: string): KoutenId {
    return this.putCodec(ring, text, "nif");
  }

  putBif(ring: string, data: Uint8Array): KoutenId {
    return this.putCodec(ring, data, "bif");
  }

  putVec(ring: string, data: string | Uint8Array, vec: number[] | Float32Array): KoutenId {
    return wrapNative(() => native.put(this.#handle, ring, bytes(data), vector(vec)));
  }

  putVecCodec(
    ring: string,
    data: string | Uint8Array | ArrayBuffer,
    vec: number[] | Float32Array,
    codec: PayloadCodec,
  ): KoutenId {
    return wrapNative(() => native.putCodec(
      this.#handle,
      ring,
      bytes(data),
      codecCode(codec),
      vector(vec),
    ));
  }

  putJsonVec(ring: string, value: unknown, vec: number[] | Float32Array): KoutenId {
    return this.putVecCodec(ring, JSON.stringify(value), vec, "json");
  }

  putNifVec(ring: string, text: string, vec: number[] | Float32Array): KoutenId {
    return this.putVecCodec(ring, text, vec, "nif");
  }

  putBifVec(ring: string, data: Uint8Array, vec: number[] | Float32Array): KoutenId {
    return this.putVecCodec(ring, data, vec, "bif");
  }

  get(id: KoutenId): Uint8Array | null {
    return wrapNative(() => native.get(this.#handle, id));
  }

  getEncoded(id: KoutenId): EncodedPayload | null {
    return wrapNative(() => native.getEncoded(this.#handle, id));
  }

  getString(id: KoutenId): string | null {
    const value = this.get(id);
    return value === null ? null : new TextDecoder().decode(value);
  }

  exists(id: KoutenId): boolean {
    return wrapNative(() => native.exists(this.#handle, id));
  }

  update(id: KoutenId, data: string | Uint8Array | ArrayBuffer): void {
    wrapNative(() => native.update(this.#handle, id, bytes(data)));
  }

  updateCodec(id: KoutenId, data: string | Uint8Array | ArrayBuffer, codec: PayloadCodec): void {
    wrapNative(() => native.update(this.#handle, id, bytes(data), codecCode(codec)));
  }

  updateJson(id: KoutenId, value: unknown): void {
    this.updateCodec(id, JSON.stringify(value), "json");
  }

  remove(id: KoutenId): void {
    wrapNative(() => native.remove(this.#handle, id));
  }

  batchGet(ids: KoutenId[]): Array<Uint8Array | null> {
    return wrapNative(() => native.batchGet(this.#handle, ids));
  }

  batchGetStrings(ids: KoutenId[]): Array<string | null> {
    const decoder = new TextDecoder();
    return this.batchGet(ids).map((value) => (value === null ? null : decoder.decode(value)));
  }

  query(id: KoutenId, selection: string): Uint8Array {
    return wrapNative(() => native.query(this.#handle, id, selection));
  }

  queryString(id: KoutenId, selection: string): string {
    return new TextDecoder().decode(this.query(id, selection));
  }

  readRing(ring: string, options: ReadRingOptions = {}): ReadRingPage {
    if (options.sort !== undefined && options.rsort !== undefined) {
      throw new KoutenDbError("type", "readRing options cannot set both sort and rsort");
    }
    const filterJson = options.filterJson ?? JSON.stringify(options.filter ?? {});
    const sortField = options.sort ?? options.rsort ?? "";
    const sortDesc = options.sort === undefined ? 1 : 0;
    const raw = wrapNative(() => native.readRingJson(
      this.#handle,
      ring,
      filterJson,
      options.selection ?? "",
      options.limit ?? 100,
      options.cursor ?? "",
      options.pagination === true ? 1 : 0,
      options.page ?? 1,
      options.pageLimit ?? 20,
      sortField,
      sortDesc,
    ));
    try {
      return JSON.parse(raw) as ReadRingPage;
    } catch (error) {
      throw new KoutenDbError("utf8", "KoutenDB readRing returned invalid JSON", error);
    }
  }

  retrieve(vec: number[] | Float32Array, options: RetrieveOptions = {}): RetrieveResult {
    return wrapNative(() => native.retrieve(
      this.#handle,
      vector(vec),
      options.ring ?? "",
      options.budget ?? 8,
      options.topRings ?? 0,
      options.focus ?? 0,
    ));
  }

  atlas(vec?: number[] | Float32Array, maxCentroidDims = 8): unknown {
    const raw = wrapNative(() => native.atlas(
      this.#handle,
      vec === undefined ? undefined : vector(vec),
      maxCentroidDims,
    ));
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new KoutenDbError("utf8", "KoutenDB atlas returned invalid JSON", error);
    }
  }

  metrics(format: MetricsFormat = "key-value"): string {
    return wrapNative(() => native.metrics(this.#handle, metricsFormatCode(format)));
  }

  segmentStatus(staleRatio = 0.25, minStaleRecords = 256): unknown {
    return parseNativeJson(
      wrapNative(() => native.segmentStatus(this.#handle, staleRatio, minStaleRecords)),
      "segmentStatus",
    );
  }

  planSegmentMaintenance(policy: SegmentMaintenancePolicy = {}): unknown {
    return parseNativeJson(this.segmentMaintenance(false, policy), "segmentMaintenancePlan");
  }

  runSegmentMaintenance(policy: SegmentMaintenancePolicy = {}): unknown {
    return parseNativeJson(this.segmentMaintenance(true, policy), "segmentMaintenanceRun");
  }

  segmentMaintenanceStatus(): unknown {
    return parseNativeJson(
      wrapNative(() => native.segmentMaintenanceStatus(this.#handle)),
      "segmentMaintenanceStatus",
    );
  }

  recoverSegmentMaintenance(): boolean {
    return wrapNative(() => native.segmentMaintenanceRecover(this.#handle));
  }

  createCheckpoint(root?: string, checkpointId?: string): unknown {
    return parseNativeJson(
      wrapNative(() => native.checkpointCreate(this.#handle, root ?? "", checkpointId ?? "")),
      "checkpointCreate",
    );
  }

  static checkpointStatus(checkpointDir: string): unknown {
    return parseNativeJson(wrapNative(() => native.checkpointStatus(checkpointDir)), "checkpointStatus");
  }

  static listCheckpoints(root: string): unknown {
    return parseNativeJson(wrapNative(() => native.checkpointList(root)), "checkpointList");
  }

  static cleanupCheckpoints(root: string, keep: number): unknown {
    return parseNativeJson(wrapNative(() => native.checkpointCleanup(root, keep)), "checkpointCleanup");
  }

  static restoreCheckpoint(checkpointDir: string, dataDir: string, overwrite = false): unknown {
    return parseNativeJson(
      wrapNative(() => native.checkpointRestore(checkpointDir, dataDir, overwrite ? 1 : 0)),
      "checkpointRestore",
    );
  }

  static checkpointMetrics(root: string, format: MetricsFormat = "key-value"): string {
    return wrapNative(() => native.checkpointMetrics(root, metricsFormatCode(format)));
  }

  private segmentMaintenance(run: boolean, policy: SegmentMaintenancePolicy): string {
    const call = run ? native.segmentMaintenanceRun : native.segmentMaintenancePlan;
    return wrapNative(() => call(
      this.#handle,
      policy.staleRatio ?? 0.25,
      policy.minStaleRecords ?? 256,
      policy.maxRings ?? 0,
      policy.maxBytes ?? 0,
      policy.maxElapsedMs ?? 0,
    ));
  }

  locate(id: KoutenId, at = -1): number {
    return wrapNative(() => native.locate(this.#handle, id, at));
  }

  now(): number {
    return wrapNative(() => native.now(this.#handle));
  }

  advance(dt: number): void {
    wrapNative(() => native.advance(this.#handle, dt));
  }

  nextVisit(id: KoutenId, node: number): number {
    return wrapNative(() => native.nextVisit(this.#handle, id, node));
  }

  nextJoin(a: KoutenId, b: KoutenId): number {
    return wrapNative(() => native.nextJoin(this.#handle, a, b));
  }

  configureRing(ring: string, period: number): void {
    wrapNative(() => native.configureRing(this.#handle, ring, period));
  }

  setGalaxyDescription(description: string): void {
    wrapNative(() => native.setGalaxyDescription(this.#handle, description));
  }

  setRingDescription(ring: string, description: string): void {
    wrapNative(() => native.setRingDescription(this.#handle, ring, description));
  }
}
