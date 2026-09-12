/**
 * SkeletonCard — the geometry of OfferCard, exactly.
 *
 * It reuses the real card's classes, so every box height is driven by the same
 * font sizes and line heights. The bars are inline-block at 0.72em inside those
 * boxes, which never exceeds the line box, so a result settling into a skeleton's
 * place is a cross-fade rather than a layout jump.
 *
 * Carries no data-field and is not an offer-card: it is scaffolding, and it is
 * hidden from assistive technology because the SourceMeter announces progress.
 */

export function SkeletonCard(): JSX.Element {
  return (
    <div data-testid="skeleton-card" className="offer offer--skeleton" aria-hidden="true">
      {/* Mirrors OfferCard exactly: the thumb is a sibling in column 1, and the
          header is a plain block in the text column. */}
      <div className="offer__thumb" />

      <div className="offer__head">
        <span className="offer__commute">
          <span className="sk-bar sk-bar--commute" />
        </span>
        <span className="offer__rank">
          <span className="sk-bar sk-bar--rank" />
        </span>
        <h3 className="offer__name">
          <span className="sk-bar sk-bar--name" />
        </h3>
        <p className="offer__addr">
          <span className="sk-bar sk-bar--addr" />
        </p>
      </div>

      <div className="offer__money">
        <span className="offer__total">
          <span className="sk-bar sk-bar--total" />
        </span>
        <span className="offer__pn">
          <span className="sk-bar sk-bar--pn" />
        </span>
      </div>

      <div className="offer__verdict">
        <span className="verdict verdict--skeleton">{" ".repeat(9)}</span>
        <span className="offer__reason">
          <span className="sk-bar sk-bar--reason" />
        </span>
      </div>

      <div className="offer__chips">
        <span className="chip chip--skeleton">{" ".repeat(10)}</span>
        <span className="chip chip--skeleton">{" ".repeat(14)}</span>
      </div>
    </div>
  );
}
