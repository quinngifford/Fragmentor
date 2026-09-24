/**
 * The few pieces every panel is built from.
 *
 * A panel reads as three rungs and no more: the subject at the top, the
 * sections it is divided into, and the named parts of a section. Each rung has
 * its own element here so that nothing can accidentally be given a heading
 * louder than the one it sits under — which is exactly what went wrong when
 * every panel chose its own tags.
 *
 * There used to be a fourth rung, an "area" above the sections. It bought
 * nothing: on most panels it held a single section, and its heading and the
 * section's heading were drawn so alike that neither read as containing the
 * other. The sections say what they are; that is enough.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** One of the parts a panel is divided into. Everything else is appended to it. */
export function section(title: string, className?: string): HTMLElement {
  const node = el("section", className ? `section ${className}` : "section");
  node.append(el("h4", undefined, title));
  return node;
}

/** A named part of a section: a kind of port, a table, one value in a run. */
export function subsection(title: string, tone?: string): HTMLElement {
  const node = el("div", "subsection");
  node.append(el("h5", tone, title));
  return node;
}

/**
 * Draws part of a panel again without taking the cursor from whoever is
 * typing in it. The field they were in, and where in it, are found again by
 * their id in whatever `redraw` puts in its place. `scope` is what is about
 * to be drawn again; a field outside it is left alone.
 */
export function keepingFocus(scope: Element, redraw: () => void): void {
  const typing = document.activeElement;
  const field = (typing instanceof HTMLInputElement || typing instanceof HTMLTextAreaElement) && scope.contains(typing) && typing.id ? typing : null;
  const at = field && { id: field.id, start: field.selectionStart, end: field.selectionEnd, scroll: field.scrollTop };
  redraw();
  const again = at && document.getElementById(at.id);
  if (!at || !(again instanceof HTMLInputElement || again instanceof HTMLTextAreaElement)) return;
  again.focus({ preventScroll: true });
  // A checkbox has focus but no text to be in.
  if (at.start !== null) again.setSelectionRange(at.start, at.end);
  again.scrollTop = at.scroll;
}
