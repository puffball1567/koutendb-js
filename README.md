# KoutenDB JavaScript / TypeScript Driver

JavaScript / TypeScript driver for KoutenDB.

This package currently targets Node.js through Node-API. Bun can load the same Node-API module in the local verification path, but Bun support should remain experimental until it is covered by CI.

## Status

- Package: `koutendb`
- Runtime target: Node.js 20+
- Source language: TypeScript
- Native boundary: Node-API, no `node-addon-api` dependency
- KoutenDB core: local C ABI v2 shared library; v0.12-compatible build required for persistence/maintenance APIs
- Bun: experimental, local demo/test path available

## Install

This driver is a Node-API addon over the KoutenDB C ABI. Install the JavaScript
package and make the KoutenDB shared library available before running your app.

Prerequisites:

- Node.js 20+
- Nim 2.2.x to build KoutenDB core. Install Nim: <https://nim-lang.org/install.html>. Nimble is included with the standard Nim installation.
- `libsodium` development headers, required by KoutenDB core. Install libsodium with your OS package manager or from <https://libsodium.org>.
- a C/C++ build toolchain for `node-gyp`

### Install From npm

Build KoutenDB core first:

```sh
git clone https://github.com/puffball1567/koutendb.git
cd koutendb
nimble install -y
nim c --app:lib -d:release --nimcache:/tmp/nimcache_kouten_capi -o:lib/libkoutendb.so src/koutendb_capi.nim
```

Install the package in your application with `KOUTENDB_CORE_DIR` set:

```sh
cd /path/to/your-app
KOUTENDB_CORE_DIR=/path/to/koutendb npm install koutendb
```

If you installed the package before building KoutenDB core, rebuild the native addon:

```sh
KOUTENDB_CORE_DIR=/path/to/koutendb npm rebuild koutendb
```

Run your app with the KoutenDB shared library on the dynamic loader path:

```sh
LD_LIBRARY_PATH=/path/to/koutendb/lib node app.mjs
```

On macOS, use `DYLD_LIBRARY_PATH`:

```sh
DYLD_LIBRARY_PATH=/path/to/koutendb/lib node app.mjs
```

### Smoke Demo

Clone this driver repository if you want to run the included demo:

```sh
git clone https://github.com/puffball1567/koutendb-js.git
cd koutendb-js
KOUTENDB_CORE_DIR=/path/to/koutendb npm install
KOUTENDB_CORE_DIR=/path/to/koutendb npm run build
LD_LIBRARY_PATH=/path/to/koutendb/lib node examples/embedded.mjs
```

For Bun compatibility:

```sh
LD_LIBRARY_PATH=/path/to/koutendb/lib bun examples/embedded.mjs
```

### Development From Source

For local driver development, keep the KoutenDB core repository next to this repository:

```text
oss/
  koutendb/
  koutendb-js/
```

Build the KoutenDB C ABI shared library first:

```sh
cd ../koutendb
nim c --app:lib -d:release --nimcache:/tmp/nimcache_kouten_capi -o:lib/libkoutendb.so src/koutendb_capi.nim
```

Then build this driver:

```sh
cd ../koutendb-js
KOUTENDB_CORE_DIR=../koutendb npm install
KOUTENDB_CORE_DIR=../koutendb npm run build
```

If the core repository is in a different location, set:

- `KOUTENDB_CORE_DIR`: KoutenDB repository path. The build expects `include/koutendb.h` and `lib/libkoutendb.so` below it.
- `KOUTENDB_LIB_DIR`: optional library directory override.
- `KOUTENDB_NATIVE_PATH`: optional runtime override for the built `.node` file.

At runtime, make sure the dynamic loader can find `libkoutendb.so`:

```sh
LD_LIBRARY_PATH=../koutendb/lib node examples/embedded.mjs
```

## Quick Start

```ts
import { KoutenDb } from "koutendb";

const db = KoutenDb.open(4);

try {
  const id = db.putJson("users/42/profile", {
    name: "Ada",
    role: "admin",
  });

  console.log(db.getString(id));

  const docId = db.putJsonVec(
    "docs/nim",
    {
      title: "KoutenDB rings",
      body: "KoutenDB stores explicit rings and vectors together.",
    },
    [1, 0, 0],
  );

  const encoded = db.getEncoded(id);
  console.log(encoded?.codec);

  const page = db.readRing("users/42/profile", {
    filter: { role: "admin" },
    selection: "{ name }",
    limit: 10,
  });

  const result = db.retrieve([1, 0, 0], {
    ring: "docs/nim",
    budget: 4,
  });

  console.log(docId, page, result.stats);
} finally {
  db.close();
}
```

## TLS

TLS requires a KoutenDB core built with `-d:ssl`. The shared library from
`scripts/build_capi.sh` is built with it; a library built without it fails a TLS
connect with `TLS support requires building KoutenDB with -d:ssl`.

To reach a server whose certificate is signed by a private CA — or is
self-signed — point at the certificate PEM. Verification stays on:

```ts
const db = KoutenDb.connect("127.0.0.1:17651", {
  username: "alice",
  password: "secret",
  tlsCaFile: "/path/to/server.crt",
});
```

`dangerouslyAcceptInvalidCerts: true` disables certificate verification. The
connection is then encrypted but unauthenticated and trivially impersonable, so
it is for local smoke tests only — never a production server. Prefer `tlsCaFile`
for self-signed certificates.

**Node caveat:** Node bundles its own OpenSSL, which can collide with the system
OpenSSL the core loads. TLS connections still fail closed when verification
fails, but the error *message* may be lost. The driver rewrites the empty
OpenSSL sentinel (`No error reported.`) into a hint that points at certificate
verification; the underlying failure is unchanged.

## API Coverage

Implemented in this driver:

- Embedded open: `KoutenDb.open(nodes)`
- Persistent embedded open: `KoutenDb.openDir(nodes, dir)`, `openDirWith(dir, options)` for strong durability / disk-backed reads
- TCP connect: `KoutenDb.connect(peers, options?)`
- Auth connect: username, password, auth token, secret key, galaxy
- TLS connect: `tls`, `tlsCaFile`, `tlsServerName`, `dangerouslyAcceptInvalidCerts`
- ABI version: `abiVersion()`
- Write: `put`, `putCodec`, `putJson`, `putNif`, `putBif`, `putVec`,
  `putVecCodec`, `putJsonVec`, `putNifVec`, `putBifVec`
- Read: `get`, `getEncoded`, `getString`, `batchGet`, `batchGetStrings`,
  `readRing`, `exists`
- Mutations: `update`, `updateCodec`, `updateJson`, `remove`
- Payload codecs: `PayloadCodec`, `EncodedPayload`
- ID helpers: `parseKoutenId`, `formatKoutenId`
- Typed errors: `KoutenDbError`, `isKoutenDbError`
- Selection query: `query`, `queryString`
- Vector retrieval: `retrieve`
- Atlas / map output: `atlas`
- Orbit helpers: `locate`, `now`, `advance`, `nextVisit`, `nextJoin`
- Metadata: `configureRing`, `setGalaxyDescription`, `setRingDescription`
- Metrics: `metrics`, `checkpointMetrics`
- Segment maintenance: `segmentStatus`, `planSegmentMaintenance`,
  `runSegmentMaintenance`, `segmentMaintenanceStatus`, `recoverSegmentMaintenance`
- Generation checkpoints: `createCheckpoint`, `checkpointStatus`,
  `listCheckpoints`, `cleanupCheckpoints`, `restoreCheckpoint`

Still pending:

- Native JavaScript transaction helpers
- Dump/import helpers
- Patch / list / count helpers (not yet exposed by C ABI v2)
- Stronger Bun CI coverage
- Browser / React Native support through a future Wasm package

## Verification

Run the Node.js verification path:

```sh
KOUTENDB_CORE_DIR=../koutendb npm run build
LD_LIBRARY_PATH=../koutendb/lib npm run test:node
```

Run the Bun compatibility path:

```sh
LD_LIBRARY_PATH=../koutendb/lib npm run test:bun
LD_LIBRARY_PATH=../koutendb/lib bun examples/embedded.mjs
```

Check package contents before publishing:

```sh
KOUTENDB_CORE_DIR=../koutendb LD_LIBRARY_PATH=../koutendb/lib npm pack --dry-run
```

Run the embedded demo:

```sh
LD_LIBRARY_PATH=../koutendb/lib node examples/embedded.mjs
```

## Notes on Binary Data

The JavaScript API accepts payloads as `string` or `Uint8Array`.

Vectors are passed as `Float32Array` or `number[]`. At the C ABI boundary this uses host-native `float32` arrays. KoutenDB's TCP wire protocol has its own canonical little-endian float32 vector representation.
