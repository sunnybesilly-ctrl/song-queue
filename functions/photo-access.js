"use strict";

const crypto = require("node:crypto");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { CLOUD, TAG, RETENTION_TAG, cloudCredentials, signedParams, deliverySignature } = require("./photo-services");

const OPTIONS = { region: "us-central1", maxInstances: 10 };
const ADMIN = "sunnybesilly@gmail.com";
const PHOTO_ID = /^photo-wall-[a-f0-9-]{36}$/;
const DELIVERY = "https://res.cloudinary.com/" + CLOUD + "/";
const API = "https://api.cloudinary.com/v1_1/" + CLOUD + "/";
const PREVIEW = {
  image: { format: "jpg", transformation: "c_limit,w_2048,h_2048,q_auto" },
  video: { format: "mp4", transformation: "c_limit,w_1920,h_1080,q_auto,vc_h264,ac_aac" },
};

function isAdmin(req) {
  return req.auth?.token.email === ADMIN && req.auth.token.email_verified === true;
}

exports.createPhotoWallUpload = onCall(OPTIONS, async () => {
  const db = getFirestore();
  const current = (await db.doc("gallery_state/current").get()).data();
  const publicId = "photo-wall-" + crypto.randomUUID();
  const credentials = await cloudCredentials();
  const expiresAt = Timestamp.fromMillis(Date.now() + 60 * 60_000);
  const eventId = current?.active ? current.eventId : null;
  await db.doc("photo_wall_uploads/" + publicId).create({ eventId, expiresAt });
  return {
    eventId,
    params: signedParams(credentials, {
      public_id: publicId, tags: [TAG, RETENTION_TAG].join(","), type: "authenticated", overwrite: "false",
    }),
  };
});

function timedDownload(credentials, media, expiry, preview, profile = PREVIEW[media.type]) {
  const settings = preview ? profile : { attachment: "true" };
  const params = signedParams(credentials, {
    public_id: media.publicId,
    type: "authenticated",
    expires_at: expiry,
    ...settings,
  });
  return API + media.type + "/download?" + new URLSearchParams(params);
}

exports.getGuestPhotoWallMedia = onCall(OPTIONS, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Guest sign-in required.");
  const ids = req.data?.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 ||
      ids.some(id => typeof id !== "string" || !PHOTO_ID.test(id))) {
    throw new HttpsError("invalid-argument", "Invalid media request.");
  }

  const db = getFirestore();
  const stateRef = db.doc("gallery_state/current");
  const accessRef = db.doc("gallery_access/" + req.auth.uid);
  const snapshots = await db.getAll(stateRef, accessRef, ...ids.map(id => db.doc("media_queue/" + id)));
  const [stateDoc, accessDoc, ...mediaDocs] = snapshots;
  const state = stateDoc.data();
  const access = accessDoc.data();
  const expiry = Math.floor((access?.expiresAt?.toMillis() || 0) / 1000);
  if (!state?.active || !access || access.eventId !== state.eventId || expiry <= Date.now() / 1000) {
    throw new HttpsError("permission-denied", "Your gallery pass has expired.");
  }
  const credentials = await cloudCredentials();
  return {
    media: mediaDocs.flatMap(doc => {
      const media = doc.data();
      if (!media || media.eventId !== state.eventId || media.publicId !== doc.id || media.v !== 3 ||
          !Object.hasOwn(PREVIEW, media.type)) return [];
      return [{
        id: doc.id,
        preview: timedDownload(credentials, media, expiry, true),
        download: timedDownload(credentials, media, expiry, false),
      }];
    }),
  };
});

exports.signAdminPhotoWallUrls = onCall(OPTIONS, async req => {
  if (!isAdmin(req)) throw new HttpsError("permission-denied", "Verified admin sign-in required.");
  const urls = req.data?.urls;
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > 100) {
    throw new HttpsError("invalid-argument", "Invalid media request.");
  }
  const { secret } = await cloudCredentials();
  return {
    urls: urls.map(url => {
      if (typeof url !== "string" || url.length > 600 || !url.startsWith(DELIVERY)) return null;
      const match = /^(image|video)\/authenticated\/((?:[a-z0-9_.,:-]+\/)*v\d+\/photo-wall-[a-f0-9-]{36}\.[a-z0-9]+)$/i
        .exec(url.slice(DELIVERY.length));
      if (!match) return null;
      const [, type, tail] = match;
      return DELIVERY + type + "/authenticated/s--" + deliverySignature(tail.replace(/(^|\/)v\d+\//, "$1"), secret) + "--/" + tail;
    }),
  };
});

const projectorState = () => getFirestore().doc("projector_pairing/current");
exports.manageProjector = onCall(OPTIONS, async req => {
  if (!isAdmin(req)) throw new HttpsError("permission-denied", "Admin required.");
  const ref = projectorState();
  if (req.data?.action === "disconnect") {
    await ref.delete();
    return { disconnected: true };
  }
  if (req.data?.action !== "generate") throw new HttpsError("invalid-argument", "Unknown action.");
  return getFirestore().runTransaction(async tx => {
    const current = (await tx.get(ref)).data();
    if (current?.code) return {code:current.code};
    const code = crypto.randomInt(10000000,100000000).toString();
    tx.set(ref,{code, attempts:0, blockedUntil:0, uid:current?.uid || null});
    return {code};
  });
});
exports.pairProjector = onCall(OPTIONS, async req => {
  if (req.auth?.token.firebase?.sign_in_provider !== "anonymous") throw new HttpsError("permission-denied","Projector sign-in required.");
  const code = req.data?.code;
  if (typeof code !== "string" || !/^\d{8}$/.test(code)) throw new HttpsError("invalid-argument","Enter eight digits.");
  const ref = projectorState();
  const ok = await getFirestore().runTransaction(async tx => {
    const state = (await tx.get(ref)).data();
    if (!state?.code || state.blockedUntil > Date.now()) return false;
    if (code !== state.code) {
      const attempts = state.attempts + 1;
      tx.update(ref, attempts >= 8 ? {attempts:0, blockedUntil:Date.now()+300000} : {attempts});
      return false;
    }
    tx.update(ref,{uid:req.auth.uid,attempts:0,blockedUntil:0});
    return true;
  });
  if (!ok) throw new HttpsError("permission-denied","Check the code. After repeated attempts, try again in five minutes.");
  return {paired:true};
});
exports.projectorReel = onCall(OPTIONS, async req => {
  if (!req.auth || (await projectorState().get()).data()?.uid !== req.auth.uid)
    throw new HttpsError("permission-denied","Pair this projector.");
  const db = getFirestore();
  const event = (await db.doc("gallery_state/current").get()).data();
  if (!event?.active || !event.eventId) return {media:[]};
  const rows = await db.collection("media_queue").where("eventId","==",event.eventId).get();
  const items = [];
  for (const doc of rows.docs) {
    const m = doc.data();
    if (m.rotationPaused || typeof m.url !== "string") continue;
    const cloudPath = m.url.startsWith(DELIVERY) ? m.url.slice(DELIVERY.length) : "";
    const type = /^(video|image)\//.exec(cloudPath)?.[1] || /^(video|image)(?:\/|$)/i.exec(m.type || "")?.[1]?.toLowerCase()
      || (/\.(mp4|mov|m4v|webm|3gp)(?:[?#]|$)/i.test(m.url) ? "video" : "image");
    const publicId = PHOTO_ID.test(m.publicId) ? m.publicId : cloudPath.match(/\/(photo-wall-[a-f0-9-]{36})(?:\.[a-z0-9]+)?(?:[?#]|$)/i)?.[1];
    items.push({...m, type, publicId, key:doc.id, cloudPath});
  }
  const privateItems = items.some(m => m.publicId && !m.cloudPath.startsWith(m.type+"/upload/"));
  const credentials = privateItems ? await cloudCredentials() : null;
  const expiry = Math.floor(Date.now()/1000)+1800;
  return {media:items.flatMap(m=>{
    const row = {type:m.type, name:m.name || "", key:m.key};
    if (m.cloudPath.startsWith(m.type+"/upload/") || /^https:\/\/(?:firebasestorage\.googleapis\.com\/v0\/b\/dj-photo-wall\.(?:firebasestorage\.app|appspot\.com)\/o\/|storage\.googleapis\.com\/dj-photo-wall\.(?:firebasestorage\.app|appspot\.com)\/)/.test(m.url))
      return [{...row,url:m.url}];
    if (!m.publicId) return [];
    const projectorProfile = m.type === "video"
      ? {format:"mp4", transformation:"c_limit,w_854,h_480,fps_24,vc_h264:baseline,ac_none,q_auto:eco"}
      : PREVIEW.image;
    const url = timedDownload(credentials,m,expiry,true,projectorProfile);
    return [{...row,url,...(m.type==="video" ? {fallbackUrl:timedDownload(credentials,m,expiry,false)} : {})}];
  })};
});
