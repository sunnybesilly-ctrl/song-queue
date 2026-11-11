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

Object.assign(exports, require("./photo-access"), require("./photo-retention"));
