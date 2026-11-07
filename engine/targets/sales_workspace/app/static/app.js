/* Sales workspace — small progressive enhancements over plain HTML forms.
   Every form posts and redirects without JavaScript; with it, a few actions call the JSON API in place:
   pipeline stage moves, approve/reject in the queue, adding notes and tasks, completing tasks. */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const csrf = () => ($('meta[name="csrf-token"]') || {}).content || "";
  const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const newKey = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

  const ICONS = {
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7"/><path d="M12 14.5v2"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    alert: '<path d="M12 4 3 19.5h18z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  };
  function icon(name, size) {
    const span = document.createElement("span");
    span.innerHTML = `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
    return span.firstChild;
  }
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") node.className = v; else if (k === "text") node.textContent = v; else node.setAttribute(k, v);
    }
    for (const child of children) if (child !== null && child !== undefined) node.append(child);
    return node;
  }
  function initials(name) {
    const parts = String(name || "").split(/\s+/).filter((p) => /^[A-Za-z]/.test(p));
    if (!parts.length) return "?";
    return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* not JSON */ }
    if (res.status === 401) { window.location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search); }
    if (!res.ok) {
      const err = new Error((data && typeof data.detail === "string" && data.detail) || `Something went wrong (${res.status}).`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(text, isError) {
    const region = $("#toasts");
    if (!region) return;
    const node = el("div", { class: "toast" + (isError ? " is-error" : ""), role: isError ? "alert" : "status" },
      icon(isError ? "alert" : "check", 16), el("span", { text }));
    region.append(node);
    setTimeout(() => { node.style.opacity = "0"; node.style.transition = "opacity .3s"; }, isError ? 5200 : 3200);
    setTimeout(() => node.remove(), isError ? 5600 : 3600);
  }

  function ruleBanner(text, title, compact) {
    return el("div", { class: "rule-banner" + (compact ? " is-compact" : ""), role: "alert" },
      el("div", { class: "rule-icon" }, icon("lock", 20)),
      el("div", { class: "rule-body" }, el("p", { class: "rule-title", text: title }), el("p", { class: "rule-text", text })));
  }

  function setFormError(form, message) {
    const slot = $(".form-error", form);
    if (!slot) { if (message) toast(message, true); return; }
    slot.textContent = message || "";
    slot.hidden = !message;
  }

  // ------------------------------------------------------------------------------------------- keyboard & forms
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const search = $("#global-search");
    if (search) { e.preventDefault(); search.focus(); search.select(); }
  });

  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (!form.hasAttribute("data-once") || e.defaultPrevented) return;
    if (form.dataset.submitted) { e.preventDefault(); return; }
    form.dataset.submitted = "1";
    setTimeout(() => $$('button[type="submit"]', form).forEach((b) => { b.disabled = true; }), 0);
  });

  // ------------------------------------------------------------------------------------------- pipeline
  function setApprovalPill(card, status) {
    const slot = $("[data-approval]", card);
    if (!slot) return;
    slot.textContent = "";
    if (status) {
      const label = { requested: "Requested", approved: "Approved", rejected: "Rejected" }[status] || status;
      slot.append(el("span", { class: "pill pill-" + status, text: label }));
    }
  }

  function columnFor(stage) {
    return $$(".column").find((c) => c.dataset.stage === stage) || null;
  }

  function bumpColumn(column, deltaCount, deltaUsd) {
    if (!column) return;
    const count = Number(column.dataset.count || 0) + deltaCount;
    const total = Number(column.dataset.total || 0) + deltaUsd;
    column.dataset.count = String(count);
    column.dataset.total = String(total);
    $("[data-col-count]", column).textContent = String(count);
    $("[data-col-total]", column).textContent = usd0.format(Math.round(total));
    const empty = $("[data-empty-col]", column);
    if (count > 0 && empty) empty.remove();
    if (count === 0 && !empty) $("[data-cards]", column).append(el("p", { class: "column-more muted", "data-empty-col": "", text: "No deals" }));
  }

  function refreshSummary() {
    let open = 0;
    let openCount = 0;
    $$(".column").forEach((c) => {
      if (c.classList.contains("is-won") || c.classList.contains("is-lost")) return;
      open += Number(c.dataset.total || 0);
      openCount += Number(c.dataset.count || 0);
    });
    const total = $('[data-summary="open"]');
    if (total) total.textContent = usd0.format(Math.round(open));
    const count = $('[data-summary="open-count"]');
    if (count) count.textContent = String(openCount);
  }

  async function stageMove(form) {
    const card = form.closest(".deal-card");
    const select = form.elements.stage;
    const button = $("button", form);
    button.disabled = true;
    try {
      const res = await api("PATCH", "/api/deals/" + encodeURIComponent(form.dataset.id), { stage: select.value });
      const deal = res.deal;
      const events = res.rule_events || [];
      const ruleSlot = $("[data-card-rule]", card);
      ruleSlot.textContent = "";
      setApprovalPill(card, deal.approval_status);
      card.classList.toggle("is-blocked", !!res.blocked);
      const details = form.closest("details");
      if (details) details.open = false;
      if (res.blocked) {
        const blocked = events.find((ev) => ev.code === "blocked");
        const message = blocked ? blocked.message : (res.rule_messages || [])[0];
        ruleSlot.append(ruleBanner(message, "Not moved: approval needed", true));
        const pageRule = $("#page-rule");
        if (pageRule) {
          pageRule.textContent = "";
          const banner = ruleBanner(message, `${deal.name} was not moved to ${select.options[select.selectedIndex].text}`, false);
          $(".rule-body", banner).append(el("p", { class: "rule-meta", text: `It stays in ${deal.stage_label}. A sales manager on the team can approve it from the Approvals queue.` }));
          pageRule.append(banner);
          const top = banner.getBoundingClientRect().top;
          if (top < 70 || top > window.innerHeight - 80) banner.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        select.value = deal.stage;
      } else {
        const fromStage = card.dataset.stage;
        if (deal.stage !== fromStage) {
          const amount = Number(card.dataset.amountUsd || 0);
          const target = columnFor(deal.stage);
          bumpColumn(columnFor(fromStage), -1, -amount);
          card.dataset.stage = deal.stage;
          if (target) {
            $("[data-cards]", target).prepend(card);
            bumpColumn(target, 1, amount);
            card.classList.remove("is-moved");
            void card.offsetWidth;
            card.classList.add("is-moved");
          } else {
            card.remove();
          }
          refreshSummary();
        }
        events.filter((ev) => ev.code !== "blocked").forEach((ev) => toast(ev.message, true));
        toast(`${deal.name} moved to ${deal.stage_label}.`);
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      button.disabled = false;
    }
  }

  // ------------------------------------------------------------------------------------------- approvals queue
  async function approval(form) {
    const row = form.closest("tr") || form.closest(".list-row");
    const buttons = row ? $$("button", row) : $$("button", form);
    buttons.forEach((b) => { b.disabled = true; });
    const errorSlot = row ? $("[data-row-error]", row) : null;
    if (errorSlot) { errorSlot.hidden = true; errorSlot.textContent = ""; }
    try {
      const decision = form.dataset.decision;
      const res = await api("POST", "/api/deals/" + encodeURIComponent(form.dataset.id) + "/approval", { decision });
      const label = decision === "approved" ? "Approved" : decision === "rejected" ? "Rejected" : "Requested";
      if (row) {
        row.classList.add("is-done");
        const actions = $(".queue-actions", row);
        if (actions) { actions.textContent = ""; actions.append(el("span", { class: "pill pill-" + res.deal.approval_status, text: label })); }
        setTimeout(() => {
          row.remove();
          if (!$$(".queue-row").length) { const empty = $("[data-queue-empty]"); if (empty) empty.hidden = false; const table = $(".table-wrap"); if (table) table.remove(); }
        }, 1400);
      }
      [$("[data-queue-count]"), $("#nav-approvals-count")].forEach((node) => {
        if (!node) return;
        const next = Math.max(0, Number(node.textContent || 0) - 1);
        node.textContent = String(next);
        if (node.id === "nav-approvals-count" && next === 0) node.hidden = true;
      });
      toast(`${label}: ${res.deal.name}`);
    } catch (err) {
      if (errorSlot) { errorSlot.textContent = err.message; errorSlot.hidden = false; } else { toast(err.message, true); }
      buttons.forEach((b) => { b.disabled = false; });
    }
  }

  // ------------------------------------------------------------------------------------------- notes & tasks
  function bumpCount(kind, delta) {
    const chip = $(`[data-count="${kind}"]`);
    if (!chip) return;
    const n = parseInt(chip.textContent, 10) || 0;
    chip.textContent = chip.textContent.replace(/^\d+/, String(n + delta));
  }

  async function addNote(form) {
    const f = form.elements;
    const body = { subject: f.subject.value, body: f.body.value, parent_type: f.parent_type.value, parent_id: f.parent_id.value, request_key: f.request_key.value };
    if (f.contact_id && f.contact_id.value) body.contact_id = f.contact_id.value;
    const button = $('button[type="submit"]', form);
    button.disabled = true;
    setFormError(form, "");
    try {
      const res = await api("POST", "/api/notes", body);
      const n = res.note;
      const meta = el("p", { class: "note-meta" }, el("span", { class: "avatar avatar-xs", "aria-hidden": "true", text: initials(n.author_name) }), el("span", { text: n.author_name || "" }));
      if (n.contact_name) meta.append(el("span", { class: "dot-sep", text: "·" }), el("span", { class: "note-about", text: "about " + n.contact_name }));
      meta.append(el("span", { class: "dot-sep", text: "·" }), el("span", { text: "just now" }));
      const item = el("li", { class: "note is-new" },
        el("div", { class: "note-head" }, el("p", { class: "note-subject", text: n.subject }), el("time", { class: "note-time", datetime: n.created_at, text: dateFmt.format(new Date(n.created_at)) })),
        n.body ? el("p", { class: "note-body", text: n.body }) : null, meta);
      const list = $('[data-list="notes"]');
      list.prepend(item);
      const empty = $('[data-empty="notes"]');
      if (empty) empty.remove();
      bumpCount("notes", 1);
      form.reset();
      f.request_key.value = newKey();
      toast("Note added.");
    } catch (err) {
      setFormError(form, err.message);
    } finally {
      button.disabled = false;
    }
  }

  function taskItem(t) {
    const doneForm = el("form", { method: "post", action: `/tasks/${encodeURIComponent(t.id)}/complete`, "data-enhance": "task-done", "data-id": t.id, class: "task-check-form" },
      el("input", { type: "hidden", name: "csrf", value: csrf() }),
      el("input", { type: "hidden", name: "next", value: location.pathname }),
      el("button", { class: "task-check", type: "submit", title: `Mark “${t.subject}” as completed`, "aria-label": `Mark “${t.subject}” as completed` }, icon("check", 13)));
    const due = t.due_at ? "Due " + dateFmt.format(new Date(t.due_at)) : "No due date";
    const meta = el("p", { class: "task-meta" }, el("span", { class: "due" }, icon("clock", 13), " " + due));
    if (t.priority) meta.append(el("span", { class: "dot-sep", text: "·" }), el("span", { class: "priority priority-" + t.priority.toLowerCase(), text: t.priority }));
    meta.append(el("span", { class: "dot-sep", text: "·" }), el("span", { text: t.status }));
    return el("li", { class: "task", "data-task-id": t.id }, doneForm, el("div", { class: "task-main" }, el("p", { class: "task-subject", text: t.subject }), meta));
  }

  async function addTask(form) {
    const f = form.elements;
    const body = { subject: f.subject.value, parent_type: f.parent_type.value, parent_id: f.parent_id.value, request_key: f.request_key.value };
    if (f.due_at && f.due_at.value) body.due_at = f.due_at.value;
    if (f.priority && f.priority.value) body.priority = f.priority.value;
    const button = $('button[type="submit"]', form);
    button.disabled = true;
    setFormError(form, "");
    try {
      const res = await api("POST", "/api/tasks", body);
      const list = $('[data-list="tasks"]');
      list.prepend(taskItem(res.task));
      const empty = $('[data-empty="tasks"]');
      if (empty) empty.remove();
      bumpCount("tasks", 1);
      const keepPriority = f.priority ? f.priority.value : null;
      form.reset();
      if (keepPriority && f.priority) f.priority.value = keepPriority;
      f.request_key.value = newKey();
      toast("Task added.");
    } catch (err) {
      setFormError(form, err.message);
    } finally {
      button.disabled = false;
    }
  }

  async function taskDone(form) {
    const item = form.closest(".task");
    const button = $("button", form);
    button.disabled = true;
    try {
      await api("PATCH", "/api/tasks/" + encodeURIComponent(form.dataset.id), { status: "Completed" });
      if (item) {
        item.classList.add("is-done");
        form.replaceWith(el("span", { class: "task-check is-static", "aria-hidden": "true" }, icon("check", 13)));
      }
      bumpCount("tasks", -1);
      toast("Task completed.");
    } catch (err) {
      button.disabled = false;
      toast(err.message, true);
    }
  }

  const handlers = { "stage-move": stageMove, approval, note: addNote, task: addTask, "task-done": taskDone };
  document.addEventListener("submit", (e) => {
    const form = e.target.closest ? e.target.closest("form[data-enhance]") : null;
    if (!form || e.defaultPrevented || !window.fetch) return;
    const handler = handlers[form.dataset.enhance];
    if (!handler) return;
    e.preventDefault();
    handler(form);
  });
})();
