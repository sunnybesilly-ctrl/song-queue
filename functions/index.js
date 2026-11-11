"use strict";
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("node:crypto");
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
 return db.runTransaction(async (tx) => {
  const [state, entry] = await Promise.all([tx.get(stateRef),tx.get(codeRef)]);
  const now = Date.now();
  if (!state.exists || !state.data().active) throw new HttpsError("failed-precondition","Gallery is closed.");
  if (!entry.exists || entry.data().used || entry.data().eventId !== state.data().eventId ||
      entry.data().expiresAt.toMillis() <= now)
   throw new HttpsError("permission-denied","Code is invalid, expired, or already used.");
  const expiry = Timestamp.fromMillis(now + 6*60*60*1000);
  tx.update(codeRef,{ used:true, redeemedAt:NOW(), redeemedBy:req.auth.uid });
  const walletRef = db.doc("guest_wallets/" + req.auth.uid);
  const existingWallet = await tx.get(walletRef);
  const sameEventWallet = existingWallet.exists && existingWallet.data().eventId === state.data().eventId;
  tx.set(accessRef,{ eventId:state.data().eventId, expiresAt:expiry, issuedAt:NOW() });
  if (!sameEventWallet) tx.set(walletRef,{eventId:state.data().eventId,balance:777,initialCredits:777,spent:0,updatedAt:NOW()});
  return { ok:true, expiresAt:expiry.toMillis() };
 });
});


const GIFT_COSTS = Object.freeze({spark:7, comet:77, galaxy:177, supernova:333});
exports.sendPhotoGift = onCall(OPT, async req => {
 requireUser(req);
 const kind = String((req.data && req.data.kind) || "");
 const mediaId = String((req.data && req.data.mediaId) || "");
 const name = String((req.data && req.data.name) || "Guest").trim().slice(0,24) || "Guest";
 if (!Object.prototype.hasOwnProperty.call(GIFT_COSTS,kind) || !/^[a-zA-Z0-9_/-]{1,200}$/.test(mediaId))
   throw new HttpsError("invalid-argument","Choose an available gift and photo or video.");
 const cost = GIFT_COSTS[kind];
 const walletRef = db.doc("guest_wallets/"+req.auth.uid);
 const accessRef = db.doc("gallery_access/"+req.auth.uid);
 const mediaRef = db.doc("media_queue/"+mediaId);
 const giftRef = db.collection("photo_gifts").doc();
 return db.runTransaction(async tx => {
   const snapshots = await Promise.all([tx.get(stateRef),tx.get(accessRef),tx.get(walletRef),tx.get(mediaRef)]);
   const s=snapshots[0].data(),a=snapshots[1].data(),w=snapshots[2].data(),m=snapshots[3].data();
   if (!s || !s.active || !a || a.eventId!==s.eventId || !a.expiresAt || a.expiresAt.toMillis()<=Date.now())
     throw new HttpsError("permission-denied","Your event pass has expired.");
   if (!m || m.eventId!==s.eventId) throw new HttpsError("failed-precondition","This memory is not in the current event.");
   if (!w || w.eventId!==s.eventId) throw new HttpsError("failed-precondition","Your wallet needs a new event pass.");
   if (!Number.isInteger(w.balance)||w.balance<cost) throw new HttpsError("resource-exhausted","Not enough credits for this gift.");
   tx.update(walletRef,{balance:FieldValue.increment(-cost),spent:FieldValue.increment(cost),updatedAt:NOW()});
   tx.create(giftRef,{eventId:s.eventId,mediaId,uid:req.auth.uid,name,kind,cost,t:FieldValue.serverTimestamp()});
   return {ok:true,balance:w.balance-cost,giftId:giftRef.id};
 });
});

Object.assign(exports, require("./photo-access"), require("./photo-retention"));
