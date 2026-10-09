/**
 * dsh-session-delete — browser half.
 *
 * Adds one danger row to the sidebar session menu. The first click asks the
 * Host how many subagent sessions belong to the conversation; the row then
 * names that number and a second click removes the whole tree. An unanswered
 * confirmation falls back to the idle label after a few seconds.
 */
window.__ModuleLoader__.load({
  id: "dsh-session-delete",
  factory: (require) => {
    const React = require("react");
    const { MenuItemButton, IconTrashOutlineRegular } = require("@deepseek-ai/dsh-client-ui-primitives");
    const { useEffect, useRef, useState } = React;
    const h = React.createElement;

    const NS = "dsh-session-delete";
    const ENDPOINT = "/api/dsh-session-delete/purge";
    const REVERT_MS = 5000;

    const en = {
      "menu.delete": "Delete session",
      "menu.checking": "Checking…",
      "menu.confirm": "Delete permanently? This cannot be undone",
      "menu.confirmTree": "Delete permanently, with {n} subagent sessions?",
      "menu.deleting": "Deleting…",
      "menu.leftover": "Deleted; files still in use are removed on next start",
      "menu.failed": "Delete failed: {reason}"
    };
    const zh = {
      "menu.delete": "删除会话",
      "menu.checking": "检查中…",
      "menu.confirm": "永久删除？此操作不可撤销",
      "menu.confirmTree": "永久删除？将连同 {n} 个子代理会话一起删除",
      "menu.deleting": "删除中…",
      "menu.leftover": "已删除；仍被占用的文件将在下次启动时清除",
      "menu.failed": "删除失败：{reason}"
    };

    async function purge(body) {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "x-dsh-session-delete": "1" },
        body: JSON.stringify(body)
      });
      const data = await response.json().catch(() => ({}));
      return { ok: response.ok && data.ok === true, data, status: response.status };
    }

    /** Drop this browser's remembered per-session UI state for the removed ids. */
    function forgetLocalState(ids) {
      try {
        const doomed = [];
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (key === null) continue;
          const value = localStorage.getItem(key) ?? "";
          if (ids.some((id) => key.includes(id) || value.includes(id))) doomed.push(key);
        }
        doomed.forEach((key) => localStorage.removeItem(key));
      } catch { /* storage unavailable */ }
    }

    function DeleteSessionItem({ sessionId, useMenuOpenState, sessions, t }) {
      const [, setMenuOpen] = useMenuOpenState();
      const [state, setState] = useState({ step: "idle" });
      const timer = useRef(undefined);

      useEffect(() => () => clearTimeout(timer.current), []);

      const settle = (next) => {
        clearTimeout(timer.current);
        setState(next);
        timer.current = setTimeout(() => setState({ step: "idle" }), REVERT_MS);
      };
      const failed = (reason) => settle({ step: "notice", text: t("menu.failed", { reason }) });

      const askFirst = async () => {
        setState({ step: "checking" });
        try {
          const { ok, data, status } = await purge({ sessionId, dryRun: true });
          if (!ok) return failed(data.message ?? data.reason ?? String(status));
          const n = data.subagents ?? 0;
          settle({ step: "confirm", text: n > 0 ? t("menu.confirmTree", { n }) : t("menu.confirm") });
        } catch (error) {
          failed(String(error?.message ?? error));
        }
      };

      const remove = async () => {
        clearTimeout(timer.current);
        setState({ step: "deleting" });
        try {
          const { ok, data, status } = await purge({ sessionId });
          if (!ok && data.reason !== "not-found") return failed(data.message ?? data.reason ?? String(status));
          forgetLocalState([sessionId, ...(data.removed ?? []), ...(data.leftover ?? [])]);
          try { sessions?.refresh?.(); } catch { /* the next list pull converges */ }
          if ((data.leftover ?? []).length > 0) return settle({ step: "notice", text: t("menu.leftover") });
          setMenuOpen(false);
        } catch (error) {
          failed(String(error?.message ?? error));
        }
      };

      const label = {
        idle: t("menu.delete"),
        checking: t("menu.checking"),
        deleting: t("menu.deleting")
      }[state.step] ?? state.text;

      return h(MenuItemButton, {
        danger: true,
        disabled: state.step === "checking" || state.step === "deleting",
        icon: h(IconTrashOutlineRegular, { size: 14 }),
        onSelect: () => (state.step === "confirm" ? remove() : askFirst())
      }, label);
    }

    return {
      name: "dsh-session-delete-ui",
      inject: ["slots", "locale"],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-session-delete: dictionaries");
        ctx.slots.inject("sidebar.workspaces.session.menu.item", function* () {
          yield ctx.slots.register({
            name: "sidebar.workspaces.session.menu.item",
            id: "dsh-session-delete",
            order: 900,
            locale: NS,
            inject: () => ({ sessions: ctx.get("sessions") })
          }, DeleteSessionItem);
        });
      }
    };
  }
});
