const fullFrame = () => ({ x: 0, y: 0, w: 1, h: 1 });
const clamp = (value, low, high) => Math.max(low, Math.min(value, high));

export function mediaClock(seconds) {
  const total = Math.floor(Math.max(0, seconds));
  return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
}

export function createMediaEditor(root) {
  const get = id => root.querySelector("#" + id);
  const image = get("editImage");
  const video = get("editVideo");
  const stage = get("editStage");
  const preview = get("editCanvas");
  const frame = get("cropFrame");
  const play = get("editPlay");
  const seek = get("editSeek");
  const duration = get("editDuration");
  const controls = [...root.querySelectorAll("button, input")];
  let media, turns = 0, crop = fullFrame(), dragging, animation = 0, locked = false;

  function dimensions() {
    return media === video ? [video.videoWidth, video.videoHeight] :
      [image.naturalWidth, image.naturalHeight];
  }

  function draw(canvas, source, width, height, rotation, area) {
    const [rw, rh] = rotation % 2 ? [height, width] : [width, height];
    const ctx = canvas.getContext("2d");
    ctx.setTransform(canvas.width / (rw * area.w), 0, 0, canvas.height / (rh * area.h),
      -area.x * canvas.width / area.w, -area.y * canvas.height / area.h);
    ctx.translate(rw / 2, rh / 2);
    ctx.rotate(rotation * Math.PI / 2);
    ctx.drawImage(source, -width / 2, -height / 2, width, height);
  }

  function updateFrame() {
    Object.assign(frame.style, {
      left: crop.x * 100 + "%", top: crop.y * 100 + "%",
      width: crop.w * 100 + "%", height: crop.h * 100 + "%"
    });
  }

  function paint() {
    if (!media) return;
    const [w, h] = dimensions();
    if (!w || !h) return;
    const [rw, rh] = turns % 2 ? [h, w] : [w, h];
    const scale = Math.min(1, 640 / Math.max(rw, rh));
    const width = Math.max(1, Math.round(rw * scale));
    const height = Math.max(1, Math.round(rh * scale));
    if (preview.width !== width || preview.height !== height) {
      preview.width = width;
      preview.height = height;
    }
    stage.style.width = "min(100%, " + (260 * rw / rh) + "px)";
    stage.hidden = false;
    if (media === image || video.readyState >= 2) draw(preview, media, w, h, turns, fullFrame());
    updateFrame();
  }

  function load() {
    paint();
    controls.forEach(control => { control.disabled = locked || stage.hidden; });
    if (media !== video || !Number.isFinite(video.duration)) return;
    seek.max = video.duration;
    seek.value = video.currentTime;
    duration.textContent = mediaClock(video.currentTime) + " / " + mediaClock(Math.ceil(video.duration));
  }

  image.addEventListener("load", load);
  ["loadedmetadata", "loadeddata", "seeked", "timeupdate"].forEach(event => video.addEventListener(event, () => {
    if (media === video) load();
  }));
  function animate() {
    paint();
    if (!video.paused) animation = requestAnimationFrame(animate);
  }
  video.addEventListener("play", () => {
    play.textContent = "Pause";
    cancelAnimationFrame(animation);
    animate();
  });
  video.addEventListener("pause", () => {
    play.textContent = "Play";
    cancelAnimationFrame(animation);
  });
  play.onclick = () => video.paused ? video.play().catch(() => {}) : video.pause();
  seek.oninput = () => { video.currentTime = Number(seek.value); };
  function rotate(direction) {
    const {x, y, w, h} = crop;
    crop = direction > 0 ? {x: 1 - y - h, y: x, w: h, h: w} :
      {x: y, y: 1 - x - w, w: h, h: w};
    turns = (turns + direction + 4) % 4;
    paint();
  }
  get("rotateLeft").onclick = () => rotate(-1);
  get("rotateRight").onclick = () => rotate(1);
  get("cropReset").onclick = () => { turns = 0; crop = fullFrame(); paint(); };

  function point(event) {
    const box = stage.getBoundingClientRect();
    return { x: clamp((event.clientX - box.left) / box.width, 0, 1),
      y: clamp((event.clientY - box.top) / box.height, 0, 1) };
  }
  function adjust(handle, start, dx, dy) {
    let {x, y, w, h} = start;
    let right = x + w, bottom = y + h;
    if (handle.includes("w")) x = clamp(x + dx, 0, right - .01);
    if (handle.includes("e")) right = clamp(right + dx, x + .01, 1);
    if (handle.includes("n")) y = clamp(y + dy, 0, bottom - .01);
    if (handle.includes("s")) bottom = clamp(bottom + dy, y + .01, 1);
    crop = { x, y, w: right - x, h: bottom - y };
    updateFrame();
  }
  stage.onpointerdown = event => {
    if (locked || dragging || event.button !== 0) return;
    const handle = event.target.dataset.corner || "";
    dragging = { id: event.pointerId, handle, point: point(event), crop: { ...crop } };
    stage.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  stage.onpointermove = event => {
    if (dragging?.id !== event.pointerId) return;
    const next = point(event), start = dragging.point;
    if (dragging.handle) {
      adjust(dragging.handle, dragging.crop, next.x - start.x, next.y - start.y);
    } else if (Math.abs(next.x - start.x) >= .01 && Math.abs(next.y - start.y) >= .01) {
      crop = {x: Math.min(next.x, start.x), y: Math.min(next.y, start.y),
        w: Math.abs(next.x - start.x), h: Math.abs(next.y - start.y)};
      updateFrame();
    }
  };
  stage.onlostpointercapture = () => { dragging = null; };
  frame.onkeydown = event => {
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const move = moves[event.key];
    if (locked || !move || !event.target.dataset.corner) return;
    event.preventDefault();
    const step = event.shiftKey ? .05 : .01;
    adjust(event.target.dataset.corner, crop, move[0] * step, move[1] * step);
  };

  function clear() {
    media = null;
    video.pause();
    video.removeAttribute("src");
    video.load();
    image.removeAttribute("src");
    root.hidden = stage.hidden = true;
    turns = 0;
    crop = fullFrame();
    duration.textContent = "";
    dragging = null;
  }

  function selected(url, isVideo) {
    root.hidden = false;
    get("editorTitle").textContent = isVideo ? "Edit your video" : "Edit your photo";
    get("videoTools").hidden = !isVideo;
    controls.forEach(control => { control.disabled = true; });
    media = isVideo ? video : image;
    media.src = url;
  }

  function outputCanvas(width, height, maxEdge, even = false) {
    const w = (turns % 2 ? height : width) * crop.w;
    const h = (turns % 2 ? width : height) * crop.h;
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    const unit = even ? 2 : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(unit, Math.round(w * scale / unit) * unit);
    canvas.height = Math.max(unit, Math.round(h * scale / unit) * unit);
    return canvas;
  }

  async function recordVideo(file, maxBytes, progress) {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream || !Audio) {
      throw new Error("This browser cannot save video edits. Try a current version of Safari, Chrome, or Edge.");
    }
    if (!Number.isFinite(video.duration) || !video.videoWidth) {
      throw new Error("Wait for the video preview to load, then try again.");
    }
    if (document.hidden) throw new Error("Keep this tab open while saving your video edits.");
    video.pause();
    const source = document.createElement("video");
    source.playsInline = true;
    source.preload = "auto";
    source.className = "edit-source";
    source.setAttribute("aria-hidden", "true");
    root.appendChild(source);
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    let recorder, stream, tick = 0, watchdog, visibility;
    try {
      const resumed = audio.resume();
      const destination = audio.createMediaStreamDestination();
      audio.createMediaElementSource(source).connect(destination);
      const canvas = outputCanvas(video.videoWidth, video.videoHeight, 1440, true);
      stream = canvas.captureStream(30);
      destination.stream.getAudioTracks().forEach(track => stream.addTrack(track));
      const mimeType = ["video/mp4", "video/webm;codecs=vp8,opus", "video/webm"]
        .find(type => MediaRecorder.isTypeSupported(type));
      const videoBitsPerSecond = Math.round(clamp(maxBytes * 6 / video.duration - 128000, 80000, 4200000));
      recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond, audioBitsPerSecond: 128000 });
      const chunks = [];
      let recording = false;
      let ended = false;
      const result = new Promise((resolve, reject) => {
        const fail = () => reject(new Error("The video edits could not be saved. Try keeping this tab open or choosing a shorter file."));
        const drawFrame = () => draw(canvas, source, source.videoWidth, source.videoHeight, turns, crop);
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onerror = fail;
        recorder.onstop = () => {
          if (!ended || chunks.length === 0) return fail();
          const type = recorder.mimeType.split(";")[0] || chunks[0].type.split(";")[0];
          resolve(new File(chunks, type === "video/mp4" ? "edited-video.mp4" : "edited-video.webm", { type }));
        };
        source.onerror = fail;
        source.onplaying = () => {
          if (recording) { if (recorder.state === "paused") recorder.resume(); return; }
          try {
            drawFrame();
            recorder.start(1000);
            recording = true;
            const next = () => {
              if (source.readyState >= 2) drawFrame();
              tick = requestAnimationFrame(next);
            };
            tick = requestAnimationFrame(next);
          } catch (error) { reject(error); }
        };
        source.onwaiting = () => { if (recorder.state === "recording") recorder.pause(); };
        source.ontimeupdate = () => progress(source.currentTime, video.duration);
        source.onended = () => {
          if (!recording) return fail();
          ended = true;
          recorder.stop();
        };
        visibility = () => { if (document.hidden) fail(); };
        document.addEventListener("visibilitychange", visibility);
        watchdog = setTimeout(fail, (video.duration + 35) * 1000);
      });
      source.src = url;
      const [edited] = await Promise.all([result, resumed, source.play()]);
      if (edited.size > maxBytes) throw new Error("The edited video exceeds the upload limit. Try a smaller video.");
      return edited;
    } finally {
      clearTimeout(watchdog);
      cancelAnimationFrame(tick);
      document.removeEventListener("visibilitychange", visibility);
      source.pause();
      if (recorder && recorder.state !== "inactive") recorder.stop();
      stream?.getTracks().forEach(track => track.stop());
      source.removeAttribute("src");
      source.load();
      source.remove();
      URL.revokeObjectURL(url);
      void audio.close().catch(() => {});
    }
  }

  async function prepare(file, maxEdge, maxBytes, progress) {
    if (!turns && crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1) return file;
    if (media === video) return recordVideo(file, maxBytes, progress);
    if (/gif/i.test(file.type)) {
      throw new Error("To keep the GIF animated, reset your edits or choose a standard photo.");
    }
    const [w, h] = dimensions();
    if (!w || !h) throw new Error("Wait for the photo preview to load, then try again.");
    const canvas = outputCanvas(w, h, maxEdge);
    draw(canvas, image, w, h, turns, crop);
    const type = file.type === "image/png" ? "image/png" : "image/jpeg";
    const blob = await new Promise(resolve => canvas.toBlob(resolve, type, .9));
    if (!blob) throw new Error("The photo edits could not be saved. Please try again.");
    return new File([blob], type === "image/png" ? "edited-photo.png" : "edited-photo.jpg", { type });
  }

  return { clear, selected, prepare, lock(value) {
    locked = value;
    controls.forEach(control => { control.disabled = value || stage.hidden; });
  } };
}
