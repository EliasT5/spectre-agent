"use client";

/**
 * Collapsible, fullscreen-capable chat dock for the Workspaces tab (Copilot-ish).
 * Each workspace slot has its OWN set of chats — threads tagged in the DB with
 * `metadata.slot_id`. This panel lists that slot's chats, opens one in the shared
 * <ThreadChat>, and mints new ones bound to the slot. It lives INSIDE the editor
 * work area so it stays usable while the editor is fullscreened.
 *
 * Phase 1 is a plain chat (same brain/streaming as the Chats tab). Repo-aware
 * tools + the Close+PR → "to be recycled" lifecycle land in later phases.
 */

import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { ThreadChat } from "@/components/chat/ThreadChat";
import { ModelPicker } from "@/components/chat/ModelPicker";

interface PanelSlot {
  id: string;
  repo_owner: string;
  repo_name: string;
}

interface ChatRow {
  id: string;
  title: string | null;
  created_at: string;
  updated_at?: string | null;
  metadata?: { lifecycle?: string } | null;
}

const COLLAPSE_KEY = "ws-chat-collapsed";

function timeLabel(s?: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  const diffH = (Date.now() - d.getTime()) / 3_600_000;
  return diffH < 24
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function WorkspaceChatPanel({ slot }: { slot: PanelSlot }) {
  const [collapsed, setCollapsed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // null activeThreadId + view="conversation" = a blank new chat (thread minted on first send).
  const [view, setView] = useState<"list" | "conversation">("list");
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatRow[]>([]);
  const repo = `${slot.repo_owner}/${slot.repo_name}`;

  // Restore the collapsed preference once on mount.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* no storage — default expanded */
    }
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const loadChats = useCallback(async () => {
    try {
      const r = await fetch(`/api/threads?slot=${encodeURIComponent(slot.id)}`);
      if (r.ok) {
        const rows: ChatRow[] = await r.json();
        setChats(Array.isArray(rows) ? rows : []);
      }
    } catch {
      /* leave the list as-is on a transient error */
    }
  }, [slot.id]);

  // Switching slots resets the panel to that slot's chat list.
  useEffect(() => {
    setView("list");
    setActiveThreadId(null);
    void loadChats();
  }, [slot.id, loadChats]);

  const openChat = (id: string) => {
    setActiveThreadId(id);
    setView("conversation");
  };
  const newChat = () => {
    setActiveThreadId(null);
    setView("conversation");
  };

  // Mint a slot-bound thread on first send (stamps metadata the list + lifecycle rely on).
  const ensureThread = useCallback(async (): Promise<string | null> => {
    if (activeThreadId) return activeThreadId;
    try {
      const r = await fetch("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "New chat",
          metadata: { kind: "workspace", slot_id: slot.id, repo, lifecycle: "active" },
        }),
      });
      if (!r.ok) return null;
      const t = await r.json();
      setActiveThreadId(t.id);
      void loadChats();
      return t.id as string;
    } catch {
      return null;
    }
  }, [activeThreadId, slot.id, repo, loadChats]);

  if (collapsed) {
    return (
      <div className="wschat-rail">
        <button
          type="button"
          className="wschat-rail-btn"
          onClick={toggleCollapsed}
          title="Open chat"
          aria-label="Open chat"
        >
          <PanelRightOpen size={16} />
        </button>
      </div>
    );
  }

  return (
    <aside className={`wschat${fullscreen ? " fullscreen" : ""}`}>
      <header className="wschat-header">
        {view === "conversation" ? (
          <button
            type="button"
            className="wschat-hbtn"
            onClick={() => setView("list")}
            title="Back to chats"
            aria-label="Back to chats"
          >
            <ArrowLeft size={15} />
          </button>
        ) : (
          <span className="wschat-title" title={repo}>
            {slot.repo_name}
          </span>
        )}
        <div className="wschat-header-actions">
          <button
            type="button"
            className="wschat-hbtn"
            onClick={newChat}
            title="New chat"
            aria-label="New chat"
          >
            <MessageSquarePlus size={15} />
          </button>
          <button
            type="button"
            className="wschat-hbtn"
            onClick={() => setFullscreen((f) => !f)}
            title={fullscreen ? "Exit fullscreen" : "Fullscreen chat"}
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen chat"}
          >
            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button
            type="button"
            className="wschat-hbtn"
            onClick={toggleCollapsed}
            title="Collapse chat"
            aria-label="Collapse chat"
          >
            <PanelRightClose size={16} />
          </button>
        </div>
      </header>

      {view === "list" ? (
        <div className="wschat-list">
          <button type="button" className="wschat-newbtn" onClick={newChat}>
            <MessageSquarePlus size={14} /> New chat
          </button>
          {chats.length === 0 ? (
            <p className="wschat-empty">No chats yet for {slot.repo_name}. Start one.</p>
          ) : (
            <ul className="wschat-items">
              {chats.map((c) => (
                <li key={c.id}>
                  <button type="button" className="wschat-item" onClick={() => openChat(c.id)}>
                    <span className="wschat-item-title">{c.title?.trim() || "New chat"}</span>
                    <span className="wschat-item-time">{timeLabel(c.updated_at ?? c.created_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <div className="wschat-toolbar">
            <ModelPicker threadId={activeThreadId} onEnsureThread={ensureThread} />
          </div>
          <ThreadChat
            threadId={activeThreadId}
            onEnsureThread={ensureThread}
            emptyTitle={`Chat about ${slot.repo_name}`}
            emptySub="Ask about this repo, or plan a change."
          />
        </>
      )}
    </aside>
  );
}
