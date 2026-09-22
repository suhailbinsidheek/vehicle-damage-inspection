const beforeInput = document.getElementById("beforeVideo");
const afterInput = document.getElementById("afterVideo");
const beforePreview = document.getElementById("beforePreview");
const afterPreview = document.getElementById("afterPreview");
const scrubber = document.getElementById("scrubber");
const timeLabel = document.getElementById("timeLabel");
const scanButton = document.getElementById("scanButton");
const resultCard = document.getElementById("resultCard");
const resultIcon = document.getElementById("resultIcon");
const resultTitle = document.getElementById("resultTitle");
const resultText = document.getElementById("resultText");
const canvas = document.getElementById("comparisonCanvas");
const modelStatus = document.getElementById("modelStatus");
const modelDot = document.getElementById("modelDot");
const captureButton = document.getElementById("captureButton");
const reportButton = document.getElementById("reportButton");
const evidenceLabel = document.getElementById("evidenceLabel");
const evidenceCanvas = document.getElementById("evidenceCanvas");
const beforeDamageBox = document.getElementById("beforeDamageBox");
const afterDamageBox = document.getElementById("afterDamageBox");
const reviewWindow = document.getElementById("reviewWindow");
const analysisOverlay = document.getElementById("analysisOverlay");
const analysisOverlayText = document.getElementById("analysisOverlayText");
const analysisProgressBar = document.getElementById("analysisProgressBar");
const analysisProgressLabel = document.getElementById("analysisProgressLabel");
const entrySplash = document.getElementById("entrySplash");
const reportLogo = document.getElementById("reportLogo");
let beforeUrl;
let afterUrl;
let beforeFile;
let afterFile;
let detector;
const validations = { before: false, after: false };
const stabilityResults = { before: null, after: null };
let reviewInProgress = false;
let syncingVideos = false;
let lastAnalysis = null;
const VEHICLE_CLASSES = new Set(["car", "truck", "bus", "motorcycle", "bicycle"]);
const BLOCKED_CLASSES = new Set(["person", "cat", "dog", "bird", "horse"]);
const STABILITY_WIDTH = 64;
const STABILITY_HEIGHT = 36;
const SEGMENT_COUNT = 8;
const MAX_REVIEW_CHECKPOINTS = 120;
const DAMAGE_THRESHOLD = 0.06;
const MAX_REPORT_EVIDENCE = 8;

function hideEntrySplash() {
  if (entrySplash) entrySplash.classList.add("is-hidden");
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "00:00";
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function loadDetector() {
  if (!detector) {
    detector = cocoSsd.load().then((model) => {
      modelStatus.textContent = "AI model ready";
      modelDot.classList.add("is-ready");
      hideEntrySplash();
      return model;
    }).catch((error) => {
      modelStatus.textContent = "AI model unavailable";
      modelDot.classList.add("is-error");
      hideEntrySplash();
      throw new Error(`AI model could not load: ${error.message}`);
    });
  }
  return detector;
}

function captureVideoFrame(video, time) {
  return new Promise((resolve, reject) => {
    let timeoutId;
    const onSeeked = () => {
      clearTimeout(timeoutId);
      resolve(video);
    };
    if (Math.abs(video.currentTime - time) < 0.01 && video.readyState >= 2) {
      resolve(video);
      return;
    }
    video.addEventListener("seeked", onSeeked, { once: true });
    video.currentTime = time;
    timeoutId = setTimeout(() => {
      video.removeEventListener("seeked", onSeeked);
      reject(new Error("The video frame could not be read."));
    }, 5000);
  });
}

function captureStabilitySignature(video) {
  const stabilityCanvas = document.createElement("canvas");
  stabilityCanvas.width = STABILITY_WIDTH;
  stabilityCanvas.height = STABILITY_HEIGHT;
  const context = stabilityCanvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(video, 0, 0, STABILITY_WIDTH, STABILITY_HEIGHT);
  const pixels = context.getImageData(0, 0, STABILITY_WIDTH, STABILITY_HEIGHT).data;
  const signature = new Uint8Array(STABILITY_WIDTH * STABILITY_HEIGHT);
  for (let index = 0; index < signature.length; index += 1) {
    const pixel = index * 4;
    signature[index] = Math.round((pixels[pixel] + pixels[pixel + 1] + pixels[pixel + 2]) / 3);
  }
  return signature;
}

function getFrameMotion(previous, current) {
  let difference = 0;
  for (let index = 0; index < previous.length; index += 1) {
    difference += Math.abs(previous[index] - current[index]);
  }
  return difference / (previous.length * 255);
}

function drawStabilizedFrame(context, video, width, height) {
  const crop = 0.08;
  context.drawImage(
    video,
    video.videoWidth * crop,
    video.videoHeight * crop,
    video.videoWidth * (1 - crop * 2),
    video.videoHeight * (1 - crop * 2),
    0,
    0,
    width,
    height
  );
}

async function checkVideoStability(video, sampleTimes) {
  const signatures = [];
  for (const time of sampleTimes) {
    await captureVideoFrame(video, time);
    signatures.push(captureStabilitySignature(video));
  }
  const motions = signatures.slice(1).map((signature, index) => getFrameMotion(signatures[index], signature));
  const averageMotion = motions.reduce((sum, value) => sum + value, 0) / Math.max(1, motions.length);
  const unstableTransitions = motions.filter((motion) => motion > 0.24).length;
  return { averageMotion, unstableTransitions, stable: averageMotion < 0.18 && unstableTransitions <= 1 };
}

function getSegmentTimes(duration) {
  return Array.from({ length: SEGMENT_COUNT }, (_, index) => {
    const start = duration * index / SEGMENT_COUNT;
    const end = duration * (index + 1) / SEGMENT_COUNT;
    return { start, middle: (start + end) / 2, end: Math.max(start, end - 0.05) };
  });
}

function updateControls() {
  const ready = validations.before && validations.after;
  scanButton.disabled = !ready;
  scrubber.disabled = !ready;
  captureButton.disabled = !lastAnalysis;
  reportButton.disabled = !lastAnalysis;
  if (ready) {
    const duration = Math.min(beforePreview.duration || 0, afterPreview.duration || 0);
    scrubber.max = String(duration);
    timeLabel.textContent = `${formatTime(0)} / ${formatTime(duration)}`;
  }
}

async function validateVideo(video, messageElement, key) {
  try {
    await new Promise((resolve, reject) => {
      const loaded = () => {
        video.removeEventListener("loadedmetadata", loaded);
        video.removeEventListener("error", failed);
        resolve();
      };
      const failed = () => reject(new Error("The video could not be loaded."));
      if (video.readyState >= 1) {
        resolve();
        return;
      }
      video.addEventListener("loadedmetadata", loaded);
      video.addEventListener("error", failed);
    });
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("This video has no readable duration.");
    if (video.duration > 300) throw new Error("Video is longer than 5 minutes. Please choose a shorter clip.");
    messageElement.className = "validation-message is-loading";
    messageElement.textContent = "AI is preparing segment-by-segment stabilization...";
    const model = await loadDetector();
    await identifyVehicleType(model, video, key);
    const segments = getSegmentTimes(video.duration);
    const segmentStability = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const stability = await checkVideoStability(video, [segment.start, segment.middle, segment.end]);
      segmentStability.push(stability);
      messageElement.textContent = `Stabilizing and checking segment ${index + 1} of ${segments.length}...`;
    }
    const stability = {
      stable: segmentStability.every((result) => result.stable),
      averageMotion: segmentStability.reduce((sum, result) => sum + result.averageMotion, 0) / segmentStability.length,
      segments: segmentStability
    };
    stabilityResults[key] = stability;
    const sampleTimes = segments.map((segment) => segment.middle);
    messageElement.textContent = stability.stable
      ? "Segments are stable. Checking vehicle content..."
      : "Camera movement detected. Stabilizing each segment before checking...";
    let vehicleFrames = 0;
    let blockedFrames = 0;
    const detectedClasses = new Set();
    const vehicleClasses = new Set();
    for (let index = 0; index < sampleTimes.length; index += 1) {
      const time = sampleTimes[index];
      await captureVideoFrame(video, time);
      const predictions = await model.detect(video);
      const visible = predictions.filter((prediction) => prediction.score >= 0.25);
      const vehiclePredictions = visible.filter((prediction) => VEHICLE_CLASSES.has(prediction.class));
      const blockedPredictions = visible.filter((prediction) => BLOCKED_CLASSES.has(prediction.class));
      if (vehiclePredictions.length) vehicleFrames += 1;
      vehiclePredictions.forEach((prediction) => vehicleClasses.add(prediction.class));
      if (blockedPredictions.some((prediction) => prediction.score >= 0.65)) blockedFrames += 1;
      visible.forEach((prediction) => detectedClasses.add(prediction.class));
      messageElement.textContent = `AI checking stabilized segment ${index + 1} of ${sampleTimes.length}...`;
    }
    if (blockedFrames > 0) throw new Error("A person or unrelated content was detected with high confidence. Upload a vehicle-only video.");
    validations[key] = true;
    const vehicleWarning = vehicleFrames === 0
      ? " Vehicle shape was not confidently recognized; the close-up will continue with manual confirmation."
      : "";
    const vehicleTypeElement = document.getElementById(`${key}VehicleType`);
    if (vehicleClasses.size) {
      const vehicleTypes = [...vehicleClasses].map((vehicle) => vehicle.charAt(0).toUpperCase() + vehicle.slice(1));
      vehicleTypeElement.className = "vehicle-type";
      vehicleTypeElement.textContent = `Vehicle detected: ${vehicleTypes.join(", ")}`;
    } else {
      vehicleTypeElement.className = "vehicle-type is-uncertain";
      vehicleTypeElement.textContent = "Vehicle type uncertain (close-up view)";
    }
    messageElement.className = vehicleFrames === 0 ? "validation-message is-loading" : "validation-message is-success";
    const unstableSegments = segmentStability.filter((result) => !result.stable).length;
    const stabilizationNote = stability.stable ? " Stable footage." : ` Stabilized ${unstableSegments} segment(s).`;
    messageElement.textContent = `AI accepted this video (${vehicleFrames}/${sampleTimes.length} vehicle detections).${stabilizationNote}${vehicleWarning}`;
    updateControls();
  } catch (error) {
    validations[key] = false;
    messageElement.className = "validation-message is-error";
    messageElement.textContent = error.message;
    updateControls();
  }
}

function setVideo(input, video, nameElement, urlKey) {
  const file = input.files[0];
  if (!file) return;
  if (urlKey === "before") beforeFile = file;
  else afterFile = file;
  updateControls();
  const validationElement = document.getElementById(`${urlKey}Validation`);
  const vehicleTypeElement = document.getElementById(`${urlKey}VehicleType`);
  vehicleTypeElement.className = "vehicle-type";
  vehicleTypeElement.textContent = "Detecting vehicle type...";
  validations[urlKey] = false;
  validationElement.className = "validation-message";
  validationElement.textContent = "Checking video duration and content...";
  if (urlKey === "before") {
    if (beforeUrl) URL.revokeObjectURL(beforeUrl);
    beforeUrl = URL.createObjectURL(file);
    video.src = beforeUrl;
  } else {
    if (afterUrl) URL.revokeObjectURL(afterUrl);
    afterUrl = URL.createObjectURL(file);
    video.src = afterUrl;
  }
  nameElement.textContent = file.name;
  video.load();
  validateVideo(video, validationElement, urlKey);
}

function syncVideos(source) {
  if (syncingVideos || !Number.isFinite(source.currentTime)) return;
  syncingVideos = true;
  const duration = Math.min(beforePreview.duration || 0, afterPreview.duration || 0);
  const time = Math.min(source.currentTime, duration);
  const otherVideo = source === beforePreview ? afterPreview : beforePreview;
  if (Math.abs(otherVideo.currentTime - time) > 0.08) otherVideo.currentTime = time;
  scrubber.value = String(time);
  timeLabel.textContent = `${formatTime(time)} / ${formatTime(duration)}`;
  syncingVideos = false;
}

async function analyzeFrame() {
  if (reviewInProgress) return;
  if (!beforePreview.videoWidth || !afterPreview.videoWidth) {
    resultTitle.textContent = "AI is waiting for both videos";
    resultText.textContent = "Play or seek each video once, then run the AI analysis.";
    return;
  }
  reviewInProgress = true;
  scanButton.disabled = true;
  analysisOverlay.classList.add("is-active");
  analysisOverlay.setAttribute("aria-hidden", "false");
  analysisProgressBar.style.width = "0%";
  analysisProgressLabel.textContent = "0%";
  analysisOverlayText.textContent = "Preparing full-video review...";
  reviewWindow.className = "review-window";
  reviewWindow.textContent = "AI is reviewing both videos from start to finish. Please wait...";
  try {
    const beforeDuration = beforePreview.duration;
    const afterDuration = afterPreview.duration;
    const sampleCount = Math.min(
      MAX_REVIEW_CHECKPOINTS,
      Math.max(12, Math.ceil(Math.max(beforeDuration, afterDuration) * 2))
    );
    const progressPositions = Array.from({ length: sampleCount }, (_, index) => index / (sampleCount - 1));
    const selectedTime = Math.min(Math.max(0, Number(scrubber.value)), Math.min(beforeDuration, afterDuration));
    const model = await loadDetector();
    const frameResults = [];
    for (let index = 0; index < progressPositions.length; index += 1) {
      const videoProgress = progressPositions[index];
      await Promise.all([
        captureVideoFrame(beforePreview, beforeDuration * videoProgress),
        captureVideoFrame(afterPreview, afterDuration * videoProgress)
      ]);
      const [beforeVehicle, afterVehicle] = await Promise.all([
        detectVehicleBox(model, beforePreview),
        detectVehicleBox(model, afterPreview)
      ]);
      frameResults.push({
        ...compareCurrentFrames(beforeVehicle, afterVehicle),
        timestamp: afterDuration * videoProgress
      });
      const progress = Math.round(((index + 1) / sampleCount) * 100);
      reviewWindow.textContent = `AI reviewed ${index + 1} of ${sampleCount} full-video checkpoints (${progress}%).`;
      analysisProgressBar.style.width = `${progress}%`;
      analysisProgressLabel.textContent = `${progress}%`;
      analysisOverlayText.textContent = `Reviewing checkpoint ${index + 1} of ${sampleCount}...`;
    }
    const changedFrames = frameResults.filter((result) => result.changeRatio > DAMAGE_THRESHOLD && result.damageBox);
    const changeRatio = frameResults.reduce((sum, result) => sum + result.changeRatio, 0) / frameResults.length;
    const consistentChange = changedFrames.length > 0;
    const representative = changedFrames[Math.floor(changedFrames.length / 2)] || frameResults[Math.floor(frameResults.length / 2)];
    const damageBox = consistentChange ? representative.damageBox : null;
    const confidence = Math.round((Math.max(changedFrames.length, frameResults.length - changedFrames.length) / frameResults.length) * 100);
    const evidenceCandidates = changedFrames
      .slice()
      .sort((first, second) => second.changeRatio - first.changeRatio)
      .filter((candidate, index, candidates) => {
        const centerX = candidate.damageBox.left + candidate.damageBox.width / 2;
        const centerY = candidate.damageBox.top + candidate.damageBox.height / 2;
        return !candidates.slice(0, index).some((previous) => {
          const previousCenterX = previous.damageBox.left + previous.damageBox.width / 2;
          const previousCenterY = previous.damageBox.top + previous.damageBox.height / 2;
          const distance = Math.hypot(
            (centerX - previousCenterX) / candidate.width,
            (centerY - previousCenterY) / candidate.height
          );
          return distance < 0.14;
        });
      })
      .slice(0, MAX_REPORT_EVIDENCE);
    await Promise.all([
      captureVideoFrame(beforePreview, selectedTime),
      captureVideoFrame(afterPreview, selectedTime)
    ]);
    const [selectedBeforeVehicle, selectedAfterVehicle] = await Promise.all([
      detectVehicleBox(model, beforePreview),
      detectVehicleBox(model, afterPreview)
    ]);
    const selectedFrame = compareCurrentFrames(selectedBeforeVehicle, selectedAfterVehicle);
    lastAnalysis = {
      timestamp: selectedTime,
      reviewStart: 0,
      reviewEnd: Math.max(beforeDuration, afterDuration),
      changeRatio,
      damageBox: consistentChange ? damageBox : selectedFrame.damageBox,
      frameWidth: representative.width,
      frameHeight: representative.height,
      confidence,
      changedFrames: changedFrames.length,
      reviewedFrames: frameResults.length,
      finding: consistentChange ? "Possible visual change detected across the complete video review" : "No consistent change confirmed across the complete video review",
      evidence: []
    };
    for (const candidate of evidenceCandidates) {
      await captureVideoFrame(afterPreview, candidate.timestamp);
      const imageWidth = 960;
      const imageHeight = Math.round(imageWidth * afterPreview.videoHeight / afterPreview.videoWidth);
      evidenceCanvas.width = imageWidth;
      evidenceCanvas.height = imageHeight;
      evidenceCanvas.getContext("2d").drawImage(afterPreview, 0, 0, imageWidth, imageHeight);
      lastAnalysis.evidence.push({
        image: evidenceCanvas.toDataURL("image/jpeg", 0.82),
        timestamp: candidate.timestamp,
        changeRatio: candidate.changeRatio,
        damageBox: candidate.damageBox,
        frameWidth: candidate.width,
        frameHeight: candidate.height
      });
    }
    showDamageBox(damageBox);
    evidenceLabel.textContent = lastAnalysis.evidence.length
      ? `${lastAnalysis.evidence.length} distinct damage area(s) captured for the PDF`
      : `No distinct damage areas captured | ${Math.round(changeRatio * 100)}% average visual difference`;
    reviewWindow.className = `review-window ${consistentChange ? "is-warning" : "is-clear"}`;
    reviewWindow.textContent = `Carefully reviewed both videos from start to finish using ${lastAnalysis.reviewedFrames} matched checkpoints. ${lastAnalysis.changedFrames} checkpoints showed a change. AI consistency: ${confidence}%.`;
    resultCard.classList.remove("is-warning", "is-clear");
    if (consistentChange) {
    resultCard.classList.add("is-warning");
    resultIcon.textContent = "!";
    resultTitle.textContent = "AI detected a possible change across both videos";
    resultText.textContent = `${lastAnalysis.changedFrames} of ${lastAnalysis.reviewedFrames} full-video checkpoints changed (${confidence}% consistency). This may indicate damage or a scratch, but camera angle, lighting, reflections, and movement can also cause it. Inspect the highlighted area manually.`;
    } else {
    resultCard.classList.add("is-clear");
    resultIcon.textContent = "✓";
    resultTitle.textContent = "AI found no consistent change across both videos";
    resultText.textContent = `Only ${lastAnalysis.changedFrames} of ${lastAnalysis.reviewedFrames} full-video checkpoints changed. This is not proof that the vehicle is undamaged; review the synchronized videos manually.`;
    }
  } catch (error) {
    reviewWindow.className = "review-window is-warning";
    reviewWindow.textContent = `The careful review could not complete: ${error.message}`;
    resultTitle.textContent = "AI review needs to be run again";
    resultText.textContent = "The complete video review could not be read reliably. Check that both videos can seek normally and run the analysis again.";
  } finally {
    reviewInProgress = false;
    analysisOverlay.classList.remove("is-active");
    analysisOverlay.setAttribute("aria-hidden", "true");
    updateControls();
  }
}

async function detectVehicleBox(model, video) {
  const predictions = (await model.detect(video))
    .filter((prediction) => VEHICLE_CLASSES.has(prediction.class) && prediction.score >= 0.2)
    .sort((first, second) => {
      const firstArea = first.bbox[2] * first.bbox[3] * first.score;
      const secondArea = second.bbox[2] * second.bbox[3] * second.score;
      return secondArea - firstArea;
    });
  return predictions[0] ? predictions[0].bbox : null;
}

async function identifyVehicleType(model, video, key, options = {}) {
  const typeElement = document.getElementById(`${key}VehicleType`);
  const samples = options.samples || 10;
  const minScore = options.minScore || 0.5;
  const closeupRatio = options.closeupRatio || 0.85;
  const votes = new Map();
  const colorVotes = new Map();
  let totalDetections = 0;
  let closeupDetections = 0;
  typeElement.className = "vehicle-type is-loading";
  typeElement.textContent = "Analyzing vehicle type and color...";
  for (let index = 0; index < samples; index += 1) {
    const sampleTime = Math.min(
      (video.duration * (index + 0.5)) / samples,
      Math.max(0, video.duration - 0.1)
    );
    await captureVideoFrame(video, sampleTime);
    const predictions = await model.detect(video);
    const vehiclePredictions = predictions
      .filter((prediction) => VEHICLE_CLASSES.has(prediction.class) && prediction.score >= minScore)
      .sort((first, second) => second.score - first.score);
    const primaryVehicle = vehiclePredictions[0];
    if (primaryVehicle) {
      const color = classifyVehicleColor(video, primaryVehicle.bbox);
      if (color) colorVotes.set(color, (colorVotes.get(color) || 0) + 1);
    }
    for (const prediction of predictions) {
      if (!VEHICLE_CLASSES.has(prediction.class) || prediction.score < minScore) continue;
      const [, , width, height] = prediction.bbox;
      const frameArea = video.videoWidth * video.videoHeight;
      if ((width * height) / frameArea > closeupRatio) closeupDetections += 1;
      votes.set(prediction.class, (votes.get(prediction.class) || 0) + 1);
      totalDetections += 1;
    }
  }
  if (!totalDetections || closeupDetections > totalDetections / 2) {
    typeElement.className = "vehicle-type is-uncertain";
    typeElement.textContent = "Vehicle type uncertain (close-up view)";
    return null;
  }
  const vehicleType = [...votes.entries()].sort((first, second) => second[1] - first[1])[0][0];
  const label = vehicleType.charAt(0).toUpperCase() + vehicleType.slice(1);
  const vehicleColor = [...colorVotes.entries()].sort((first, second) => second[1] - first[1])[0]?.[0];
  typeElement.className = "vehicle-type";
  typeElement.textContent = `Identified vehicle: ${label}${vehicleColor ? ` | Color: ${vehicleColor}` : ""}`;
  return { type: vehicleType, color: vehicleColor || null };
}

function classifyVehicleColor(video, box) {
  const [x, y, width, height] = box;
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = 48;
  sampleCanvas.height = 48;
  const context = sampleCanvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(video, x, y, width, height, 0, 0, 48, 48);
  const pixels = context.getImageData(0, 0, 48, 48).data;
  const votes = new Map();
  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index] / 255;
    const green = pixels[index + 1] / 255;
    const blue = pixels[index + 2] / 255;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    const value = max * 255;
    const saturation = max ? delta / max : 0;
    let color;
    if (value < 55) color = "Black";
    else if (saturation < 0.14 && value > 215) color = "White";
    else if (saturation < 0.18) color = value > 150 ? "Silver" : "Gray";
    else {
      let hue = 0;
      if (delta) {
        if (max === red) hue = 60 * (((green - blue) / delta) % 6);
        else if (max === green) hue = 60 * ((blue - red) / delta + 2);
        else hue = 60 * ((red - green) / delta + 4);
      }
      if (hue < 0) hue += 360;
      if (hue < 18 || hue >= 345) color = "Red";
      else if (hue < 45) color = "Orange";
      else if (hue < 70) color = "Yellow";
      else if (hue < 165) color = "Green";
      else if (hue < 255) color = "Blue";
      else if (hue < 345) color = "Purple";
    }
    votes.set(color, (votes.get(color) || 0) + 1);
  }
  return [...votes.entries()].sort((first, second) => second[1] - first[1])[0]?.[0] || null;
}

function getCrop(video, vehicleBox) {
  if (!vehicleBox) return { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight };
  const padding = 0.1;
  const x = Math.max(0, vehicleBox[0] - vehicleBox[2] * padding);
  const y = Math.max(0, vehicleBox[1] - vehicleBox[3] * padding);
  const right = Math.min(video.videoWidth, vehicleBox[0] + vehicleBox[2] * (1 + padding));
  const bottom = Math.min(video.videoHeight, vehicleBox[1] + vehicleBox[3] * (1 + padding));
  return { x, y, width: right - x, height: bottom - y };
}

function compareCurrentFrames(beforeVehicle, afterVehicle) {
  const width = 320;
  const height = Math.min(
    Math.max(1, Math.round(width * beforePreview.videoHeight / beforePreview.videoWidth)),
    Math.max(1, Math.round(width * afterPreview.videoHeight / afterPreview.videoWidth))
  );
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const beforeCrop = getCrop(beforePreview, beforeVehicle);
  const afterCrop = getCrop(afterPreview, afterVehicle);
  context.drawImage(beforePreview, beforeCrop.x, beforeCrop.y, beforeCrop.width, beforeCrop.height, 0, 0, width, height);
  const beforePixels = context.getImageData(0, 0, width, height).data;
  context.drawImage(afterPreview, afterCrop.x, afterCrop.y, afterCrop.width, afterCrop.height, 0, 0, width, height);
  const afterPixels = context.getImageData(0, 0, width, height).data;
  let changedPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < beforePixels.length; i += 4) {
    const difference = Math.abs(beforePixels[i] - afterPixels[i])
      + Math.abs(beforePixels[i + 1] - afterPixels[i + 1])
      + Math.abs(beforePixels[i + 2] - afterPixels[i + 2]);
    if (difference > 90) {
      changedPixels += 1;
      const pixel = i / 4;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const changeRatio = changedPixels / (width * height);
  const damageBox = maxX >= 0
    ? {
      left: Math.round((afterCrop.x / afterPreview.videoWidth) * width + (minX / width) * (afterCrop.width / afterPreview.videoWidth) * width),
      top: Math.round((afterCrop.y / afterPreview.videoHeight) * height + (minY / height) * (afterCrop.height / afterPreview.videoHeight) * height),
      width: Math.max(1, Math.round((maxX - minX + 1) / width * (afterCrop.width / afterPreview.videoWidth) * width)),
      height: Math.max(1, Math.round((maxY - minY + 1) / height * (afterCrop.height / afterPreview.videoHeight) * height))
    }
    : null;
  return {
    width,
    height,
    changeRatio,
    damageBox
  };
}

function showDamageBox(box) {
    [beforeDamageBox, afterDamageBox].forEach((element) => {
      if (!box) {
        element.style.display = "none";
        return;
      }
      element.style.display = "block";
      element.style.left = `${(box.left / lastAnalysis.frameWidth) * 100}%`;
      element.style.top = `${(box.top / lastAnalysis.frameHeight) * 100}%`;
      element.style.width = `${(box.width / lastAnalysis.frameWidth) * 100}%`;
      element.style.height = `${(box.height / lastAnalysis.frameHeight) * 100}%`;
    });
}

function captureEvidence() {
    if (!lastAnalysis || !afterPreview.videoWidth) return;
    const width = 960;
    const height = Math.round(width * afterPreview.videoHeight / afterPreview.videoWidth);
    evidenceCanvas.width = width;
    evidenceCanvas.height = height;
    evidenceCanvas.getContext("2d").drawImage(afterPreview, 0, 0, width, height);
    evidenceLabel.textContent = `Damage frame captured at ${formatTime(lastAnalysis.timestamp)} from the after video`;
    const evidence = {
      image: evidenceCanvas.toDataURL("image/jpeg", 0.88),
      timestamp: lastAnalysis.timestamp,
      changeRatio: lastAnalysis.changeRatio,
      damageBox: lastAnalysis.damageBox,
      frameWidth: lastAnalysis.frameWidth,
      frameHeight: lastAnalysis.frameHeight
    };
    lastAnalysis.evidence = [evidence, ...(lastAnalysis.evidence || [])].slice(0, MAX_REPORT_EVIDENCE);
    reportButton.disabled = false;
}

async function downloadReport() {
    if (!lastAnalysis) return;
    if (!lastAnalysis.evidence?.length) captureEvidence();
    if (!lastAnalysis.evidence?.length || !window.jspdf) {
      resultText.textContent = "PDF library is unavailable. Please check your internet connection and try again.";
      return;
    }
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF();
    const logoCanvas = document.createElement("canvas");
    if (reportLogo.complete && reportLogo.naturalWidth) {
      logoCanvas.width = reportLogo.naturalWidth;
      logoCanvas.height = reportLogo.naturalHeight;
      logoCanvas.getContext("2d").drawImage(reportLogo, 0, 0);
    }
    lastAnalysis.evidence.forEach((evidence, index) => {
      if (index > 0) pdf.addPage();
      pdf.setFontSize(22);
      if (logoCanvas.width) pdf.addImage(logoCanvas.toDataURL("image/jpeg", 0.9), "JPEG", 160, 12, 25, 18);
      pdf.text("Vehicle Damage Report", 20, 24);
      pdf.setFontSize(11);
      pdf.setTextColor(90);
      pdf.text(`Generated: ${new Date().toLocaleString()}`, 20, 34);
      pdf.text(`Evidence ${index + 1} of ${lastAnalysis.evidence.length}`, 20, 42);
      pdf.text(`Video position: ${formatTime(evidence.timestamp)}`, 20, 50);
      pdf.text(`Reviewed: ${formatTime(lastAnalysis.reviewStart)} - ${formatTime(lastAnalysis.reviewEnd)}`, 20, 58);
      pdf.text(`Visual difference: ${Math.round(evidence.changeRatio * 100)}% | AI consistency: ${lastAnalysis.confidence}%`, 20, 66);
      pdf.setTextColor(30);
      pdf.setFontSize(15);
      pdf.text(lastAnalysis.finding, 20, 80);
      pdf.setFontSize(10);
      pdf.setTextColor(90);
      const warning = "AI evidence is visual guidance only. Confirm damage manually; lighting, angle, reflections, and movement may affect the result.";
      pdf.text(pdf.splitTextToSize(warning, 170), 20, 90);
      const imageX = 20;
      const imageY = 110;
      const imageWidth = 170;
      const imageHeight = 95;
      pdf.addImage(evidence.image, "JPEG", imageX, imageY, imageWidth, imageHeight);
      if (evidence.damageBox) {
        pdf.setDrawColor(255, 173, 35);
        pdf.setLineWidth(1.2);
        pdf.rect(
          imageX + (evidence.damageBox.left / evidence.frameWidth) * imageWidth,
          imageY + (evidence.damageBox.top / evidence.frameHeight) * imageHeight,
          (evidence.damageBox.width / evidence.frameWidth) * imageWidth,
          (evidence.damageBox.height / evidence.frameHeight) * imageHeight
        );
      }
    });
    pdf.save(`vehicle-damage-report-${Date.now()}.pdf`);
}

beforeInput.addEventListener("change", () => setVideo(beforeInput, beforePreview, document.getElementById("beforeName"), "before"));
afterInput.addEventListener("change", () => setVideo(afterInput, afterPreview, document.getElementById("afterName"), "after"));
beforePreview.addEventListener("timeupdate", () => syncVideos(beforePreview));
afterPreview.addEventListener("timeupdate", () => syncVideos(afterPreview));
scrubber.addEventListener("input", () => syncVideos(beforePreview));
scanButton.addEventListener("click", analyzeFrame);
captureButton.addEventListener("click", captureEvidence);
reportButton.addEventListener("click", downloadReport);
loadDetector();
