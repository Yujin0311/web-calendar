/* 第二版账户模块：登录凭证、用户独立缓存、离线写入队列。 */
(() => {
  "use strict";

  const SESSION_KEY = "qingxu-session-v2";
  const cacheKey = (id) => `qingxu-cache-v2-${id}`;
  const pendingKey = (id) => `qingxu-pending-v2-${id}`;
  const $ = (selector) => document.querySelector(selector);
  let session = null;
  let callbacks = null;
  let mode = location.pathname === "/register" ? "register" : "login";
  let queue = Promise.resolve();

  function parseStored(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function setError(message) {
    $("#auth-error").textContent = message;
    $("#auth-error").hidden = !message;
  }
  function setMode(nextMode) {
    mode = nextMode;
    $("#auth-title").textContent = mode === "register" ? "注册清序" : "登录清序";
    $("#auth-submit").textContent = mode === "register" ? "创建账户" : "登录";
    $("#auth-password").autocomplete = mode === "register" ? "new-password" : "current-password";
    $("#show-login").classList.toggle("active", mode === "login");
    $("#show-register").classList.toggle("active", mode === "register");
    setError("");
    if (location.pathname !== `/${mode}`) history.replaceState(null, "", `/${mode}`);
  }
  function showSignedOut(nextMode = mode) {
    document.body.classList.add("signed-out");
    $("#account-menu").hidden = true;
    callbacks?.onState(callbacks.initialState());
    setMode(nextMode);
  }
  function showSignedIn(data) {
    document.body.classList.remove("signed-out");
    $("#account-menu").hidden = false;
    $("#account-name").textContent = session.user.username;
    if (location.pathname !== "/") history.replaceState(null, "", "/");
    callbacks.onState(data);
  }
  async function request(path, method = "GET", body) {
    const response = await fetch(`/api${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || `请求失败（${response.status}）`), { status: response.status });
    return result;
  }
  async function upload(data, account = session) {
    // 捕获提交时的账户与令牌，避免切换账户后把旧账户队列写入新账户。
    const response = await fetch("/api/sync", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${account.token}` }, body: JSON.stringify(data) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || "同步失败。"), { status: response.status });
    if (localStorage.getItem(cacheKey(account.user.id)) === JSON.stringify(data)) localStorage.removeItem(pendingKey(account.user.id));
  }

  // 初次登录可将旧版无账户数据导入当前账户一次；其他账户不会自动看到它。
  async function loadForAccount() {
    let verifiedUser;
    try { verifiedUser = (await request("/auth/me")).user; }
    catch (error) {
      const cached = parseStored(cacheKey(session.user.id));
      if (error.status === 401) { localStorage.removeItem(SESSION_KEY); session = null; showSignedOut("login"); setError("登录已失效，请重新登录。"); return; }
      if (cached) { showSignedIn(cached); callbacks.onOffline(); return; }
      localStorage.removeItem(SESSION_KEY); session = null; showSignedOut("login"); setError("无法连接服务器，请先运行 npm start。"); return;
    }
    session.user = verifiedUser;
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    const userId = session.user.id;
    const cached = parseStored(cacheKey(userId));
    const pending = localStorage.getItem(pendingKey(userId)) === "1";
    if (pending && cached) {
      showSignedIn(cached);
      const account = session;
      queue = queue.then(() => upload(cached, account)).catch(() => {});
      return;
    }
    try {
      const remote = await request("/sync");
      let data = remote;
      if (!remote.categories?.length && !remote.tasks?.length && !remote.drafts?.length) {
        const legacy = callbacks.legacyLoader();
        const hasLegacy = legacy.tasks.length || legacy.drafts.length;
        data = hasLegacy && confirm("发现旧版浏览器计划，是否导入当前账户？") ? legacy : callbacks.initialState();
        await upload(data);
      }
      localStorage.setItem(cacheKey(userId), JSON.stringify(data));
      showSignedIn(data);
    } catch (error) {
      if (error.status === 401) { localStorage.removeItem(SESSION_KEY); session = null; showSignedOut("login"); setError("登录已失效，请重新登录。"); return; }
      if (cached) { showSignedIn(cached); callbacks.onOffline(); }
      else { localStorage.removeItem(SESSION_KEY); session = null; showSignedOut("login"); setError("无法连接服务器，请先运行 npm start。"); }
    }
  }

  async function submit(event) {
    event.preventDefault();
    setError("");
    const username = $("#auth-username").value.trim();
    const password = $("#auth-password").value;
    if (!/^[\p{L}\p{N}_-]{3,32}$/u.test(username)) { setError("账户名须为 3–32 位字母、数字、下划线或短横线。"); return; }
    if (password.length < 8 || password.length > 128) { setError("密码须为 8–128 个字符。"); return; }
    const button = $("#auth-submit");
    button.disabled = true;
    try {
      const result = await request(`/auth/${mode}`, "POST", { username, password });
      session = result;
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      $("#auth-password").value = "";
      await loadForAccount();
    } catch (error) {
      setError(error.message === "Failed to fetch" ? "无法连接服务器，请先运行 npm start。" : error.message);
    } finally { button.disabled = false; }
  }

  window.QingxuAuth = {
    isAuthenticated: () => Boolean(session?.token && session?.user?.id),
    async exportICS() {
      if (!session?.token) throw Error("请先登录。");
      const response = await fetch("/api/export/ics", { method: "POST", headers: { Authorization: `Bearer ${session.token}` } });
      if (response.status === 204) return { empty: true };
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw Error(data.error || "ICS 导出失败。"); }
      return { empty: false, text: await response.text() };
    },
    async clearExportHistory() { return request("/export/history", "DELETE"); },
    // 先写入当前用户缓存，再依次同步到服务器。断网时保留待同步标记。
    save(data) {
      if (!session?.user?.id) return false;
      const userId = session.user.id;
      const account = session;
      const snapshot = JSON.parse(JSON.stringify(data));
      localStorage.setItem(cacheKey(userId), JSON.stringify(snapshot));
      localStorage.setItem(pendingKey(userId), "1");
      queue = queue.then(() => upload(snapshot, account)).catch((error) => {
        if (error.status === 401 && session?.token === account.token) {
          localStorage.removeItem(SESSION_KEY); session = null; showSignedOut("login"); setError("登录已失效。本机改动已缓存，重新登录后会同步。");
        } else callbacks?.onOffline(error.status ? `同步失败：${error.message}` : undefined);
      });
      return true;
    },
    boot(options) {
      callbacks = options;
      $("#show-login").addEventListener("click", () => setMode("login"));
      $("#show-register").addEventListener("click", () => setMode("register"));
      $("#auth-form").addEventListener("submit", submit);
      $("#toggle-password").addEventListener("click", () => {
        const input = $("#auth-password");
        const visible = input.type === "password";
        input.type = visible ? "text" : "password";
        $("#toggle-password").textContent = visible ? "🙈" : "👁";
        $("#toggle-password").setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
        $("#toggle-password").setAttribute("aria-pressed", String(visible));
      });
      $("#logout-button").addEventListener("click", async () => {
        try { await request("/auth/logout", "POST"); } catch { /* 离线时也立刻清除本机凭证。 */ }
        localStorage.removeItem(SESSION_KEY);
        session = null;
        showSignedOut("login");
      });
      setMode(mode);
      session = parseStored(SESSION_KEY);
      if (session?.token && session?.user?.id) loadForAccount();
      else { session = null; showSignedOut(); }
      window.addEventListener("online", () => {
        if (!session?.user?.id) return;
        const pending = localStorage.getItem(pendingKey(session.user.id)) === "1";
        const cached = parseStored(cacheKey(session.user.id));
        if (pending && cached) { const account = session; queue = queue.then(() => upload(cached, account)).catch(() => {}); }
      });
    }
  };
})();
