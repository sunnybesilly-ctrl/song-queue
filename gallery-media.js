import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, doc, getDocFromServer } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { getStorage, ref, getBlob, uploadBytesResumable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";

const MAX_BYTES = 75 * 1024 * 1024;
const mime = /^(?:image\/(?:jpeg|png|gif|webp|avif)|video\/(?:mp4|quicktime|webm|ogg))$/;
const bucket = app => getStorage(app);

export async function postGalleryMedia(app, file, details, onProgress = () => {}) {
  if (!mime.test(file.type) || file.size < 1 || file.size > MAX_BYTES) {
    throw new Error("Use a supported photo or video up to 75 MB.");
  }
  const auth = getAuth(app);
  await auth.authStateReady();
  const user = auth.currentUser || (await signInAnonymously(auth)).user;
  const state = (await getDocFromServer(doc(getFirestore(app), "gallery_state", "current"))).data();
  if (!state?.active) throw new Error("Uploads open when the DJ starts an event.");

  const id = crypto.randomUUID();
  const incoming = ref(bucket(app), `gallery-incoming/${state.eventId}/${user.uid}/${id}`);
  const upload = uploadBytesResumable(incoming, file, { contentType: file.type });
  await new Promise((resolve, reject) => upload.on("state_changed",
    snap => onProgress(snap.bytesTransferred / snap.totalBytes), reject, resolve));
  const publish = httpsCallable(getFunctions(app, "us-central1"), "publishGalleryMedia", { timeout: 180000 });
  const payload = { ...details, eventId: state.eventId, id };
  try {
    await publish(payload);
  } catch (error) {
    if (!["functions/unavailable", "functions/deadline-exceeded"].includes(error.code)) throw error;
    await publish(payload);
  }
  return id;
}

export async function privateMediaUrl(app, path) {
  return URL.createObjectURL(await getBlob(ref(bucket(app), path), MAX_BYTES));
}

export function releaseMedia(root) {
  root.querySelectorAll("img,video").forEach(media => {
    if (!media.src.startsWith("blob:")) return;
    URL.revokeObjectURL(media.src);
    media.removeAttribute("src");
    if (media.tagName === "VIDEO") media.load();
  });
}

export function previewWhenVisible(app, root, onError) {
  const observer = new IntersectionObserver(entries => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting) continue;
      observer.unobserve(target);
      privateMediaUrl(app, target.dataset.storagePath).then(url => {
        if (root.contains(target)) target.src = url;
        else URL.revokeObjectURL(url);
      }).catch(error => {
        if (root.contains(target)) onError(error, target);
      });
    }
  });
  return observer;
}
