"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const services = require("./photo-services");

const FOUR_DAYS = 4 * 24 * 60 * 60_000;
const DELETE_SWITCH = "PHOTO_RETENTION_DELETE_ENABLED";
const JOBS = "photo_retention_new_jobs";
const NEW_UPLOAD_ID = /^photo-wall-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function validAsset(asset, type) {
  return /^[a-f0-9]{32}$/.test(asset.asset_id || "") &&
    asset.resource_type === type && asset.type === "authenticated" && NEW_UPLOAD_ID.test(asset.public_id) &&
    Number.isSafeInteger(asset.version) && asset.version > 0 &&
    Number.isSafeInteger(asset.bytes) && asset.bytes > 0 &&
    Number.isFinite(Date.parse(asset.created_at)) && /^[a-z0-9]+$/i.test(asset.format || "");
}

function sameOriginal(current, original) {
  return current?.asset_id === original.asset_id && current.resource_type === original.resource_type &&
    current.public_id === original.public_id && current.version === original.version &&
    current.type === original.type && current.bytes === original.bytes && current.tags?.includes(services.RETENTION_TAG);
}

async function currentOriginal(cloud, asset) {
  const current = await services.cloudAsset(cloud, asset.asset_id);
  if (!current) return null;
  if (!validAsset(current, asset.resource_type) || !Array.isArray(current.tags)) {
    throw new Error("Cloudinary did not return complete source metadata");
  }
  return current;
}

function originalStillMatches(current, asset) {
  if (sameOriginal(current, asset)) return true;
  if (current?.version > asset.version) return false;
  throw new Error("Cloudinary original is missing or no longer matches");
}

async function discover(db, cloud, type) {
  const scan = db.doc("photo_retention_scan/new-" + type);
  const checkpoint = (await scan.get()).data()?.cursor;
  let page;
  try {
    page = await services.listTagged(cloud, type, checkpoint);
  } catch (error) {
    if (!checkpoint || error.status !== 400) throw error;
    page = await services.listTagged(cloud, type);
  }

  const jobs = db.collection(JOBS);
  const assets = page.resources.filter(asset => validAsset(asset, type));
  if (assets.length !== page.resources.length) {
    logger.error("Photo Wall tagged assets had incomplete Cloudinary metadata", {
      type, skipped: page.resources.length - assets.length,
    });
  }
  const refs = assets.map(asset => jobs.doc(asset.asset_id + "-" + asset.version));
  const existing = refs.length ? await db.getAll(...refs) : [];
  const batch = db.batch();
  for (const [i, asset] of assets.entries()) {
    if (existing[i].exists) continue;
    // A replaced asset gets four full days from the current Cloudinary version.
    const sourceTime = Math.max(Date.parse(asset.created_at), asset.version * 1000);
    batch.create(refs[i], {
      asset,
      state: "pending",
      deleteAfter: Timestamp.fromMillis(sourceTime + FOUR_DAYS),
      nextAttemptAt: Timestamp.now(),
      failures: 0,
    });
  }
  batch.set(scan, { cursor: page.next_cursor || null });
  await batch.commit();
}

function finish(ref, state) {
  return ref.update({
    state, nextAttemptAt: FieldValue.delete(), completedAt: Timestamp.now(),
    failures: 0, lastError: FieldValue.delete(),
  });
}

async function processJob(doc, cloud, drive) {
  const job = doc.data();
  const { asset, deleteAfter } = job;
  let { driveId, sha256 } = job;
  if (!asset || !validAsset(asset, asset.resource_type)) return finish(doc.ref, "out-of-scope");

  if (!sha256) {
    const current = await currentOriginal(cloud, asset);
    if (!originalStillMatches(current, asset)) return finish(doc.ref, "source-changed");
    const original = await services.fetchOriginal(cloud, asset, true);
    if (!originalStillMatches(await currentOriginal(cloud, asset), asset)) {
      return finish(doc.ref, "source-changed");
    }
    if (!driveId) {
      driveId = await services.newDriveId(drive);
      // Persist the ID before uploading. A timeout or restart reuses the same ID.
      await doc.ref.update({ driveId });
    }
    await services.uploadMaster(drive, driveId, asset, original.bytes);
    await services.verifyMaster(drive, driveId, asset, original.sha256);
    sha256 = original.sha256;
    await doc.ref.update({
      sha256, state: "verified", verifiedAt: Timestamp.now(),
      failures: 0, lastError: FieldValue.delete(), nextAttemptAt: deleteAfter,
    });
  }

  if (deleteAfter.toMillis() > Date.now()) return;
  if (process.env[DELETE_SWITCH] !== "true") {
    await doc.ref.update({ nextAttemptAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60_000) });
    return;
  }

  const current = await currentOriginal(cloud, asset);
  if (!current && job.state === "deleting") {
    await services.verifyMaster(drive, driveId, asset, sha256);
    return finish(doc.ref, "deleted");
  }
  if (!originalStillMatches(current, asset)) return finish(doc.ref, "source-changed");

  const source = await services.fetchOriginal(cloud, asset, false);
  if (source.sha256 !== sha256) throw new Error("Cloudinary source bytes changed since backup");
  await services.checkFolder(drive);
  await services.verifyMaster(drive, driveId, asset, sha256);
  if (!originalStillMatches(await currentOriginal(cloud, asset), asset)) {
    return finish(doc.ref, "source-changed");
  }
  await doc.ref.update({ state: "deleting", deleteRequestedAt: Timestamp.now() });
  await services.destroyAsset(cloud, asset);
  await finish(doc.ref, "deleted");
}

function safeError(error) {
  // Network errors can embed a signed Cloudinary URL or credential-bearing request.
  if (error instanceof TypeError || error.name === "TimeoutError" || error.name === "AbortError") return error.name;
  return error.code ? String(error.code) : String(error.message).split("\n")[0].slice(0, 180);
}

exports.retainPhotoWallMedia = onSchedule({
  schedule: "every 15 minutes",
  region: "us-central1",
  timeoutSeconds: 540,
  memory: "1GiB",
  maxInstances: 1,
  concurrency: 1,
}, async () => {
  const started = Date.now();
  const db = getFirestore();
  const cloud = await services.cloudCredentials();
  const inventoryErrors = [];
  for (const type of ["image", "video"]) {
    try {
      await discover(db, cloud, type);
    } catch (error) {
      inventoryErrors.push(type);
      logger.error("Photo Wall inventory failed", { type, error: safeError(error) });
    }
  }

  if (inventoryErrors.length === 2) throw new Error("Photo Wall image and video inventory failed");

  const jobs = await db.collection(JOBS)
    .where("nextAttemptAt", "<=", Timestamp.now()).orderBy("nextAttemptAt").limit(30).get();
  if (jobs.empty) return;
  const drive = await services.driveCredentials();
  await services.checkFolder(drive);
  for (const job of jobs.docs) {
    // Each job may require several network requests. Leave unstarted work due.
    if (Date.now() - started > 300_000) break;
    try {
      await processJob(job, cloud, drive);
    } catch (error) {
      const failures = (job.data().failures || 0) + 1;
      const delay = Math.min(24 * 60, 15 * 2 ** Math.min(failures - 1, 7));
      const reason = safeError(error);
      await job.ref.update({
        failures, lastError: reason,
        nextAttemptAt: Timestamp.fromMillis(Date.now() + delay * 60_000),
      });
      logger.error("Photo Wall retention will retry", { job: job.id, failures, reason });
    }
  }
});
