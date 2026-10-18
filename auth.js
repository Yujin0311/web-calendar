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
  let lockUntil = 0;
  let lockTimer = null;
  let submitting = false;

  function updateSubmitButton() {
    const button = $("#auth-submit");
    const seconds = Math.max(0, Math.ceil((lockUntil - Date.now()) / 1000));
    button.disabled = submitting || seconds > 0;
    button.textContent = seconds > 0 ? `请等待 ${seconds} 秒` : mode === "register" ? "创建账户" : "登录";
    if (!seconds && lockTimer !== null) { clearInterval(lockTimer); lockTimer = null; }
  }

  function parseStored(key) {
    try {
      const stored = localStorage.getItem(key);
      const value = JSON.parse(stored);
      if (key.startsWith("qingxu-cache-v2-") && value?.settings) {
        value.settings.timetable = window.QingxuTimetable.normalizeTimetable(value.settings.timetable);
        const upgraded = JSON.stringify(value);
        if (upgraded !== stored) {
          try { localStorage.setItem(key, upgraded); } catch { /* 存储已满时仍允许读取现有离线数据。 */ }
        }
      }
      return value;
    } catch { return null; }
  }
  function setError(message) {
    const box = $("#auth-error");
    box.textContent = message;
    box.hidden = !message;
    // 每次报错重放一次抖动动画，让提示更醒目；清空提示时不触发。
    if (message) {
      const card = $(".auth-card");
      card.classList.remove("auth-shake");
      void card.offsetWidth;
      card.classList.add("auth-shake");
    }
  }
  // 出错时把焦点送回对应输入框，并用 aria-invalid 让读屏软件也能定位问题。
  function flagField(input) {
    input.setAttribute("aria-invalid", "true");
    input.focus();
    input.select?.();
  }
  function clearFlags() {
    for (const id of ["#auth-username", "#auth-password"]) $(id).removeAttribute("aria-invalid");
  }
  function setMode(nextMode) {
    mode = nextMode;
    $("#auth-title").textContent = mode === "register" ? "注册清序" : "登录清序";
    updateSubmitButton();
    $("#auth-password").autocomplete = mode === "register" ? "new-password" : "current-password";
    // 邀请码仅注册时显示；切换到登录时清空残留输入。
    $("#invite-field").hidden = mode !== "register";
    if (mode !== "register") $("#auth-invite").value = "";
    $("#show-login").classList.toggle("active", mode === "login");
    $("#show-register").classList.toggle("active", mode === "register");
    setError("");
    clearFlags();
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
    if (!response.ok) throw Object.assign(new Error(result.error || `请求失败（${response.status}）`), { status: response.status, code: result.code, retryAfter: Number(response.headers.get("Retry-After")) || 0 });
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
    if (submitting || Date.now() < lockUntil) return;
    setError("");
    clearFlags();
    const username = $("#auth-username").value.trim();
    const password = $("#auth-password").value;
    if (!/^[\p{L}\p{N}_-]{3,32}$/u.test(username)) { setError("账户名须为 3–32 位字母、数字、下划线或短横线。"); flagField($("#auth-username")); return; }
    if (password.length < 8 || password.length > 128) { setError("密码须为 8–128 个字符。"); flagField($("#auth-password")); return; }
    const body = { username, password };
    if (mode === "register") {
      // 注册必须携带邀请码；缺失时先在本端提示，不打扰服务器。
      const inviteCode = $("#auth-invite").value.trim();
      if (!inviteCode) { setError("注册需要邀请码，请向管理员索取。"); return; }
      body.inviteCode = inviteCode;
    }
    submitting = true;
    updateSubmitButton();
    try {
      const result = await request(`/auth/${mode}`, "POST", body);
      session = result;
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      $("#auth-password").value = "";
      $("#auth-invite").value = "";
      await loadForAccount();
    } catch (error) {
      // 账号不存在 / 密码错误由服务端用 code 区分，本端给出可操作的提示并聚焦出错的那一项。
      if (error.status === 429) {
        setError(error.message);
        lockUntil = Date.now() + (error.retryAfter || 60) * 1000;
        if (lockTimer !== null) clearInterval(lockTimer);
        lockTimer = setInterval(updateSubmitButton, 250);
      }
      else if (error.code === "ACCOUNT_NOT_FOUND") { setError("账号错误，请检查账户名。"); flagField($("#auth-username")); }
      else if (error.code === "PASSWORD_INCORRECT") { setError("密码错误，请重新输入密码。"); flagField($("#auth-password")); }
      else setError(error.message === "Failed to fetch" ? "无法连接服务器，请先运行 npm start。" : error.message);
    } finally { submitting = false; updateSubmitButton(); }
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
    // 便签使用独立 API，不混入任务快照；凭证始终由此模块附加。
    listNotes() { return request("/notes"); },
    createNote(content, side) { return request("/notes", "POST", { content, side }); },
    updateNote(id, content) { return request(`/notes/${encodeURIComponent(id)}`, "PUT", { content }); },
    deleteNote(id) { return request(`/notes/${encodeURIComponent(id)}`, "DELETE"); },
    // 规划请求只返回一次性 JSON，不写入浏览器缓存。
    requestAiPlan(input) { return request("/ai-plan", "POST", input); },
    // AI 费用额度（已用金额与上限）由服务端按 token 用量累计，前端只做展示。
    aiUsage() { return request("/ai/usage"); },
    // 仅将本次图片的 data URL 交给受登录保护的解析接口，不写入本地任务缓存。
    async parseScheduleFromImage(image, timetable, signal) {
      if (!session?.token) throw Error("请先登录。");
      const response = await fetch("/api/ai/parse-schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson", Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ image, timetable }),
        signal
      });
      if (response.ok && response.headers.get("Content-Type")?.includes("application/x-ndjson")) {
        if (!response.body) throw Error("解析连接已中断，请重试。");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            pending += decoder.decode(value, { stream: !done });
            if (pending.length > 1024 * 1024) throw Error("AI 返回内容过大，请重试。");
            const lines = pending.split("\n");
            pending = lines.pop();
            if (done && pending.trim()) { lines.push(pending); pending = ""; }
            for (const line of lines) {
              if (!line.trim()) continue;
              const frame = JSON.parse(line);
              if (frame.type === "error") throw Object.assign(new Error(frame.error || "AI 解析失败，请重试。"), { status: frame.status });
              if (frame.type === "result") return frame.data;
            }
            if (done) throw Error("解析连接已中断，请重试。");
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(result.error || `AI 解析失败（${response.status}）`), { status: response.status });
      return result;
    },
    // 先写入当前用户缓存，再依次同步到服务器。断网时保留待同步标记。
    save(data, { waitForSync = false } = {}) {
      if (!session?.user?.id) return false;
      const userId = session.user.id;
      const account = session;
      const snapshot = JSON.parse(JSON.stringify(data));
      localStorage.setItem(cacheKey(userId), JSON.stringify(snapshot));
      localStorage.setItem(pendingKey(userId), "1");
      const syncing = queue.then(() => upload(snapshot, account));
      queue = syncing.catch((error) => {
        if (error.status === 401 && session?.token === account.token) {
          localStorage.removeItem(SESSION_KEY); session = null; showSignedOut("login"); setError("登录已失效。本机改动已缓存，重新登录后会同步。");
        } else callbacks?.onOffline(error.status ? `同步失败：${error.message}` : undefined);
      });
      // 图片导入等待服务端校验；断网仍保留原有离线待同步行为。
      return waitForSync ? syncing.then(() => true).catch((error) => {
        if (!error.status) return true;
        throw error;
      }) : true;
    },
    boot(options) {
      callbacks = options;
      $("#show-login").addEventListener("click", () => setMode("login"));
      $("#show-register").addEventListener("click", () => setMode("register"));
      $("#auth-form").addEventListener("submit", submit);
      // 用户重新输入时撤掉上一轮的报错标记，避免红框一直停留。
      for (const id of ["#auth-username", "#auth-password"]) {
        $(id).addEventListener("input", () => {
          $(id).removeAttribute("aria-invalid");
          if (!$("#auth-error").hidden) setError("");
        });
      }
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
