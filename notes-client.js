"use strict";

// PC 左侧便签栏。所有写操作都走当前登录用户的独立 notes API。
window.QingxuNotes = (() => {
  const panes = { left: document.querySelector("#notes-left") };
  let notes = [], accountVersion = 0;

  function message(side, text) { panes[side].querySelector(".notes-message").textContent = text; }
  function card(note) {
    const article = document.createElement("article");
    article.className = "note-card";
    article.dataset.id = note.id;
    const content = document.createElement("p");
    content.textContent = note.content; // 用户内容只用 textContent，避免注入 HTML。
    const actions = document.createElement("div");
    actions.className = "note-actions";
    for (const [action, label] of [["edit", "编辑"], ["delete", "删除"]]) {
      const button = document.createElement("button");
      button.type = "button"; button.dataset.action = action; button.textContent = label;
      button.className = action === "delete" ? "text-button danger" : "text-button";
      actions.append(button);
    }
    article.append(content, actions);
    return article;
  }
  function render() {
    for (const [side, pane] of Object.entries(panes)) {
      pane.querySelector(".notes-list").replaceChildren(...notes.map(card)); // 旧版右侧便签仍在左侧可见。
      document.querySelector("#notes-count").textContent = `${notes.length}/30`;
      pane.querySelector(".notes-add-form button").disabled = notes.length >= 30;
    }
  }
  async function accountChanged(authenticated) {
    const version = ++accountVersion;
    notes = []; render();
    message("left", "");
    if (!authenticated) return;
    try {
      const loaded = await window.QingxuAuth.listNotes();
      if (version === accountVersion) { notes = loaded; render(); }
    } catch (error) {
      if (version === accountVersion) message("left", `便签加载失败：${error.message}`);
    }
  }
  function init() {
    for (const [side, pane] of Object.entries(panes)) {
      pane.querySelector(".notes-add-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget, input = form.querySelector("textarea"), content = input.value.trim();
        if (!content) { message(side, "请先填写便签内容。"); return; }
        if ([...content].length > 250) { message(side, "单条便签最多 250 字。"); return; }
        if (notes.length >= 30) { message(side, "每个账户最多保存 30 条便签。"); return; }
        const button = form.querySelector("button"); button.disabled = true; message(side, "");
        const version = accountVersion;
        try { const created = await window.QingxuAuth.createNote(content, side); if (version === accountVersion) { notes.push(created); input.value = ""; render(); } }
        catch (error) { if (version === accountVersion) message(side, `保存失败：${error.message}`); }
        finally { button.disabled = notes.length >= 30; }
      });
      pane.querySelector(".notes-list").addEventListener("click", async (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button) return;
        const article = button.closest(".note-card");
        const note = notes.find((item) => item.id === article.dataset.id);
        if (!note) return;
        if (button.dataset.action === "delete") {
          if (!confirm("删除这条便签？")) return;
          button.disabled = true;
          const version = accountVersion;
          try { await window.QingxuAuth.deleteNote(note.id); if (version === accountVersion) { notes = notes.filter((item) => item.id !== note.id); render(); } }
          catch (error) { if (version === accountVersion) { message(side, `删除失败：${error.message}`); button.disabled = false; } }
          return;
        }
        const editor = document.createElement("textarea");
        editor.maxLength = 250; editor.rows = 5; editor.value = note.content; editor.setAttribute("aria-label", "编辑便签内容");
        const save = document.createElement("button"); save.type = "button"; save.textContent = "保存"; save.className = "button secondary";
        const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "取消"; cancel.className = "text-button";
        article.replaceChildren(editor, save, cancel); editor.focus();
        cancel.addEventListener("click", render);
        save.addEventListener("click", async () => {
          const content = editor.value.trim();
          if (!content) { message(side, "便签内容不能为空。"); return; }
          if ([...content].length > 250) { message(side, "单条便签最多 250 字。"); return; }
          save.disabled = true; message(side, "");
          const version = accountVersion;
          try { const updated = await window.QingxuAuth.updateNote(note.id, content); if (version === accountVersion) { notes = notes.map((item) => item.id === note.id ? updated : item); render(); } }
          catch (error) { if (version === accountVersion) { message(side, `修改失败：${error.message}`); save.disabled = false; } }
        });
      });
    }
  }
  return { init, accountChanged };
})();
