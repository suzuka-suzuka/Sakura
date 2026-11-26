"use strict";

(function () {
  const TOKEN_KEY = "sakura-private-chat-token";
  const $ = (id) => document.getElementById(id);

  const views = {
    loading: $("loadingView"),
    login: $("loginView"),
    settings: $("settingsView"),
  };
  const el = {
    account: $("account"),
    accountId: $("accountId"),
    logout: $("logoutButton"),
    loginForm: $("loginForm"),
    codeInput: $("codeInput"),
    loginButton: $("loginButton"),
    loginMessage: $("loginMessage"),
    statusBox: $("statusBox"),
    statusText: $("statusText"),
    persona: $("personaInput"),
    personaCounter: $("personaCounter"),
    presets: $("presets"),
    baseURL: $("baseURLInput"),
    apiKey: $("apiKeyInput"),
    apiKeyHint: $("apiKeyHint"),
    model: $("modelInput"),
    modelList: $("modelList"),
    modelHint: $("modelHint"),
    fetchModels: $("fetchModelsButton"),
    test: $("testButton"),
    testMessage: $("testMessage"),
    historyText: $("historyText"),
    clearHistory: $("clearHistoryButton"),
    saveButton: $("saveButton"),
    saveMessage: $("saveMessage"),
  };

  let profile = null;
  let dirty = false;

  function readToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
  }
  function writeToken(token) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch { /* 无痕模式等情况下存不了，只影响下次是否要重新登录 */ }
  }

  function show(name) {
    for (const [key, view] of Object.entries(views)) view.hidden = key !== name;
    el.account.hidden = name !== "settings";
  }

  function setMessage(node, text, tone) {
    node.textContent = text || "";
    node.dataset.tone = tone || "";
  }

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  async function api(path, { method = "GET", body } = {}) {
    const headers = {};
    const token = readToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
    } catch {
      throw new ApiError(0, "网络连接失败，请检查网络后重试");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        writeToken("");
        dirty = false;
        showLogin(data.error || "登录已失效，请重新登录");
      }
      throw new ApiError(response.status, data.error || `请求失败（${response.status}）`);
    }
    return data;
  }

  async function withBusy(button, task) {
    if (button.disabled) return;
    button.disabled = true;
    try { await task(); } finally { button.disabled = false; }
  }

  // ---- 登录 ----

  function showLogin(message) {
    profile = null;
    show("login");
    setMessage(el.loginMessage, message || "", message ? "error" : "");
    el.codeInput.focus();
  }

  async function login(code) {
    setMessage(el.loginMessage, "登录中…");
    try {
      const data = await api("api/login", { method: "POST", body: { code } });
      writeToken(data.token);
      el.codeInput.value = "";
      setMessage(el.loginMessage, "");
      renderProfile(data.profile, { resetForm: true });
      show("settings");
    } catch (error) {
      show("login");
      setMessage(el.loginMessage, error.message, "error");
    }
  }

  el.loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = el.codeInput.value.trim();
    if (!code) {
      setMessage(el.loginMessage, "请填写登录码", "error");
      return;
    }
    withBusy(el.loginButton, () => login(code));
  });

  el.logout.addEventListener("click", async () => {
    if (dirty && !confirm("还有没保存的修改，确定退出吗？")) return;
    try { await api("api/logout", { method: "POST" }); } catch { /* 本地退出即可 */ }
    writeToken("");
    dirty = false;
    showLogin("");
  });

  // ---- 设置 ----

  function readyMissing(p) {
    const missing = [];
    if (!p.persona.trim()) missing.push("人设");
    if (!p.baseURL) missing.push("接口地址");
    if (!p.hasApiKey) missing.push("API Key");
    if (!p.model) missing.push("模型");
    return missing;
  }

  function renderStatus() {
    if (!profile) return;
    const missing = readyMissing(profile);
    const ready = missing.length === 0;
    el.statusBox.dataset.state = ready ? "ready" : "pending";
    el.statusText.textContent = ready
      ? "已就绪：在 QQ 私聊里直接发消息就能聊天"
      : `还没设置完：缺少${missing.join("、")}`;
  }

  function renderCounter() {
    const max = profile ? profile.maxPersonaLength : 0;
    const length = el.persona.value.length;
    el.personaCounter.textContent = `${length} / ${max}`;
    el.personaCounter.dataset.over = length > max ? "true" : "";
  }

  function renderProfile(next, { resetForm = false } = {}) {
    profile = next;
    el.accountId.textContent = `QQ ${profile.userId}`;
    if (resetForm) {
      el.persona.value = profile.persona;
      el.baseURL.value = profile.baseURL;
      el.model.value = profile.model;
      el.apiKey.value = "";
      dirty = false;
      setMessage(el.saveMessage, "");
      setMessage(el.testMessage, "");
    }
    el.apiKey.placeholder = profile.hasApiKey ? "已保存，留空则不修改" : "sk-...";
    el.apiKeyHint.textContent = profile.hasApiKey ? `当前 Key：${profile.apiKeyHint}` : "";
    el.historyText.textContent = profile.historyRounds > 0
      ? `已保存 ${profile.historyRounds} 轮对话`
      : "还没有对话记录";
    el.clearHistory.disabled = profile.historyRounds === 0;
    renderCounter();
    renderStatus();
  }

  function markDirty() {
    dirty = true;
    setMessage(el.saveMessage, "有修改未保存");
  }

  for (const input of [el.persona, el.baseURL, el.apiKey, el.model]) {
    input.addEventListener("input", markDirty);
  }
  el.persona.addEventListener("input", renderCounter);

  el.presets.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    el.baseURL.value = chip.dataset.url;
    if (chip.dataset.model && !el.model.value.trim()) el.model.value = chip.dataset.model;
    el.modelList.replaceChildren();
    setMessage(el.modelHint, "");
    markDirty();
  });

  function draftChannel() {
    return {
      baseURL: el.baseURL.value.trim(),
      apiKey: el.apiKey.value.trim(),
      model: el.model.value.trim(),
    };
  }

  el.fetchModels.addEventListener("click", () => withBusy(el.fetchModels, async () => {
    setMessage(el.modelHint, "获取中…");
    try {
      const { models } = await api("api/models", { method: "POST", body: draftChannel() });
      el.modelList.replaceChildren(...models.map((id) => {
        const option = document.createElement("option");
        option.value = id;
        return option;
      }));
      setMessage(el.modelHint, models.length
        ? `找到 ${models.length} 个模型，点模型输入框可以选择`
        : "接口没有返回模型列表，请手动填写", models.length ? "ok" : "");
    } catch (error) {
      setMessage(el.modelHint, error.message, "error");
    }
  }));

  el.test.addEventListener("click", () => withBusy(el.test, async () => {
    setMessage(el.testMessage, "测试中…");
    try {
      const result = await api("api/test", { method: "POST", body: draftChannel() });
      if (result.ok) setMessage(el.testMessage, `连接成功：${result.reply || "（空回复）"}`, "ok");
      else setMessage(el.testMessage, `连接失败：${result.error}`, "error");
    } catch (error) {
      setMessage(el.testMessage, error.message, "error");
    }
  }));

  el.clearHistory.addEventListener("click", () => withBusy(el.clearHistory, async () => {
    if (!confirm("清空后 AI 会忘掉之前聊过的内容，确定清空吗？")) return;
    try {
      const data = await api("api/history/clear", { method: "POST" });
      renderProfile(data.profile);
      setMessage(el.saveMessage, "对话记录已清空", "ok");
    } catch (error) {
      setMessage(el.saveMessage, error.message, "error");
    }
  }));

  views.settings.addEventListener("submit", (event) => {
    event.preventDefault();
    withBusy(el.saveButton, async () => {
      if (el.persona.value.length > profile.maxPersonaLength) {
        setMessage(el.saveMessage, `人设不能超过 ${profile.maxPersonaLength} 个字`, "error");
        return;
      }
      setMessage(el.saveMessage, "保存中…");
      try {
        const data = await api("api/me", {
          method: "PUT",
          body: { persona: el.persona.value, ...draftChannel() },
        });
        renderProfile(data.profile, { resetForm: true });
        setMessage(el.saveMessage, data.personaChanged ? "已保存，人设有变化，对话记录已清空" : "已保存", "ok");
      } catch (error) {
        setMessage(el.saveMessage, error.message, "error");
      }
    });
  });

  window.addEventListener("beforeunload", (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });

  // ---- 启动 ----

  async function start() {
    const match = location.hash.match(/code=([A-Za-z0-9-]+)/);
    if (match) {
      // 登录码只能用一次，立刻从地址栏去掉，免得被转发或留在历史记录里
      history.replaceState(null, "", location.pathname + location.search);
      await login(match[1]);
      return;
    }
    if (!readToken()) {
      showLogin("");
      return;
    }
    try {
      const data = await api("api/me");
      renderProfile(data.profile, { resetForm: true });
      show("settings");
    } catch (error) {
      if (error.status !== 401) showLogin(error.message);
    }
  }

  start();
})();
