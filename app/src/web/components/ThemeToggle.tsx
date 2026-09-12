/**
 * A quiet three-state theme control. Sets `data-theme` on <html>; "auto" removes
 * the attribute and lets the token file's prefers-color-scheme block decide.
 * Both themes come from tokens — this only chooses between them.
 */

import { useEffect, useState } from "react";

type ThemeChoice = "auto" | "light" | "dark";

const KEY = "verdict.theme";
const ORDER: readonly ThemeChoice[] = ["auto", "light", "dark"];

function readStored(): ThemeChoice {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === "light" || raw === "dark" || raw === "auto") return raw;
  } catch {
    /* private window, blocked site data — fall through to auto */
  }
  return "auto";
}

function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

export function ThemeToggle(): JSX.Element {
  const [choice, setChoice] = useState<ThemeChoice>(() => readStored());

  useEffect(() => {
    applyTheme(choice);
    try {
      window.localStorage.setItem(KEY, choice);
    } catch {
      /* nothing to persist to; the in-memory choice still holds */
    }
  }, [choice]);

  const next = (): void => {
    const at = ORDER.indexOf(choice);
    setChoice(ORDER[(at + 1) % ORDER.length] ?? "auto");
  };

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={next}
      aria-label={`Theme: ${choice}. Change theme.`}
    >
      theme {choice}
    </button>
  );
}
