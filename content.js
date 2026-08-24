(() => {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    mode: "mute",
    volume: 20,
    showIndicator: true
  });

  // Netflix has used several class names over time. These selectors cover the
  // home billboard and the large autoplay preview in a title-details modal.
  // Regular rows and the /watch player are intentionally not selected.
  const AUTOPLAY_CONTAINER_SELECTORS = [
    ".billboard-row",
    ".billboard",
    ".volatile-billboard-animations-container",
    "[data-uia*='billboard']",
    "[class*='billboard']",
    ".previewModal--container",
    ".previewModal--player_container",
    "[class*='previewModal--container']",
    "[class*='previewModal--player_container']",
    "[data-uia*='previewModal']"
  ];

  const AUTOPLAY_CONTAINER_SELECTOR = AUTOPLAY_CONTAINER_SELECTORS.join(",");
  const AUDIO_BUTTON_SELECTOR = [
    "button[data-uia='control-audio']",
    "button[data-uia*='audio']",
    "button[data-uia*='mute']",
    "button[aria-label*='ミュート']",
    "button[aria-label*='音声']",
    "button[aria-label*='mute' i]",
    "button[aria-label*='sound' i]"
  ].join(",");
  const originals = new Map();
  const pendingMediaEnforcement = new WeakSet();
  const initialMuteReleased = new WeakSet();
  let settings = { ...DEFAULT_SETTINGS };
  let observer;
  let scheduled = false;
  let indicatorFramePending = false;
  let indicatorHost;
  let indicatorBadge;
  let lastUrl = location.href;

  function isPlaybackRoute() {
    return location.pathname === "/watch" || location.pathname.startsWith("/watch/");
  }

  function isDetailsPreviewOpen() {
    return new URLSearchParams(location.search).has("jbv");
  }

  function isTargetVideo(video) {
    return video instanceof HTMLVideoElement &&
      !isPlaybackRoute() &&
      (Boolean(video.closest(AUTOPLAY_CONTAINER_SELECTOR)) ||
        (isDetailsPreviewOpen() && Boolean(video.closest("[role='dialog']"))));
  }

  function remember(video) {
    if (!originals.has(video)) {
      originals.set(video, {
        muted: video.muted,
        volume: video.volume
      });
    }
  }

  function normalizeMode(mode) {
    return mode === "volume" || mode === "initialMute" ? mode : "mute";
  }

  function enforce(video) {
    if (!settings.enabled || !isTargetVideo(video)) {
      restore(video);
      return;
    }

    remember(video);
    if (settings.mode === "mute") {
      if (!video.muted) video.muted = true;
      return;
    }

    if (settings.mode === "initialMute") {
      if (!initialMuteReleased.has(video) && !video.muted) video.muted = true;
      return;
    }

    const targetVolume = Math.min(1, Math.max(0, settings.volume / 100));
    if (video.muted) video.muted = false;
    if (Math.abs(video.volume - targetVolume) > 0.001) {
      video.volume = targetVolume;
    }
  }

  function restore(video) {
    const original = originals.get(video);
    if (!original) return;

    // Remove tracking first so a volumechange event caused by restoration
    // cannot immediately re-apply the extension setting.
    originals.delete(video);
    initialMuteReleased.delete(video);
    video.muted = original.muted;
    video.volume = original.volume;
  }

  function ensureIndicator() {
    if (indicatorHost?.isConnected) return true;
    if (!document.body || typeof document.createElement !== "function") return false;

    indicatorHost = document.createElement("div");
    indicatorHost.id = "netflix-autoplay-volume-indicator-host";
    const shadow = indicatorHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .badge {
        position: fixed;
        z-index: 2147483647;
        display: none;
        align-items: center;
        gap: 5px;
        padding: 5px 8px;
        border: 1px solid rgba(255, 255, 255, .28);
        border-radius: 999px;
        background: rgba(18, 18, 18, .88);
        box-shadow: 0 2px 8px rgba(0, 0, 0, .45);
        color: #fff;
        font: 600 11px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: .01em;
        pointer-events: auto;
        transform: translate(-100%, -50%);
        cursor: help;
        user-select: none;
        white-space: nowrap;
        backdrop-filter: blur(4px);
      }
    `;
    indicatorBadge = document.createElement("div");
    indicatorBadge.className = "badge";
    indicatorBadge.setAttribute("role", "status");
    indicatorBadge.innerHTML = '<span class="label"></span>';
    shadow.append(style, indicatorBadge);
    document.body.append(indicatorHost);
    return true;
  }

  function getVisibleRect(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") return null;
    if (typeof element.checkVisibility === "function" && !element.checkVisibility({
      checkOpacity: true,
      checkVisibilityCSS: true
    })) return null;

    // checkVisibility is available in current Chrome. Keep this fallback for
    // older releases and for elements hidden through an ancestor.
    if (typeof getComputedStyle === "function") {
      for (let node = element; node instanceof Element; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
          return null;
        }
      }
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 ||
        rect.bottom <= 0 || rect.right <= 0 ||
        rect.top >= window.innerHeight || rect.left >= window.innerWidth) return null;
    return rect;
  }

  function chooseVisibleTarget(targets) {
    let candidates = [...targets];
    if (isDetailsPreviewOpen()) {
      candidates = candidates.filter((video) => video.closest(
        ".previewModal--container,.previewModal--player_container,[class*='previewModal'],[role='dialog']"
      ));
    }

    let best;
    let bestScore = -1;
    for (const video of candidates) {
      const rect = getVisibleRect(video);
      if (!rect) continue;
      const isDialogPreview = Boolean(video.closest(
        ".previewModal--container,.previewModal--player_container,[class*='previewModal'],[role='dialog']"
      ));
      const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
      const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
      const modalBonus = isDialogPreview ? 1e9 : 0;
      const score = visibleWidth * visibleHeight + modalBonus;
      if (score > bestScore) {
        best = { video, rect };
        bestScore = score;
      }
    }
    return best;
  }

  function findAudioButton(video, videoRect) {
    const scope = video.closest(
      ".previewModal--container,[role='dialog'],.billboard-row,.billboard,[data-uia*='billboard'],[class*='billboard']"
    ) || video.parentElement;
    if (!scope || typeof scope.querySelectorAll !== "function") return null;

    let closest;
    let closestDistance = Infinity;
    for (const button of scope.querySelectorAll(AUDIO_BUTTON_SELECTOR)) {
      const rect = getVisibleRect(button);
      if (!rect) continue;
      const distance = Math.abs(videoRect.right - rect.right) + Math.abs(videoRect.bottom - rect.bottom);
      if (distance < closestDistance) {
        closest = rect;
        closestDistance = distance;
      }
    }
    return closest;
  }

  function hideIndicator() {
    if (indicatorBadge) indicatorBadge.style.display = "none";
  }

  function updateIndicator(targets = new Set(originals.keys())) {
    if (!settings.enabled || !settings.showIndicator || isPlaybackRoute() || !ensureIndicator()) {
      hideIndicator();
      return;
    }

    const target = chooseVisibleTarget(targets);
    if (!target) {
      hideIndicator();
      return;
    }

    const isDialogPreview = Boolean(target.video.closest(
      ".previewModal--container,.previewModal--player_container,[class*='previewModal'],[role='dialog']"
    ));
    const isSmallCard = !isDialogPreview && target.rect.width < window.innerWidth * 0.5;
    const audioButtonRect = isSmallCard ? null : findAudioButton(target.video, target.rect);

    // Netflix briefly replaces the audio control while a hover-card video is
    // playing. Use a fixed corner offset there so detection changes cannot
    // make the badge jump between two positions.
    const left = isSmallCard
      ? target.rect.right - 60
      : audioButtonRect
        ? audioButtonRect.left - 6
        : target.rect.right - 18;
    const top = isSmallCard
      ? target.rect.bottom - 32
      : audioButtonRect
        ? audioButtonRect.top + audioButtonRect.height / 2
        : target.rect.bottom - 62;
    const roundedVolume = Math.round(settings.volume);
    const speakerIcon = roundedVolume === 0 ? "🔇" : roundedVolume < 50 ? "🔉" : "🔊";
    let label;
    let title;
    if (settings.mode === "mute") {
      label = "🔇 常にミュート";
      title = "拡張機能により常にミュート中";
    } else if (settings.mode === "initialMute") {
      label = target.video.muted ? "🔇 開始時ミュート" : "🔊 解除済み";
      title = target.video.muted
        ? "Netflixの音声ボタンで解除できます"
        : "Netflixの音声ボタンでミュート解除済み";
    } else {
      label = `${speakerIcon} ${roundedVolume}%`;
      title = `拡張機能により音量を${roundedVolume}%に固定中`;
    }

    indicatorBadge.querySelector(".label").textContent = label;
    indicatorBadge.title = title;
    indicatorBadge.style.left = `${Math.max(8, left)}px`;
    indicatorBadge.style.top = `${Math.max(16, top)}px`;
    indicatorBadge.style.display = "flex";
  }

  function scheduleIndicatorUpdate() {
    if (indicatorFramePending) return;
    indicatorFramePending = true;
    requestAnimationFrame(() => {
      indicatorFramePending = false;
      updateIndicator();
    });
  }

  function applyToPage() {
    scheduled = false;

    if (isPlaybackRoute() || !settings.enabled) {
      for (const video of [...originals.keys()]) restore(video);
      updateIndicator(new Set());
      return;
    }

    const currentTargets = new Set();
    for (const container of document.querySelectorAll(AUTOPLAY_CONTAINER_SELECTOR)) {
      if (container instanceof HTMLVideoElement) {
        currentTargets.add(container);
      } else {
        for (const video of container.querySelectorAll("video")) {
          currentTargets.add(video);
        }
      }
    }

    // The jbv query parameter identifies Netflix's title-details modal. The
    // dialog fallback keeps this working if Netflix renames previewModal.
    if (isDetailsPreviewOpen()) {
      for (const video of document.querySelectorAll("[role='dialog'] video")) {
        currentTargets.add(video);
      }
    }

    for (const video of currentTargets) enforce(video);
    for (const video of [...originals.keys()]) {
      if (!currentTargets.has(video) || !video.isConnected) restore(video);
    }
    updateIndicator(currentTargets);
  }

  function scheduleApply() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(applyToPage);
  }

  function handleMediaEvent(event) {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement) ||
        (!originals.has(video) && !isTargetVideo(video)) ||
        pendingMediaEnforcement.has(video)) return;

    // This listener runs during capture. Netflix's own button handler can run
    // afterward and overwrite muted/volume, so enforce on the next frame.
    pendingMediaEnforcement.add(video);
    requestAnimationFrame(() => {
      pendingMediaEnforcement.delete(video);
      enforce(video);
      scheduleIndicatorUpdate();
    });
  }

  function handleAudioButtonClick(event) {
    if (!settings.enabled || settings.mode !== "initialMute") return;

    const clicked = event.target;
    if (!clicked || typeof clicked.closest !== "function") return;
    const button = clicked.closest(AUDIO_BUTTON_SELECTOR);
    if (!button) return;

    const scope = button.closest(
      ".previewModal--container,[role='dialog'],.billboard-row,.billboard,[data-uia*='billboard'],[class*='billboard']"
    ) || button.parentElement;
    if (!scope || typeof scope.querySelectorAll !== "function") return;

    for (const video of scope.querySelectorAll("video")) {
      if (isTargetVideo(video)) initialMuteReleased.add(video);
    }

    // Netflix changes the media state in its own click handler, which runs
    // after this capture listener. Refresh the badge once that change lands.
    requestAnimationFrame(scheduleIndicatorUpdate);
  }

  async function loadSettings() {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    settings = {
      enabled: Boolean(stored.enabled),
      mode: normalizeMode(stored.mode),
      volume: Number.isFinite(Number(stored.volume))
        ? Math.min(100, Math.max(0, Number(stored.volume)))
        : DEFAULT_SETTINGS.volume,
      showIndicator: stored.showIndicator !== false
    };
    scheduleApply();
  }

  function start() {
    observer = new MutationObserver(scheduleApply);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-uia"]
    });

    // React may update the media state after rendering. Capture these events
    // so the selected setting remains stable without polling every video.
    document.addEventListener("play", handleMediaEvent, true);
    document.addEventListener("loadedmetadata", handleMediaEvent, true);
    document.addEventListener("volumechange", handleMediaEvent, true);
    document.addEventListener("click", handleAudioButtonClick, true);

    window.addEventListener("resize", scheduleIndicatorUpdate, { passive: true });
    window.addEventListener("scroll", scheduleIndicatorUpdate, { passive: true, capture: true });

    // Netflix uses client-side navigation. Watching location.href alongside
    // DOM mutations lets us restore before a reused element becomes playback.
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        applyToPage();
      }
    }, 250);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;

      if (changes.enabled) settings.enabled = Boolean(changes.enabled.newValue);
      if (changes.mode) settings.mode = normalizeMode(changes.mode.newValue);
      if (changes.volume) {
        settings.volume = Math.min(100, Math.max(0, Number(changes.volume.newValue) || 0));
      }
      if (changes.showIndicator) {
        settings.showIndicator = changes.showIndicator.newValue !== false;
      }
      applyToPage();
    });

    loadSettings();
  }

  if (document.documentElement) {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }
})();
