"use strict";
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { onDocumentDeleted } = require("firebase-functions/v2/firestore");
admin.initializeApp();
const db = admin.firestore();
const { Timestamp, FieldValue } = admin.firestore;
const OPT = { region: "us-central1", enforceAppCheck: false, maxInstances: 10 };
const NOW = () => Timestamp.now();
const stateRef = db.doc("gallery_state/current");
function requireAdmin(req) {
 const t = req.auth && req.auth.token;
 if (!t || t.email !== "sunnybesilly@gmail.com" || t.email_verified !== true)
  throw new HttpsError("permission-denied", "Verified admin sign-in required.");
}
function requireUser(req) {
 if (!req.auth || !req.auth.uid) throw new HttpsError("unauthenticated", "Guest sign-in required.");
}
function codeHash(code) { return crypto.createHash("sha256").update(code).digest("hex"); }
function randomCode() { return crypto.randomInt(10000000, 100000000).toString(); }
exports.startGalleryEvent = onCall(OPT, async (req) => {
 requireAdmin(req);
 const id = crypto.randomUUID();
 await stateRef.set({ eventId:id, active:true, startedAt:FieldValue.serverTimestamp(), updatedAt:FieldValue.serverTimestamp() });
 return { eventId:id };
});
exports.closeGalleryEvent = onCall(OPT, async (req) => {
 requireAdmin(req);
 await stateRef.set({ eventId:crypto.randomUUID(), active:false, updatedAt:FieldValue.serverTimestamp() });
 return { ok:true };
});
exports.createGalleryCode = onCall(OPT, async (req) => {
 requireAdmin(req);
 const state = await stateRef.get();
 if (!state.exists || !state.data().active) throw new HttpsError("failed-precondition","Start an event first.");
 const code = randomCode();
 const ref = db.doc("gallery_codes/" + codeHash(code));
 const expiresAt = Timestamp.fromMillis(Date.now() + 5*60*1000);
 await ref.create({ eventId:state.data().eventId, createdAt:NOW(), expiresAt, used:false });
 return { code, expiresAt:expiresAt.toMillis() };
});
exports.redeemGalleryCode = onCall(OPT, async (req) => {
 requireUser(req);
 const code = String(req.data && req.data.code || "").trim();
 if (!/^[0-9]{8}$/.test(code)) throw new HttpsError("invalid-argument", "Enter the 8-digit code.");
 const codeRef = db.doc("gallery_codes/" + codeHash(code));
 const accessRef = db.doc("gallery_access/" + req.auth.uid);
 const caller = req.rawRequest.ip || "unknown";
 const ipRef = db.doc("gallery_attempts/ip-" + codeHash(caller));
 const uidRef = db.doc("gallery_attempts/uid-" + req.auth.uid);
 const result = await db.runTransaction(async (tx) => {
  const [state, entry, pass, ip, uid] = await Promise.all(
   [stateRef, codeRef, accessRef, ipRef, uidRef].map(ref => tx.get(ref))
  );
  const now = Date.now();
  if (!state.exists || !state.data().active) throw new HttpsError("failed-precondition","Gallery is closed.");
  const current = state.data();
  const invite = entry.data();
  const access = pass.data();
  // A lost response can be retried by the same guest without extending the pass.
  if (invite?.redeemedBy === req.auth.uid && invite.eventId === current.eventId &&
      access?.eventId === current.eventId && access.expiresAt.toMillis() > now) {
   return { ok:true, expiresAt:access.expiresAt.toMillis() };
  }
  const attempts = [uid, ip].map(snap => {
   const data = snap.data();
   return data?.expiresAt.toMillis() > now ? data :
    { count:0, expiresAt:Timestamp.fromMillis(now + 5*60*1000) };
  });
  if (attempts[0].count >= 10 || attempts[1].count >= 300) return { limited:true };
  [uidRef, ipRef].forEach((ref, i) => tx.set(ref, {
   ...attempts[i], count:attempts[i].count + 1
  }));
  if (!invite || invite.used || invite.eventId !== current.eventId || invite.expiresAt.toMillis() <= now)
   return { invalid:true };
  const expiry = Timestamp.fromMillis(now + 6*60*60*1000);
  tx.update(codeRef,{ used:true, redeemedAt:NOW(), redeemedBy:req.auth.uid });
  tx.set(accessRef,{ eventId:state.data().eventId, expiresAt:expiry, issuedAt:NOW() });
  return { ok:true, expiresAt:expiry.toMillis() };
 });
 if (result.limited) throw new HttpsError("resource-exhausted", "Too many attempts. Try again in a few minutes.");
 if (result.invalid) throw new HttpsError("permission-denied", "Code is invalid, expired, or already used.");
 return result;
});

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MIME = /^(?:image\/(?:jpeg|png|gif|webp|avif)|video\/(?:mp4|quicktime|webm|ogg))$/;
const MAX_BYTES = 75 * 1024 * 1024;
const bucket = () => admin.storage().bucket("dj-photo-wall.firebasestorage.app");

exports.publishGalleryMedia = onCall({ ...OPT, timeoutSeconds: 180 }, async (req) => {
 requireUser(req);
 const { eventId, id, name, trimStart = 0, trimEnd = 0 } = req.data || {};
 if (typeof eventId !== "string" || !UUID.test(eventId) ||
     typeof id !== "string" || !UUID.test(id) ||
     typeof name !== "string" || !name.trim() || name.length > 24 ||
     ![trimStart, trimEnd].every(value => Number.isFinite(value) && value >= 0 && value <= 86400) ||
     (trimEnd !== 0 && trimEnd <= trimStart)) {
  throw new HttpsError("invalid-argument", "Invalid media details.");
 }
 const uid = req.auth.uid;
 const path = `${eventId}/${uid}/${id}`;
 const storagePath = "gallery-media/" + path;
 const mediaRef = db.doc("media_queue/" + id);
 const checkExisting = existing => {
  if (existing.data().storagePath !== storagePath)
   throw new HttpsError("already-exists", "This media ID is already in use.");
  return { id };
 };
 const existing = await mediaRef.get();
 if (existing.exists) return checkExisting(existing);
 const checkState = state => {
  if (state.data()?.active !== true || state.data()?.eventId !== eventId)
   throw new HttpsError("failed-precondition", "This event is closed. Ask the DJ about the current event.");
 };
 checkState(await stateRef.get());
 const incoming = bucket().file("gallery-incoming/" + path);
 const destination = bucket().file(storagePath);
 const [metadata] = await incoming.getMetadata().catch(err => {
  if (err.code === 404) throw new HttpsError("not-found", "Upload the file before posting it.");
  throw err;
 });
 if (!MIME.test(metadata.contentType || "") || !(Number(metadata.size) > 0 && Number(metadata.size) <= MAX_BYTES))
  throw new HttpsError("invalid-argument", "Unsupported photo or video.");
 // Stream the bytes into a new object so upload metadata and download tokens are never copied.
 try {
  await pipeline(incoming.createReadStream(), destination.createWriteStream({
   metadata: { contentType: metadata.contentType, cacheControl: "private, no-store" },
   preconditionOpts: { ifGenerationMatch: 0 }
  }));
 } catch (err) {
  if (Number(err.code) !== 412) throw err;
 }
 const result = await db.runTransaction(async tx => {
  const [state, media] = await Promise.all([tx.get(stateRef), tx.get(mediaRef)]);
  if (media.exists) return checkExisting(media);
  checkState(state);
  tx.create(mediaRef, {
   name: name.trim(), uid, eventId, storagePath, v: 3,
   type: metadata.contentType.startsWith("video/") ? "video" : "image",
   timestamp: FieldValue.serverTimestamp(), likes: 0, trimStart, trimEnd
  });
  return { id };
 });
 try { await incoming.delete({ ignoreNotFound: true }); }
 catch (err) { console.warn("Temporary gallery upload cleanup failed", err.code); }
 return result;
});

exports.likeGalleryMedia = onCall(OPT, async req => {
 requireUser(req);
 const id = req.data?.id;
 if (typeof id !== "string" || !UUID.test(id))
  throw new HttpsError("invalid-argument", "Invalid media.");
 const uid = req.auth.uid;
 const media = db.doc("media_queue/" + id);
 const receipt = db.doc("gallery_likes/" + id + "/guests/" + uid);
 return db.runTransaction(async tx => {
  const [state, pass, item, liked] = await Promise.all(
   [stateRef, db.doc("gallery_access/" + uid), media, receipt].map(ref => tx.get(ref))
  );
  const current = state.data(), access = pass.data(), data = item.data();
  if (current?.active !== true || !access || access.eventId !== current.eventId ||
      access.expiresAt.toMillis() <= Date.now() || data?.v !== 3 || data.eventId !== current.eventId)
   throw new HttpsError("permission-denied", "A current gallery pass is required.");
  if (liked.exists) return { likes: data.likes };
  tx.create(receipt, { expiresAt: access.expiresAt });
  tx.update(media, { likes: FieldValue.increment(1) });
  return { likes: data.likes + 1 };
 });
});

exports.deleteGalleryMediaFile = onDocumentDeleted({
 document: "media_queue/{id}", region: OPT.region, retry: true
}, async event => {
 const data = event.data?.data();
 if (data?.v === 3 && UUID.test(event.params.id) && UUID.test(data.eventId) &&
     /^[^/]+$/.test(data.uid) &&
     data.storagePath === `gallery-media/${data.eventId}/${data.uid}/${event.params.id}`) {
  await bucket().file(data.storagePath).delete({ ignoreNotFound: true });
 }
});
