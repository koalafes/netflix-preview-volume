const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const contentScript = fs.readFileSync(
  path.join(__dirname, "..", "content.js"),
  "utf8"
);

class FakeVideo {
  constructor({ target = false, dialog = false, muted = false, volume = 1 } = {}) {
    this.target = target;
    this.dialog = dialog;
    this.muted = muted;
    this.volume = volume;
    this.isConnected = true;
    this.visible = true;
    this.rect = { left: 100, top: 100, right: 900, bottom: 550, width: 800, height: 450 };
  }

  closest(selector) {
    if (selector === "[role='dialog']") return this.dialog ? {} : null;
    if (selector.includes("[class*='previewModal']") && selector.includes("[role='dialog']")) {
      return this.dialog ? {} : null;
    }
    return this.target ? {} : null;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  checkVisibility() {
    return this.visible;
  }
}

function createHarness(stored = {}, { details = false, dialogFallback = false, ui = false } = {}) {
  const hero = new FakeVideo({ target: true, muted: false, volume: 0.8 });
  const detailsPreview = new FakeVideo({
    target: details && !dialogFallback,
    dialog: details,
    muted: false,
    volume: 0.6
  });
  const regular = new FakeVideo({ muted: false, volume: 0.7 });
  const listeners = {};
  const animationFrames = [];
  const createdElements = [];
  let intervalCallback;

  function createElement(tagName) {
    const label = { textContent: "" };
    const element = {
      tagName,
      style: {},
      isConnected: false,
      children: [],
      append(...children) {
        this.children.push(...children);
      },
      attachShadow() {
        const shadow = {
          children: [],
          append(...children) {
            this.children.push(...children);
          }
        };
        this.shadow = shadow;
        return shadow;
      },
      setAttribute(name, value) {
        this[name] = value;
      },
      querySelector(selector) {
        return selector === ".label" ? label : null;
      },
      get label() {
        return label;
      }
    };
    createdElements.push(element);
    return element;
  }

  const heroContainer = {
    querySelectorAll(selector) {
      return selector === "video" ? [hero] : [];
    }
  };
  const detailsContainer = {
    querySelectorAll(selector) {
      return selector === "video" ? [detailsPreview] : [];
    }
  };

  const location = {
    href: details
      ? "https://www.netflix.com/browse?jbv=12345"
      : "https://www.netflix.com/browse",
    pathname: "/browse",
    search: details ? "?jbv=12345" : ""
  };

  const context = {
    HTMLVideoElement: FakeVideo,
    URLSearchParams,
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        listeners.mutation = callback;
      }
      observe() {}
    },
    chrome: {
      storage: {
        sync: {
          get: async (defaults) => ({ ...defaults, ...stored })
        },
        onChanged: {
          addListener(callback) {
            listeners.storage = callback;
          }
        }
      }
    },
    document: {
      documentElement: {},
      body: ui ? {
        append(element) {
          element.isConnected = true;
        }
      } : undefined,
      createElement: ui ? createElement : undefined,
      querySelectorAll(selector) {
        if (selector === "[role='dialog'] video") {
          return details && dialogFallback ? [detailsPreview] : [];
        }
        return details && !dialogFallback
          ? [heroContainer, detailsContainer]
          : [heroContainer];
      },
      addEventListener(type, callback) {
        listeners[type] = callback;
      }
    },
    location,
    window: {
      innerWidth: 1280,
      innerHeight: 720,
      addEventListener(type, callback) {
        listeners[`window:${type}`] = callback;
      }
    },
    requestAnimationFrame(callback) {
      animationFrames.push(callback);
    },
    setInterval(callback) {
      intervalCallback = callback;
      return 1;
    },
    console
  };

  vm.runInNewContext(contentScript, context);

  return {
    context,
    hero,
    detailsPreview,
    regular,
    listeners,
    createdElements,
    navigate(pathname) {
      context.location.pathname = pathname;
      context.location.search = "";
      context.location.href = `https://www.netflix.com${pathname}`;
      intervalCallback();
    },
    flushAnimationFrames() {
      while (animationFrames.length) {
        for (const callback of animationFrames.splice(0)) callback();
      }
    },
    async settle() {
      await new Promise((resolve) => setImmediate(resolve));
      this.flushAnimationFrames();
    }
  };
}

test("default setting mutes only the billboard video", async () => {
  const harness = createHarness();
  await harness.settle();

  assert.equal(harness.hero.muted, true);
  assert.equal(harness.hero.volume, 0.8);
  assert.equal(harness.regular.muted, false);
  assert.equal(harness.regular.volume, 0.7);
});

test("volume setting applies while initial mute remains active", async () => {
  const harness = createHarness({ mode: "initialMute", volumeEnabled: true, volume: 15 });
  await harness.settle();

  assert.equal(harness.hero.muted, true);
  assert.equal(harness.hero.volume, 0.15);
});

test("disabling the separate volume setting restores the original volume", async () => {
  const harness = createHarness({ mode: "initialMute", volumeEnabled: true, volume: 15 });
  await harness.settle();
  assert.equal(harness.hero.volume, 0.15);

  harness.listeners.storage(
    { volumeEnabled: { oldValue: true, newValue: false } },
    "sync"
  );

  assert.equal(harness.hero.muted, true);
  assert.equal(harness.hero.volume, 0.8);
});

test("title-details autoplay preview uses the same mute setting", async () => {
  const harness = createHarness({}, { details: true });
  await harness.settle();

  assert.equal(harness.detailsPreview.muted, true);
  assert.equal(harness.detailsPreview.volume, 0.6);
});

test("jbv dialog fallback works if Netflix renames the preview classes", async () => {
  const harness = createHarness({}, { details: true, dialogFallback: true });
  await harness.settle();

  assert.equal(harness.detailsPreview.muted, true);
});

test("always mute cannot be overwritten by Netflix's native audio button", async () => {
  const harness = createHarness({ mode: "mute" }, { details: true });
  await harness.settle();
  assert.equal(harness.detailsPreview.muted, true);

  // The extension listens in capture phase; Netflix's handler runs afterward.
  harness.listeners.volumechange({ target: harness.detailsPreview });
  harness.detailsPreview.muted = false;
  assert.equal(harness.detailsPreview.muted, false);

  harness.flushAnimationFrames();
  assert.equal(harness.detailsPreview.muted, true);
});

test("initial mute allows Netflix's native audio button to enable sound", async () => {
  const harness = createHarness({ mode: "initialMute" }, { details: true });
  await harness.settle();
  assert.equal(harness.detailsPreview.muted, true);

  const previewScope = {
    querySelectorAll(selector) {
      return selector === "video" ? [harness.detailsPreview] : [];
    }
  };
  const audioButton = {
    closest(selector) {
      if (selector.includes("button[data-uia='control-audio']")) return this;
      if (selector.includes(".previewModal--container")) return previewScope;
      return null;
    }
  };

  // Capture listener marks this preview as user-controlled before Netflix's
  // own handler unmutes it and emits volumechange.
  harness.listeners.click({ target: audioButton });
  harness.detailsPreview.muted = false;
  harness.listeners.volumechange({ target: harness.detailsPreview });
  harness.flushAnimationFrames();

  assert.equal(harness.detailsPreview.muted, false);
});

test("shows an extension-owned status badge for the controlled preview", async () => {
  const harness = createHarness({}, { ui: true });
  await harness.settle();

  const badge = harness.createdElements.find((element) => element.className === "badge");
  assert.ok(badge);
  assert.equal(badge.innerHTML, '<span class="label"></span>');
  assert.equal(badge.label.textContent, "🔇 開始時ミュート");
  assert.equal(badge.style.display, "flex");
  assert.equal(badge.title, "Netflixの音声ボタンで解除できます");
});

test("initial mute badge reflects when the native button releases mute", async () => {
  const harness = createHarness({ mode: "initialMute" }, { details: true, ui: true });
  await harness.settle();
  const badge = harness.createdElements.find((element) => element.className === "badge");
  assert.equal(badge.label.textContent, "🔇 開始時ミュート");

  const previewScope = {
    querySelectorAll(selector) {
      return selector === "video" ? [harness.detailsPreview] : [];
    }
  };
  const audioButton = {
    closest(selector) {
      if (selector.includes("button[data-uia='control-audio']")) return this;
      if (selector.includes(".previewModal--container")) return previewScope;
      return null;
    }
  };
  harness.listeners.click({ target: audioButton });
  harness.detailsPreview.muted = false;
  harness.listeners.volumechange({ target: harness.detailsPreview });
  harness.flushAnimationFrames();

  assert.equal(badge.label.textContent, "🔊 解除済み");
});

test("shows a speaker icon with the selected volume percentage", async () => {
  const harness = createHarness(
    { mode: "initialMute", volumeEnabled: true, volume: 20 },
    { ui: true }
  );
  await harness.settle();

  const badge = harness.createdElements.find((element) => element.className === "badge");
  const previewScope = {
    querySelectorAll(selector) {
      return selector === "video" ? [harness.hero] : [];
    }
  };
  const audioButton = {
    closest(selector) {
      if (selector.includes("button[data-uia='control-audio']")) return this;
      if (selector.includes(".previewModal--container")) return previewScope;
      return null;
    }
  };
  harness.listeners.click({ target: audioButton });
  harness.hero.muted = false;
  harness.listeners.volumechange({ target: harness.hero });
  harness.flushAnimationFrames();

  assert.equal(badge.label.textContent, "🔉 20%");
  assert.equal(badge.title, "プレビューの音量を20%に設定中");
});

test("can hide the status badge without disabling mute control", async () => {
  const harness = createHarness({ showIndicator: false }, { ui: true });
  await harness.settle();

  const badge = harness.createdElements.find((element) => element.className === "badge");
  assert.equal(badge, undefined);
  assert.equal(harness.hero.muted, true);
});

test("repositions the badge when the visible preview moves", async () => {
  const harness = createHarness({}, { ui: true });
  await harness.settle();
  const badge = harness.createdElements.find((element) => element.className === "badge");
  assert.equal(badge.style.left, "882px");

  harness.hero.rect = { left: 100, top: 100, right: 800, bottom: 500, width: 700, height: 400 };
  harness.listeners.mutation();
  harness.flushAnimationFrames();
  assert.equal(badge.style.left, "782px");
});

test("shows the status badge on a visible small hover-card preview", async () => {
  const harness = createHarness({}, { ui: true });
  harness.hero.rect = { left: 250, top: 250, right: 650, bottom: 500, width: 400, height: 250 };
  await harness.settle();

  const badge = harness.createdElements.find((element) => element.className === "badge");
  assert.ok(badge);
  assert.equal(badge.style.display, "flex");
  assert.equal(badge.style.left, "590px");
  assert.equal(badge.style.top, "468px");
  assert.equal(harness.hero.muted, true);
});

test("hides the status badge when a hover-card preview becomes hidden", async () => {
  const harness = createHarness({}, { ui: true });
  harness.hero.rect = { left: 250, top: 250, right: 650, bottom: 500, width: 400, height: 250 };
  await harness.settle();
  const badge = harness.createdElements.find((element) => element.className === "badge");
  assert.equal(badge.style.display, "flex");

  harness.hero.visible = false;
  harness.listeners.mutation();
  harness.flushAnimationFrames();
  assert.equal(badge.style.display, "none");
});

test("entering a watch route restores the original media state", async () => {
  const harness = createHarness({ mode: "volume", volume: 10 });
  await harness.settle();
  assert.equal(harness.hero.volume, 0.1);

  harness.navigate("/watch/12345");

  assert.equal(harness.hero.muted, false);
  assert.equal(harness.hero.volume, 0.8);
});

test("disabling the extension restores the original media state", async () => {
  const harness = createHarness();
  await harness.settle();
  assert.equal(harness.hero.muted, true);

  harness.listeners.storage(
    { enabled: { oldValue: true, newValue: false } },
    "sync"
  );

  assert.equal(harness.hero.muted, false);
  assert.equal(harness.hero.volume, 0.8);
});
