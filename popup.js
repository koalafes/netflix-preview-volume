(() => {
  "use strict";

  const DEFAULT_SETTINGS = {
    enabled: true,
    mode: "mute",
    volume: 20,
    showIndicator: true
  };

  const enabled = document.querySelector("#enabled");
  const controls = document.querySelector("#controls");
  const volume = document.querySelector("#volume");
  const volumeValue = document.querySelector("#volumeValue");
  const showIndicator = document.querySelector("#showIndicator");
  const status = document.querySelector("#status");
  const modeInputs = [...document.querySelectorAll("input[name='mode']")];
  let statusTimer;

  function selectedMode() {
    return modeInputs.find((input) => input.checked)?.value || "mute";
  }

  function updateUi() {
    controls.disabled = !enabled.checked;
    volume.disabled = !enabled.checked || selectedMode() !== "volume";
    volumeValue.textContent = `${volume.value}%`;
  }

  function showSaved() {
    status.textContent = "設定を保存しました";
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      status.textContent = "";
    }, 1000);
  }

  async function save(patch) {
    await chrome.storage.sync.set(patch);
    showSaved();
  }

  enabled.addEventListener("change", () => {
    updateUi();
    save({ enabled: enabled.checked });
  });

  for (const input of modeInputs) {
    input.addEventListener("change", () => {
      updateUi();
      save({ mode: selectedMode() });
    });
  }

  volume.addEventListener("input", updateUi);
  volume.addEventListener("change", () => save({ volume: Number(volume.value) }));
  showIndicator.addEventListener("change", () => {
    save({ showIndicator: showIndicator.checked });
  });

  chrome.storage.sync.get(DEFAULT_SETTINGS).then((stored) => {
    enabled.checked = Boolean(stored.enabled);
    showIndicator.checked = stored.showIndicator !== false;
    volume.value = String(Math.min(100, Math.max(0, Number(stored.volume) || 0)));
    const mode = stored.mode === "volume" ? "volume" : "mute";
    document.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;
    updateUi();
  });
})();
