"use client";

import { useCallback, useEffect, useState } from "react";

const SIDEBAR_KEY = "vrhl.zijbalk";

export function useSidebar() {
  /**
   * De Workflow-zijbalk: open of weggeklapt. Op een breed scherm schuift het
   * werkgebied mee; op een smal scherm (`narrow`) ligt het eiland eroverheen en
   * begint het dicht, zodat het artikel niet tussen balk en rand wordt geperst.
   * De keuze op een breed scherm wordt onthouden.
   */
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [narrow, setNarrow] = useState(false);
  /** Pas na de eerste meting animeren, anders schuift de balk bij het laden al weg. */
  const [sidebarAnimates, setSidebarAnimates] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const measure = () => {
      setNarrow(query.matches);
      let remembered: string | null = null;
      try {
        remembered = window.localStorage.getItem(SIDEBAR_KEY);
      } catch {
        remembered = null;
      }
      setSidebarOpen(query.matches ? false : remembered !== "dicht");
    };
    measure();
    query.addEventListener("change", measure);
    const frame = window.requestAnimationFrame(() => setSidebarAnimates(true));
    return () => {
      query.removeEventListener("change", measure);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      if (!narrow) {
        try {
          window.localStorage.setItem(SIDEBAR_KEY, open ? "dicht" : "open");
        } catch {
          /* een onthouden keuze is gemak, geen noodzaak */
        }
      }
      return !open;
    });
  }, [narrow]);

  // Over het werkgebied heen (smal scherm) sluit Escape de balk.
  useEffect(() => {
    if (!narrow || !sidebarOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [narrow, sidebarOpen]);

  return { sidebarOpen, setSidebarOpen, narrow, sidebarAnimates, toggleSidebar };
}
