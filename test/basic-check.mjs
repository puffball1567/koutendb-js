import {
  abiVersion,
  formatKoutenId,
  isKoutenDbError,
  parseKoutenId,
  KoutenDb,
} from "../dist/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function runEmbeddedCheck(assert) {
  const db = KoutenDb.open(4);

  try {
    db.setGalaxyDescription("Node.js test galaxy");
    db.setRingDescription("docs/nim", "Nim and KoutenDB documents");
    db.configureRing("docs/nim", 60);

    const profileId = db.putJson("users/42/profile", {
      name: "Ada",
      role: "admin",
    });
    const docA = db.putJsonVec("docs/nim", {
      title: "nim database",
      lang: "nim",
    }, [1, 0, 0]);
    const docB = db.putVec("docs/js", "javascript driver", [0, 1, 0]);

    assert.equal(db.getString(profileId), '{"name":"Ada","role":"admin"}');
    const encodedProfile = db.getEncoded(profileId);
    assert.equal(encodedProfile.codec, "json");
    assert.equal(new TextDecoder().decode(encodedProfile.data), '{"name":"Ada","role":"admin"}');
    assert.deepEqual(parseKoutenId(formatKoutenId(profileId)), profileId);
    assert.deepEqual(db.batchGetStrings([profileId]), [
      '{"name":"Ada","role":"admin"}',
    ]);

    const selection = db.queryString(profileId, "{ name }");
    assert.match(selection, /Ada/);

    const page = db.readRing("users/42/profile", {
      filter: { role: "admin" },
      selection: "{ name }",
      limit: 1,
      rsort: "time",
    });
    assert.equal(page.count, 1);
    assert.equal(page.items.length, 1);
    assert.deepEqual(page.items[0].payload, { name: "Ada" });
    assert.equal(page.sort, "time");
    assert.equal(page.sortDirection, "desc");

    const bifId = db.putBifVec("artifacts/bif", new Uint8Array([1, 2, 3, 4]), [0, 0, 1]);
    const encodedBif = db.getEncoded(bifId);
    assert.equal(encodedBif.codec, "bif");
    assert.deepEqual([...encodedBif.data], [1, 2, 3, 4]);
    const bifPage = db.readRing("artifacts/bif", { limit: 1 });
    assert.equal(bifPage.count, 1);
    assert.equal(bifPage.items[0].codec, "bif");
    assert.equal(bifPage.items[0].encoding, "base64");

    const retrieved = db.retrieve([1, 0, 0], {
      ring: "docs/nim",
      budget: 4,
    });
    assert.ok(retrieved.hits.length >= 1);
    assert.ok(retrieved.stats.scanned >= 1);
    assert.ok(retrieved.stats.candidateReduction >= 0);

    const atlas = db.atlas(undefined, 4);
    assert.equal(typeof atlas, "object");

    const node = db.locate(docA);
    assert.equal(Number.isInteger(node), true);
    assert.ok(db.nextVisit(docA, node) >= db.now());
    assert.ok(db.nextJoin(docA, docB) >= -1);

    db.advance(1);
    assert.ok(db.now() >= 1);
  } finally {
    db.close();
  }
}

export function runApiCheck(assert) {
  const id = parseKoutenId("1:2:3:4.5");
  assert.deepEqual(id, {
    parent: 1n,
    epoch: 2,
    seq: 3,
    tWrite: 4.5,
  });
  assert.equal(formatKoutenId(id), "1:2:3:4.5");

  assert.throws(
    () => parseKoutenId("1:2:3"),
    (error) => isKoutenDbError(error) && error.kind === "invalid_id",
  );

  assert.equal(abiVersion(), 2);

  const db = KoutenDb.open(2);
  db.close();

  assert.throws(
    () => db.put("closed/test", "payload"),
    (error) => isKoutenDbError(error) && error.kind === "closed",
  );
}

export function runV012Check(assert) {
  const root = mkdtempSync(join(tmpdir(), "koutendb-js-v012-"));
  const checkpoints = `${root}-checkpoints`;
  const restored = `${root}-restored`;
  const db = KoutenDb.openDirWith(root, {
    nodes: 1,
    strongDurability: true,
    diskBacked: true,
  });
  let id;
  try {
    id = db.put("docs/mutable", "before");
    assert.equal(db.exists(id), true);
    db.updateJson(id, { state: "after" });
    assert.equal(db.getEncoded(id).codec, "json");
    assert.match(db.metrics("prometheus"), /koutendb_items/);

    const policy = {
      staleRatio: 0,
      minStaleRecords: 0,
      maxRings: 1,
      maxBytes: 1024 * 1024,
      maxElapsedMs: 1000,
    };
    assert.equal(typeof db.planSegmentMaintenance(policy), "object");
    assert.equal(typeof db.runSegmentMaintenance(policy), "object");
    assert.equal(typeof db.segmentStatus(0, 0), "object");
    assert.equal(db.recoverSegmentMaintenance(), false);
    assert.equal(db.createCheckpoint(checkpoints, "js-1").verified, true);
    assert.equal(KoutenDb.checkpointStatus(join(checkpoints, "js-1")).reason, "verified");
    assert.equal(KoutenDb.listCheckpoints(checkpoints).count, 1);
    assert.match(KoutenDb.checkpointMetrics(checkpoints, "openmetrics"), /# EOF/);
  } finally {
    db.close();
  }

  try {
    KoutenDb.restoreCheckpoint(join(checkpoints, "js-1"), restored);
    const restoredDb = KoutenDb.openDirWith(restored, {
      nodes: 1,
      strongDurability: true,
      diskBacked: true,
    });
    try {
      assert.equal(restoredDb.exists(id), true);
      restoredDb.remove(id);
      assert.equal(restoredDb.exists(id), false);
    } finally {
      restoredDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(checkpoints, { recursive: true, force: true });
    rmSync(restored, { recursive: true, force: true });
  }
}
