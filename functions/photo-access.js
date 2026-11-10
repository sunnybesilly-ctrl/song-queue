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
