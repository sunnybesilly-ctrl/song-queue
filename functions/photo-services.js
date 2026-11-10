"use strict";

const crypto = require("node:crypto");

const CLOUD = "yl4yzjh5";
const PROJECT = "dj-photo-wall";
const TAG = "party_media";
const DRIVE = "https://www.googleapis.com/drive/v3";
const CLOUD_API = "https://api.cloudinary.com/v1_1/" + CLOUD;
const MAX_BYTES = 100 * 1024 * 1024;

class ApiError extends Error {
  constructor(operation, status) {
    super(operation + " failed (HTTP " + status + ")");
    this.status = status;
  }
}

async function request(operation, url, options = {}, allowed = []) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(90_000),
    redirect: "error",
    ...options,
  });
  if (!response.ok && !allowed.includes(response.status)) {
    await response.body?.cancel();
    throw new ApiError(operation, response.status);
  }
  return response;
}

const secrets = new Map();

async function readSecret(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid Secret Manager ID");
  const cached = secrets.get(id);
  if (cached && cached.expires > Date.now()) return cached.value;

  const identity = await request("Function identity",
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } });
  const { access_token } = await identity.json();
  const response = await request("Secret Manager access for " + id,
    "https://secretmanager.googleapis.com/v1/projects/" + PROJECT + "/secrets/" + id + "/versions/latest:access",
    { headers: { Authorization: "Bearer " + access_token } });
  const { payload } = await response.json();
  const value = Buffer.from(payload.data, "base64").toString("utf8").trim();
  if (!value) throw new Error("Empty secret: " + id);
  secrets.set(id, { value, expires: Date.now() + 5 * 60_000 });
  return value;
}

async function cloudCredentials() {
  const [key, secret] = await Promise.all([
    readSecret(process.env.PHOTO_CLOUDINARY_KEY_SECRET || "cloudinary-api-key"),
    readSecret(process.env.PHOTO_CLOUDINARY_SECRET_SECRET || "cloudinary-api-secret"),
  ]);
  return { key, secret, headers: { Authorization: "Basic " + Buffer.from(key + ":" + secret).toString("base64") } };
}

function signedParams(credentials, params) {
  const values = { ...params, timestamp: Math.floor(Date.now() / 1000) };
  const message = Object.keys(values).sort().map(key => key + "=" + values[key]).join("&");
  const signature = crypto.createHash("sha256").update(message + credentials.secret).digest("hex");
  return { ...values, api_key: credentials.key, signature };
}

function deliverySignature(tail, secret) {
  return crypto.createHash("sha1").update(tail + secret).digest("base64url").slice(0, 8);
}

async function cloudAsset(credentials, assetId) {
  const query = new URLSearchParams({
    asset_ids: assetId,
    fields: "asset_id,public_id,type,resource_type,created_at,version,bytes,format,tags",
  });
  const response = await request("Cloudinary asset lookup", CLOUD_API + "/resources/by_asset_ids?" + query,
    { headers: credentials.headers });
  const { resources } = await response.json();
  return resources.find(resource => resource.asset_id === assetId);
}

async function listTagged(credentials, type, cursor) {
  const query = new URLSearchParams({
    max_results: "100",
    fields: "asset_id,public_id,type,resource_type,created_at,version,bytes,format",
  });
  if (cursor) query.set("next_cursor", cursor);
  const response = await request("Cloudinary tag listing", CLOUD_API + "/resources/" + type + "/tags/" + TAG + "?" + query,
    { headers: credentials.headers });
  return response.json();
}

function originalUrl(credentials, assetId, expiry) {
  return CLOUD_API + "/asset/download?" + new URLSearchParams(signedParams(credentials, {
    asset_id: assetId,
    attachment: "false",
    expires_at: expiry,
  }));
}

async function destroyAsset(credentials, asset) {
  const response = await request("Cloudinary destroy", CLOUD_API + "/" + asset.resource_type + "/destroy", {
    method: "POST",
    body: new URLSearchParams(signedParams(credentials, { asset_id: asset.asset_id, invalidate: "true" })),
  });
  const { result } = await response.json();
  if (!["ok", "not found"].includes(result)) throw new Error("Cloudinary did not confirm removal");
}

async function driveCredentials() {
  let stored;
  try {
    stored = JSON.parse(await readSecret("google-drive-token"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error("google-drive-token requires a JSON OAuth refresh credential");
  }
  if (!stored || typeof stored !== "object") throw new Error("Invalid Drive OAuth credential");
  const client = stored.installed || stored.web || stored;
  const refreshToken = stored.refresh_token || stored.tokens?.refresh_token;
  if (!refreshToken || !client.client_id || !client.client_secret) {
    throw new Error("google-drive-token requires refresh_token, client_id, and client_secret");
  }
  const response = await request("Drive OAuth token refresh", "https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.client_id,
      client_secret: client.client_secret,
    }),
  });
  const { access_token } = await response.json();
  if (!access_token) throw new Error("Drive OAuth did not issue an access token");
  return { Authorization: "Bearer " + access_token };
}

async function checkPrivate(headers, id) {
  let cursor;
  do {
    const query = new URLSearchParams({ fields: "nextPageToken,permissions(type,role)" });
    if (cursor) query.set("pageToken", cursor);
    const response = await request("Drive permission check", DRIVE + "/files/" + id + "/permissions?" + query, { headers });
    const result = await response.json();
    if (!Array.isArray(result.permissions) || !result.permissions.length ||
        result.permissions.some(p => p.type === "anyone" || p.type === "domain")) {
      throw new Error("Drive archive permissions could not be verified as private");
    }
    cursor = result.nextPageToken;
  } while (cursor);
}

function archiveFolder() {
  const id = process.env.PHOTO_DRIVE_ARCHIVE_FOLDER;
  if (!/^[a-zA-Z0-9_-]{10,}$/.test(id || "")) {
    throw new Error("PHOTO_DRIVE_ARCHIVE_FOLDER is missing or invalid");
  }
  return id;
}

async function checkFolder(headers) {
  const folderId = archiveFolder();
  const response = await request("Drive archive folder check",
    DRIVE + "/files/" + folderId + "?fields=id,mimeType,trashed,capabilities(canAddChildren)", { headers });
  const folder = await response.json();
  if (folder.id !== folderId || folder.trashed !== false || folder.mimeType !== "application/vnd.google-apps.folder" ||
      !folder.capabilities?.canAddChildren) throw new Error("Drive archive folder is not writable");
  await checkPrivate(headers, folderId);
}

async function newDriveId(headers) {
  const response = await request("Drive ID reservation", DRIVE + "/files/generateIds?count=1&space=drive", { headers });
  const { ids } = await response.json();
  if (!/^[a-zA-Z0-9_-]+$/.test(ids?.[0] || "")) throw new Error("Drive did not reserve an ID");
  return ids[0];
}

async function uploadMaster(headers, id, asset, bytes) {
  const info = {
    id, parents: [archiveFolder()],
    name: asset.resource_type + "-" + asset.asset_id + "-v" + asset.version + "." + asset.format,
    mimeType: "application/octet-stream",
    appProperties: { cloudinaryAssetId: asset.asset_id, cloudinaryVersion: String(asset.version) },
  };
  const session = await request("Drive upload session",
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": info.mimeType,
        "X-Upload-Content-Length": String(bytes.length),
      },
      body: JSON.stringify(info),
    }, [409]);
  await session.body?.cancel();
  if (session.status === 409) return;
  const location = session.headers.get("location");
  if (!location || new URL(location).origin !== "https://www.googleapis.com") {
    throw new Error("Drive did not provide a valid resumable upload session");
  }
  const response = await request("Drive upload", location, {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Type": info.mimeType,
      "Content-Length": String(bytes.length),
      "Content-Range": "bytes 0-" + (bytes.length - 1) + "/" + bytes.length,
    },
    body: bytes,
  }, [409]);
  await response.body?.cancel();
}

async function verifyMaster(headers, id, asset, sha256) {
  const fields = "id,trashed,parents,size,sha256Checksum,appProperties";
  const response = await request("Drive master verification", DRIVE + "/files/" + id + "?fields=" + fields, { headers });
  const file = await response.json();
  if (file.id !== id || file.trashed !== false || !file.parents?.includes(archiveFolder()) ||
      file.size !== String(asset.bytes) || file.appProperties?.cloudinaryAssetId !== asset.asset_id ||
      file.appProperties?.cloudinaryVersion !== String(asset.version)) {
    throw new Error("Drive master metadata does not match the Cloudinary original");
  }
  let checksum = file.sha256Checksum;
  if (!checksum) {
    const copy = await request("Drive master readback", DRIVE + "/files/" + id + "?alt=media", { headers });
    checksum = (await readOriginal(copy, asset.bytes, false)).sha256;
  }
  if (checksum !== sha256) throw new Error("Drive master checksum does not match the Cloudinary original");
  await checkPrivate(headers, id);
}

async function readOriginal(response, expectedSize, keepBytes) {
  const digest = crypto.createHash("sha256");
  const chunks = [];
  let length = 0;
  if (response.status !== 200 || !response.body) throw new Error("Full original unavailable");
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > expectedSize || length > MAX_BYTES) throw new Error("Original exceeds its expected size");
    digest.update(chunk);
    if (keepBytes) chunks.push(chunk);
  }
  if (length !== expectedSize || length < 1) throw new Error("Original size does not match");
  return { sha256: digest.digest("hex"), bytes: keepBytes ? Buffer.concat(chunks, length) : null };
}

async function fetchOriginal(credentials, asset, keepBytes) {
  const response = await request("Cloudinary original download",
    originalUrl(credentials, asset.asset_id, Math.floor(Date.now() / 1000) + 300),
    { redirect: "follow" });
  return readOriginal(response, asset.bytes, keepBytes);
}

module.exports = {
  CLOUD, TAG, MAX_BYTES, request, cloudCredentials, signedParams, deliverySignature, cloudAsset, listTagged,
  originalUrl, destroyAsset, driveCredentials, checkFolder, newDriveId, uploadMaster, verifyMaster, fetchOriginal,
};
