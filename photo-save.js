// The admin signer accepts delivery URLs with these Cloudinary paths.
export function photoSaveSource(url) {
  const match = /^(https:\/\/res\.cloudinary\.com\/yl4yzjh5\/(?:image|video)\/(?:authenticated|upload)\/)((?:[\w.,:-]+\/)*)((?:v\d+\/)[\w-]+\.[\w]+)$/.exec(url || "");
  if (!match || !match[2] || match[2].startsWith("s--")) return url;
  const transforms = match[2].split("/").filter(Boolean)
    .map(part => part.split(",").filter(value => !/^q_auto(?:[:_]|$)/.test(value)).join(","))
    .filter(Boolean);
  if (!transforms.includes("fl_keep_iptc")) transforms.push("fl_keep_iptc");
  return match[1] + transforms.join("/") + "/" + match[3];
}

let activeDialog;

export function closePhotosSave() {
  if (!activeDialog) return;
  activeDialog.close();
  activeDialog = null;
}

function make(tag, label) {
  const element = document.createElement(tag);
  if (label) element.textContent = label;
  return element;
}

function filename(url, type) {
  const extension = /\.([a-z\d]+)(?:[?#]|$)/i.exec(url)?.[1] || (type === "video" ? "mp4" : "jpg");
  return "Photo-Wall." + extension;
}

export async function openPhotosSave({ url, fallback, type, links }) {
  const fallbackUrl = fallback || links.resolve(url);
  if (typeof HTMLDialogElement === "undefined" || !HTMLDialogElement.prototype.showModal) {
    if (fallbackUrl) window.open(fallbackUrl, "_blank", "noopener");
    return;
  }
  closePhotosSave();
  const controller = new AbortController();
  let file;
  let downloadUrl;
  const dialog = make("dialog");
  activeDialog = dialog;
  dialog.style.cssText = "color:var(--bone,#f6fff1);background:#0c2114;border:1px solid var(--lime,#91d96f);border-radius:14px;padding:20px;width:min(420px,calc(100% - 28px));box-sizing:border-box";
  const heading = make("h3", "Save to Photos");
  const status = make("p", "Preparing media…");
  status.setAttribute("role", "status");
  const actions = make("div");
  actions.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-top:14px";
  const share = make("button", "Open share sheet");
  share.type = "button";
  share.hidden = true;
  const download = make("a", "Open file");
  download.hidden = !fallbackUrl;
  download.href = fallbackUrl || "#";
  download.target = "_blank";
  download.rel = "noopener noreferrer";
  download.style.color = "var(--lime,#91d96f)";
  const close = make("button", "Close");
  close.type = "button";
  close.onclick = () => dialog.close();
  actions.append(share, download, close);
  dialog.append(heading, status, actions);
  dialog.addEventListener("close", () => {
    controller.abort();
    if (downloadUrl) setTimeout(() => URL.revokeObjectURL(downloadUrl), 10_000);
    if (activeDialog === dialog) activeDialog = null;
    dialog.remove();
  }, { once: true });
  document.body.appendChild(dialog);
  dialog.showModal();

  const saveAction = type === "video" ? "Save Video" : "Save Image";
  share.onclick = async () => {
    share.disabled = true;
    try {
      await navigator.share({ files: [file] });
    } catch (error) {
      if (dialog.open && error.name !== "AbortError") {
        status.textContent = "Tap Open share sheet again, or download the file.";
      }
    } finally {
      share.disabled = false;
    }
  };

  try {
    const source = photoSaveSource(url);
    if (source) await links.prepare([source]);
    if (controller.signal.aborted || !dialog.open) return;
    const signed = source && links.resolve(source);
    if (!signed) throw new Error("The media link is unavailable.");
    download.href = signed;
    download.hidden = false;
    const response = await fetch(signed, { signal: controller.signal });
    if (!response.ok) throw new Error("The media could not be fetched.");
    const blob = await response.blob();
    if (controller.signal.aborted || !dialog.open) return;
    if (!blob.size || !/^(image|video)\//.test(blob.type)) throw new Error("The file is not a photo or video.");
    file = new File([blob], filename(source, type), { type: blob.type });
    downloadUrl = URL.createObjectURL(file);
    download.href = downloadUrl;
    download.download = file.name;
    download.textContent = "Download to Files";
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      status.textContent = "In the share sheet, choose " + saveAction + ".";
      share.hidden = false;
      if (navigator.userActivation?.isActive) void share.onclick();
    } else {
      status.textContent = "Open the download in Files, then tap Share and choose " + saveAction + ".";
    }
  } catch (error) {
    if (controller.signal.aborted || !dialog.open) return;
    status.textContent = "Open the media file, then use your phone’s Share menu to save it to Photos.";
    if (download.hidden) status.textContent = "This media file is currently unavailable.";
  }
}
