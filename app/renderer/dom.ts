/**
 * The few pieces every panel is built from.
 *
 * The inspector reads as a ladder: the subject at the top, then the areas it
 * is divided into, then the sections in each area, then the named parts of a
 * section. Each rung has its own element here so that nothing can accidentally
 * be given a heading louder than the one it sits under — which is exactly what
 * went wrong when every panel chose its own tags.
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

/** One of the areas the inspector is divided into. Sections are appended to it. */
export function group(title: string): HTMLElement {
  const node = el("section", "group");
  node.append(el("h3", "group-title", title));
  return node;
}

/** A section within an area, or on its own in a panel that has no areas. */
export function section(title: string, className?: string): HTMLElement {
  const node = el("section", className ? `section ${className}` : "section");
  node.append(el("h4", undefined, title));
  return node;
}

/** A named part of a section, such as one value in a run. */
export function subsection(title: string, tone?: string): HTMLElement {
  const node = el("div", "subsection");
  node.append(el("h5", tone, title));
  return node;
}
