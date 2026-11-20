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

function timedDownload(credentials, media, expiry, preview) {
  const settings = preview ? PREVIEW[media.type] : { attachment: "true" };
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
  const code = crypto.randomInt(10000000,100000000).toString();
  await ref.set({ hash: crypto.createHash("sha256").update(code).digest("hex"), expires: Date.now()+300000, attempts: 0 }, {merge:true});
  return {code};
});
exports.pairProjector = onCall(OPTIONS, async req => {
  if (req.auth?.token.firebase?.sign_in_provider !== "anonymous") throw new HttpsError("permission-denied","Projector sign-in required.");
  const code = req.data?.code;
  if (typeof code !== "string" || !/^\d{8}$/.test(code)) throw new HttpsError("invalid-argument","Enter eight digits.");
  const ref = projectorState();
  const ok = await getFirestore().runTransaction(async tx => {
    const state = (await tx.get(ref)).data();
    if (!state?.hash || state.expires <= Date.now() || state.attempts >= 8) return false;
    if (crypto.createHash("sha256").update(code).digest("hex") !== state.hash) {
      tx.update(ref,{attempts:state.attempts+1});
      return false;
    }
    tx.set(ref,{uid:req.auth.uid});
    return true;
  });
  if (!ok) throw new HttpsError("permission-denied","Generate a fresh projector code.");
  return {paired:true};
});
exports.projectorReel = onCall(OPTIONS, async req => {
  if (!req.auth || (await projectorState().get()).data()?.uid !== req.auth.uid)
    throw new HttpsError("permission-denied","Pair this projector.");
  const db = getFirestore();
  const event = (await db.doc("gallery_state/current").get()).data();
  if (!event?.active || !event.eventId) return {media:[]};
  const rows = await db.collection("media_queue").where("eventId","==",event.eventId).get();
  const items = rows.docs.map(doc=>doc.data()).filter(m=>!m.rotationPaused && Object.hasOwn(PREVIEW,m.type) && typeof m.url==="string");
  const credentials = items.some(m=>PHOTO_ID.test(m.publicId)) ? await cloudCredentials() : null;
  return {media:items.flatMap(m=>{
    if (PHOTO_ID.test(m.publicId)) return [{type:m.type,url:timedDownload(credentials,m,Math.floor(Date.now()/1000)+1800,true),key:m.publicId}];
    if (m.url.startsWith(DELIVERY+m.type+"/upload/")) return [{type:m.type,url:m.url,key:m.url}];
    return [];
  })};
});
