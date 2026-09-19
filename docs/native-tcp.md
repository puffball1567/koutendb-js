# Native TCP (Development)

This branch adds a TypeScript client using Node's net/tls APIs. TCP-only users
need neither a native addon, Nim, a C++ compiler nor libkoutendb. The published
package version has not yet been advanced for this feature.

```sh
npm install
npm run build:ts
```

```ts
import { TcpClient, formatTcpId, parseTcpId } from 'koutendb/tcp';

const db = await TcpClient.connect(['127.0.0.1:17301']);
try {
  const id = await db.putJson('articles', { title: 'Hello' });
  const savedId = formatTcpId(id);
  console.log(await db.getJson(parseTcpId(savedId)));
} finally {
  db.close();
}
```

The root import also exports TcpClient without loading the addon. Parent IDs are
bigint: use `formatTcpId`, not a lossy Number conversion or direct JSON.stringify.

Authentication/TLS options:

```ts
const db = await TcpClient.connect(['db.example.com:17301'], {
  username: 'app',
  password: process.env.KOUTENDB_PASSWORD,
  secretKey: process.env.KOUTENDB_SECRET_KEY,
  galaxy: 'articles',
  tls: true,
  tlsCaFile: 'ca.pem',
  tlsServerName: 'db.example.com',
  timeout: 3,
  readTimeout: 5,
  writeTimeout: 5,
});
```

Undefined optional values retain their defaults. An `authToken` can replace
username/password. Public exception classes
are exported from `koutendb/tcp`, including `IndeterminateWriteException`.

Operations on one client are serialized to preserve stream boundaries.
Use separate clients for concurrency. `close()` is terminal.
Shared-secret encryption uses the pure-JS noble libraries, not libkoutendb.

## Existing Embedded Applications

KoutenDb and its methods remain available. Installation no longer implicitly
compiles the native addon. Embedded users opt in explicitly:

```sh
KOUTENDB_BUILD_NATIVE=1 KOUTENDB_CORE_DIR=/path/to/koutendb npm install koutendb
# Or after installation:
KOUTENDB_BUILD_NATIVE=1 KOUTENDB_CORE_DIR=/path/to/koutendb npm rebuild koutendb
```

From this checkout, `KOUTENDB_CORE_DIR=/path/to/koutendb npm run build:native`
also builds it. Keep the shared library on the loader path for embedded use.
Bun's embedded compatibility checks remain; native TCP initially targets Node.js.

```sh
npm run test:tcp
bash ../koutendb/scripts/native_driver_conformance.sh node "$PWD/test/tcp-adapter.mjs"
```

## Server Setup

Run a TLS-enabled `koutend` build. For a local-only first test:

```sh
koutend --id=0 --peers=127.0.0.1:17301 --data=./kouten-data
```

Keep plaintext connections on localhost or an isolated, trusted private network.
A Docker network is not a substitute for access control. Use verified TLS when
traffic crosses a trust boundary. For password authentication, start the server
with `--user=app --password=...`; prefer the server's configuration/secret
management facilities for production rather than putting secrets in shell history.

Native TCP implements wire version 1: WIREVER, CODECMETA, PUTR, GETID, QRYID,
HEALTH, authentication and bounded FWD handling. It is not a replacement for
every embedded/admin API. It uses server-provided IDs and does not calculate
ring placement or orbit ownership. Peer ordering must match the server cluster
configuration, because explicit redirect owners are node indexes.

## Safety Contract

- Every new connection authenticates, checks WIREVER and enables codec metadata
  before sending application requests. Unsupported versions fail closed.
- Headers are bounded to 8 KiB; payload frames default to at most 64 MiB.
  The configurable payload cap cannot exceed that hard limit.
- Partial reads/writes are handled. A read deadline covers the complete response,
  not a fresh timeout for every fragment.
- A read may reconnect and retry once. An unknown write outcome is never retried.
- After a broken or malformed response the connection is discarded.
- Redirects default to eight hops (configurable up to 32), and an out-of-range
  owner is rejected. Missing values do not trigger a scan of every server.
- CA and hostname verification are enabled by default. TLS 1.2 is the minimum.
  Insecure verification bypass is explicitly development-only.
- Password/token and shared-secret challenge authentication are supported.
  Library transport errors do not include raw server error text or credentials.

A successful send is not proof that a write committed. If the connection breaks
or the reply is malformed after a PUT may have been sent, handle an
**indeterminate write** separately from a definite server rejection. Do not
blindly repeat the insert or assume a fallback database is now authoritative.
Reconcile at the application level until a server-side idempotency contract is
available.

The pre-v1 protocol is version-checked, not promised compatible with future
versions. Authentication errors, protocol errors, connection failures, timeouts,
server rejections and indeterminate writes are distinguishable.

## Verification

The adapter in this repository runs against KoutenDB's language-independent
`scripts/native_driver_conformance.py` suite, pinned in CI to core commit
`e36b424bcfd9cd0dfa24ae121f4b4dd028b0eaac`.

The shared matrix covers 27 scripted cases: fragmented/empty/Unicode/binary
responses, missing values, projections, invalid lengths/codecs/headers, redacted
server errors, version mismatches, connection loss, partial-response retry,
timeouts, backpressure, redirects and poisoned-connection disposal.
Six real-server configurations cover plaintext, password, token, shared-secret,
TLS and TLS plus shared-secret; these include 1 MiB round trips, invalid
credentials, untrusted certificates and hostname mismatch.

These are bounded correctness/integration checks, not endurance or throughput
benchmarks. Linux results are checked locally; Linux/macOS CI must pass before
release. Existing embedded regressions remain separate from native TCP checks.
