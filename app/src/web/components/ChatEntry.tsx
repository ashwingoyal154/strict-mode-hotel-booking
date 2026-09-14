/**
 * ChatEntry — a field, not a conversation.
 *
 * One line on Search: `Or ask in a sentence`. No bubbles and no transcript. After
 * submission the product answers with a machine-voice read-back of what it
 * understood, then exactly one of:
 *   · one clarifying question, answered with a tap on a square chip — the answer
 *     is appended to the sentence and the whole sentence is parsed again; or
 *   · one `Search` button, which runs the same search the form runs.
 *
 * Chat never shows a price and never has a button that books: `/api/intent` has no
 * path to booking, and this component's only outward action is `onSearch`.
 */

import { useId, useRef, useState } from "react";
import type { ClarifyingQuestion, ParsedIntent } from "../../core/types.ts";
import { isApiError, messageOf, parseIntent, type CreateSearchBody } from "../lib/api.ts";

const MAX_CHARS = 500;

type Phase =
  | { readonly k: "idle" }
  | { readonly k: "parsing" }
  | {
      readonly k: "answered";
      readonly forText: string;
      readonly intent: ParsedIntent;
      readonly searchRequest: CreateSearchBody | null;
    }
  | { readonly k: "fault"; readonly code: string; readonly message: string };

/** The answer joins the sentence the way a person would have written it. */
export function appendAnswer(text: string, field: ClarifyingQuestion["field"], option: string): string {
  const base = text.trim().replace(/[\s.,;:]+$/, "");
  if (base.length === 0) return option;
  if (field === "anchor" && !/^(near|at|close to|in)\b/i.test(option)) return `${base} near ${option}`;
  return `${base}, ${option}`;
}

interface ChatEntryProps {
  readonly onSearch: (body: CreateSearchBody) => void;
  /** The shared search flow is running. */
  readonly searching: boolean;
}

export function ChatEntry({ onSearch, searching }: ChatEntryProps): JSX.Element {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const inputId = `${baseId}-text`;
  const questionId = `${baseId}-question`;

  const ask = async (sentence: string): Promise<void> => {
    const trimmed = sentence.trim();
    if (trimmed.length === 0) return;
    setPhase({ k: "parsing" });
    try {
      const res = await parseIntent(trimmed.slice(0, MAX_CHARS));
      setPhase({
        k: "answered",
        forText: sentence,
        intent: res.intent,
        searchRequest: res.searchRequest,
      });
    } catch (err) {
      setPhase({
        k: "fault",
        code: isApiError(err) ? err.code : "unexpected_error",
        message: messageOf(err),
      });
    }
  };

  const answer = (q: ClarifyingQuestion, option: string): void => {
    const next = appendAnswer(text, q.field, option).slice(0, MAX_CHARS);
    setText(next);
    void ask(next);
  };

  const parsing = phase.k === "parsing";
  // A read-back for a sentence that has since been edited would describe
  // something the traveller no longer said, so it is hidden rather than kept.
  const current = phase.k === "answered" && phase.forText === text ? phase : null;
  const clarification = current?.intent.clarification ?? null;

  return (
    <section className="chat" aria-label="Ask in a sentence">
      <form
        className="chat__form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(text);
        }}
      >
        <label className="label" htmlFor={inputId}>
          Or ask in a sentence
        </label>
        <div className="chat__row">
          <input
            ref={inputRef}
            id={inputId}
            className="input chat__input"
            type="text"
            autoComplete="off"
            maxLength={MAX_CHARS}
            placeholder="Near BKC Tuesday to Friday, somewhere I can walk to"
            value={text}
            aria-describedby={clarification !== null ? questionId : undefined}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="btn" disabled={parsing || text.trim().length === 0}>
            {parsing ? "Reading…" : "Ask"}
          </button>
        </div>
      </form>

      <div className="chat__answer" aria-live="polite">
        {parsing ? <p className="mono mono--muted">reading your sentence&hellip;</p> : null}

        {phase.k === "fault" ? (
          <p className="chat__fault">
            <span className="label label--blocked">{phase.code}</span>{" "}
            <span className="prose">{phase.message}</span>
          </p>
        ) : null}

        {current !== null ? (
          <>
            {current.intent.readBack.length > 0 ? (
              <p className="chat__readback">
                {current.searchRequest !== null ? "Understood" : "So far"} &middot;{" "}
                {current.intent.readBack}
              </p>
            ) : null}

            {clarification !== null ? (
              <div className="chat__clarify">
                <p className="prose" id={questionId}>
                  {clarification.question}
                </p>
                {clarification.options.length > 0 ? (
                  <div className="sq-chips" role="group" aria-labelledby={questionId}>
                    {clarification.options.map((o) => (
                      <button
                        key={o}
                        type="button"
                        className="sq-chip"
                        disabled={parsing}
                        onClick={() => answer(clarification, o)}
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn-text"
                    onClick={() => inputRef.current?.focus()}
                  >
                    Answer in the sentence above
                  </button>
                )}
              </div>
            ) : null}

            {clarification === null && current.searchRequest !== null ? (
              <div className="chat__go">
                <button
                  type="button"
                  className="btn"
                  disabled={searching}
                  onClick={() => {
                    if (current.searchRequest !== null) onSearch(current.searchRequest);
                  }}
                >
                  {searching ? "Searching…" : "Search"}
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
