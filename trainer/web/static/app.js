"use strict";

const actionLabels = {
  setup: "安装训练环境",
  "preview-word": "检查唤醒词发音",
  "generate-samples": "生成训练样本",
  "download-data": "下载背景与负样本",
  "preview-augment": "试听增强样本",
  "build-features": "构建频谱特征",
  train: "训练与量化",
  export: "导出 ESPHome 模型",
  all: "运行数据与训练流程",
};

const jobStateLabels = {
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已停止",
};

const stepOrder = [
  "setup",
  "preview-word",
  "generate-samples",
  "download-data",
  "preview-augment",
  "build-features",
  "train",
  "export",
];

const state = {
  status: null,
  jobRunning: false,
  configDirty: false,
  lastFinishedJob: null,
  toastTimer: null,
  polling: false,
};

const elements = {
  serverStatus: document.querySelector("#server-status"),
  serverStatusText: document.querySelector("#server-status .status-text"),
  targetWord: document.querySelector("#target-word"),
  runtimeMode: document.querySelector("#runtime-mode"),
  diskFree: document.querySelector("#disk-free"),
  configError: document.querySelector("#config-error"),
  configErrorMessage: document.querySelector("#config-error-message"),
  runAll: document.querySelector("#run-all-button"),
  runNext: document.querySelector("#run-next-button"),
  cancel: document.querySelector("#cancel-button"),
  jobEmpty: document.querySelector("#job-empty"),
  jobActive: document.querySelector("#job-active"),
  jobAction: document.querySelector("#job-action"),
  jobState: document.querySelector("#job-state"),
  jobLog: document.querySelector("#job-log"),
  wordAudioCard: document.querySelector("#word-audio-card"),
  wordAudio: document.querySelector("#word-audio"),
  augmentAudioCard: document.querySelector("#augment-audio-card"),
  augmentAudio: document.querySelector("#augment-audio"),
  audioEmpty: document.querySelector("#audio-empty"),
  modelPanel: document.querySelector("#model-panel"),
  modelDownload: document.querySelector("#model-download"),
  manifestDownload: document.querySelector("#manifest-download"),
  rocDownload: document.querySelector("#roc-download"),
  sampleDescription: document.querySelector("#sample-description"),
  configEditor: document.querySelector("#config-editor"),
  configPath: document.querySelector("#config-path"),
  configSaveStatus: document.querySelector("#config-save-status"),
  saveConfig: document.querySelector("#save-config-button"),
  toast: document.querySelector("#toast"),
  probabilityCutoff: document.querySelector("#probability-cutoff"),
  tensorArenaSize: document.querySelector("#tensor-arena-size"),
  exportAuthor: document.querySelector("#export-author"),
  exportWebsite: document.querySelector("#export-website"),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  let body = null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    body = await response.json();
  } else {
    body = await response.text();
  }

  if (!response.ok) {
    const detail = body && typeof body === "object" ? body.detail : body;
    throw new Error(typeof detail === "string" ? detail : `请求失败（${response.status}）`);
  }
  return body;
}

function showToast(message, type = "success") {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.dataset.state = type;
  elements.toast.hidden = false;
  state.toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 4200);
}

function setServerStatus(label, status) {
  elements.serverStatus.dataset.state = status;
  elements.serverStatusText.textContent = label;
}

function allActionButtons() {
  return document.querySelectorAll("[data-action]");
}

function updateButtonState() {
  allActionButtons().forEach((button) => {
    button.disabled = state.jobRunning;
  });
  elements.saveConfig.disabled = state.jobRunning;
  elements.runNext.disabled = state.jobRunning;
}

function renderSteps(steps) {
  stepOrder.forEach((stepId) => {
    const card = document.querySelector(`[data-step="${stepId}"]`);
    if (!card) return;
    const step = steps[stepId] || { done: false };
    card.dataset.done = String(Boolean(step.done));
    const badge = card.querySelector(".step-state");
    badge.textContent = step.done ? "已完成" : stepId === "preview-augment" ? "可选" : "待运行";
  });

  const sampleCount = steps["generate-samples"]?.sample_count || 0;
  elements.sampleDescription.textContent = sampleCount
    ? `当前工作区已有 ${sampleCount.toLocaleString("zh-CN")} 条唤醒词样本。`
    : "使用 Piper 生成完整的多说话人和多语速样本集。";
}

function renderJob(job) {
  const running = Boolean(job && job.status === "running");
  state.jobRunning = running;
  updateButtonState();

  if (!job) {
    elements.jobEmpty.hidden = false;
    elements.jobActive.hidden = true;
    elements.cancel.hidden = true;
    return;
  }

  elements.jobEmpty.hidden = true;
  elements.jobActive.hidden = false;
  elements.cancel.hidden = !running;
  elements.jobAction.textContent = actionLabels[job.action] || job.action;
  elements.jobState.textContent = jobStateLabels[job.status] || job.status;
  elements.jobState.dataset.state = job.status;

  const nearBottom =
    elements.jobLog.scrollHeight - elements.jobLog.scrollTop - elements.jobLog.clientHeight < 80;
  if (elements.jobLog.textContent !== job.log) {
    elements.jobLog.textContent = job.log || "任务正在启动，等待日志…";
    if (nearBottom || running) {
      elements.jobLog.scrollTop = elements.jobLog.scrollHeight;
    }
  }

  const finishedKey = `${job.id}:${job.status}`;
  if (!running && state.lastFinishedJob !== finishedKey) {
    state.lastFinishedJob = finishedKey;
    if (job.status === "succeeded") {
      showToast(`${actionLabels[job.action] || job.action}已完成`);
    } else if (job.status === "failed") {
      showToast("任务执行失败，请查看日志定位原因", "error");
    } else if (job.status === "cancelled") {
      showToast("任务已停止", "error");
    }
  }
}

function setAudio(card, player, artifact) {
  if (!artifact) {
    card.hidden = true;
    player.removeAttribute("src");
    return false;
  }
  if (player.getAttribute("src") !== artifact.url) {
    player.src = artifact.url;
  }
  card.hidden = false;
  return true;
}

function renderArtifacts(artifacts = {}) {
  const hasWord = setAudio(elements.wordAudioCard, elements.wordAudio, artifacts["word-preview"]);
  const hasAugment = setAudio(
    elements.augmentAudioCard,
    elements.augmentAudio,
    artifacts["augmentation-preview"],
  );
  elements.audioEmpty.hidden = hasWord || hasAugment;

  const hasModel = Boolean(artifacts.model);
  elements.modelPanel.hidden = !hasModel && !artifacts.manifest;
  if (hasModel) {
    elements.modelDownload.hidden = false;
    elements.modelDownload.href = artifacts.model.url;
    elements.modelDownload.querySelector("span:first-child").textContent =
      `TFLite 模型 · ${formatBytes(artifacts.model.size)}`;
  } else {
    elements.modelDownload.hidden = true;
  }
  if (artifacts.manifest) {
    elements.manifestDownload.hidden = false;
    elements.manifestDownload.href = artifacts.manifest.url;
  } else {
    elements.manifestDownload.hidden = true;
  }
  if (artifacts.roc) {
    elements.rocDownload.hidden = false;
    elements.rocDownload.href = artifacts.roc.url;
  } else {
    elements.rocDownload.hidden = true;
  }
}

function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderStatus(data) {
  state.status = data;
  renderJob(data.job);
  setServerStatus(
    data.job?.status === "running" ? "任务运行中" : "服务就绪",
    data.job?.status === "running" ? "running" : "ready",
  );

  if (data.config_error) {
    elements.configError.hidden = false;
    elements.configErrorMessage.textContent = data.config_error;
    elements.targetWord.textContent = "配置错误";
    setServerStatus("配置错误", "error");
    return;
  }

  elements.configError.hidden = true;
  elements.targetWord.textContent = data.wake_word.phonetic;
  elements.runtimeMode.textContent = data.runtime.mode;
  elements.diskFree.textContent = `${data.disk_free_gb.toLocaleString("zh-CN")} GB`;
  renderSteps(data.steps || {});
  renderArtifacts(data.artifacts);
}

async function refreshStatus() {
  if (state.polling) return;
  state.polling = true;
  try {
    const data = await api("/api/status");
    renderStatus(data);
  } catch (error) {
    setServerStatus("连接失败", "error");
    if (!state.status) {
      elements.configErrorMessage.textContent = error.message;
      elements.configError.hidden = false;
    }
  } finally {
    state.polling = false;
  }
}

async function loadConfig() {
  try {
    const data = await api("/api/config");
    elements.configEditor.value = data.content;
    elements.configPath.textContent = data.path;
    state.configDirty = false;
  } catch (error) {
    elements.configSaveStatus.textContent = error.message;
    elements.configSaveStatus.dataset.state = "error";
  }
}

async function startAction(action, overrides = {}) {
  if (state.jobRunning) return;

  const payload = {
    action,
    probability_cutoff: Number(elements.probabilityCutoff.value || 0.5),
    tensor_arena_size: Number(elements.tensorArenaSize.value || 30000),
    author: elements.exportAuthor.value.trim(),
    website: elements.exportWebsite.value.trim(),
    ...overrides,
  };

  state.jobRunning = true;
  updateButtonState();
  try {
    await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    showToast(`已启动：${actionLabels[action] || action}`);
    await refreshStatus();
  } catch (error) {
    state.jobRunning = false;
    updateButtonState();
    showToast(error.message, "error");
  }
}

function findNextAction(status) {
  const steps = status?.steps || {};
  if (!steps.setup?.done) return "setup";
  if (!steps["preview-word"]?.done) return "preview-word";
  if (!steps["generate-samples"]?.done) return "generate-samples";
  if (!steps["download-data"]?.done) return "download-data";
  if (!steps["build-features"]?.done) return "build-features";
  if (!steps.train?.done) return "train";
  if (!steps.export?.done) return "export";
  return "export";
}

async function saveConfig() {
  elements.saveConfig.disabled = true;
  elements.configSaveStatus.textContent = "正在验证并保存…";
  elements.configSaveStatus.dataset.state = "";
  try {
    await api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ content: elements.configEditor.value }),
    });
    state.configDirty = false;
    elements.configSaveStatus.textContent = "配置已保存";
    elements.configSaveStatus.dataset.state = "success";
    showToast("配置已保存");
    await refreshStatus();
  } catch (error) {
    elements.configSaveStatus.textContent = error.message;
    elements.configSaveStatus.dataset.state = "error";
    showToast("配置未保存，请修正后重试", "error");
  } finally {
    elements.saveConfig.disabled = state.jobRunning;
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  startAction(button.dataset.action, {
    no_train: button.dataset.noTrain === "true",
  });
});

elements.runNext.addEventListener("click", () => {
  if (!state.status) return;
  startAction(findNextAction(state.status));
});

elements.cancel.addEventListener("click", async () => {
  const job = state.status?.job;
  if (!job) return;
  if (!window.confirm("停止当前任务？已写入的文件会保留，之后可以安全重跑。")) return;
  try {
    await api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    showToast("已请求停止任务");
    await refreshStatus();
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.saveConfig.addEventListener("click", saveConfig);

elements.configEditor.addEventListener("input", () => {
  state.configDirty = true;
  elements.configSaveStatus.textContent = "有未保存的修改";
  elements.configSaveStatus.dataset.state = "";
});

window.addEventListener("beforeunload", (event) => {
  if (!state.configDirty) return;
  event.preventDefault();
  event.returnValue = "";
});

Promise.all([refreshStatus(), loadConfig()]).then(() => {
  updateButtonState();
  window.setInterval(refreshStatus, 3000);
});
