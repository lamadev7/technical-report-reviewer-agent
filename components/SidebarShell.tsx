"use client";
import { useEffect, useState } from "react";

const KEY = "rr.sidebar.collapsed";

export default function SidebarShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  // Read once on mount to avoid hydration mismatch.
  useEffect(() => {
    if (typeof window === "undefined") return;
    setCollapsed(window.localStorage.getItem(KEY) === "1");
  }, []);
  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try { window.localStorage.setItem(KEY, next ? "1" : "0"); } catch {}
      return next;
    });
  };
  return (
    <div className={`relative shrink-0 ${collapsed ? "w-6" : "w-64"} transition-[width] duration-150`}>
      <div className={`h-full ${collapsed ? "invisible" : "visible"}`}>
        {children}
      </div>
      <button
        onClick={toggle}
        title={collapsed ? "Show sidebar" : "Hide sidebar"}
        className={`absolute top-3 z-20 grid h-6 w-6 place-items-center rounded-full border border-zinc-200 bg-white text-xs text-zinc-600 shadow hover:bg-zinc-50 ${collapsed ? "left-1/2 -translate-x-1/2" : "right-2"}`}
      >
        {collapsed ? "›" : "‹"}
      </button>
    </div>
  );
}
