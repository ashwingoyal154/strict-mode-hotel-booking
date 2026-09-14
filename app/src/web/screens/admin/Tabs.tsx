/**
 * Real tab semantics: a tablist of tabs with roving tabindex, arrow keys, Home and
 * End, automatic activation, and one labelled tabpanel.
 */

import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabSpec<T extends string> {
  readonly id: T;
  readonly label: string;
}

export function tabId(base: string, id: string): string {
  return `${base}-tab-${id}`;
}

export function panelId(base: string, id: string): string {
  return `${base}-panel-${id}`;
}

export function Tabs<T extends string>({
  tabs,
  selected,
  onSelect,
  label,
  idBase,
}: {
  readonly tabs: readonly TabSpec<T>[];
  readonly selected: T;
  readonly onSelect: (id: T) => void;
  readonly label: string;
  readonly idBase: string;
}): JSX.Element {
  const refs = useRef(new Map<T, HTMLButtonElement>());

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const n = tabs.length;
    if (n === 0) return;
    const at = Math.max(
      0,
      tabs.findIndex((t) => t.id === selected),
    );
    let next: number;
    switch (e.key) {
      case "ArrowRight":
        next = (at + 1) % n;
        break;
      case "ArrowLeft":
        next = (at - 1 + n) % n;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = n - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const tab = tabs[next];
    if (tab === undefined) return;
    onSelect(tab.id);
    refs.current.get(tab.id)?.focus();
  };

  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t) => {
        const on = t.id === selected;
        return (
          <button
            key={t.id}
            ref={(el) => {
              if (el === null) refs.current.delete(t.id);
              else refs.current.set(t.id, el);
            }}
            type="button"
            role="tab"
            id={tabId(idBase, t.id)}
            aria-selected={on}
            aria-controls={panelId(idBase, t.id)}
            tabIndex={on ? 0 : -1}
            className="tabs__tab"
            onClick={() => onSelect(t.id)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  idBase,
  id,
  children,
}: {
  readonly idBase: string;
  readonly id: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div role="tabpanel" id={panelId(idBase, id)} aria-labelledby={tabId(idBase, id)} tabIndex={0} className="tabpanel">
      {children}
    </div>
  );
}
