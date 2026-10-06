/**
 * Navigates with a shared-element morph: `from` (the tapped thumbnail) grows into the element
 * the next page marks with data-morph="<key>". Uses the View Transitions API directly because the
 * destination pages are per-user and dynamic, so React can't render them in the same commit.
 * Browsers without the API (or with reduced motion) just navigate.
 */
export function morphNavigate(from: HTMLElement, key: string, go: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => Promise<void>) => unknown };
  if (!doc.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return go();
  from.style.viewTransitionName = "morph";
  doc.startViewTransition(async () => {
    from.style.viewTransitionName = "";
    go();
    // Wait (briefly) for the destination to render its matching element, then name it. Timers,
    // not requestAnimationFrame: frames are paused while a view transition waits on this callback.
    const deadline = Date.now() + 2500; // browsers abort the transition at about 4 s
    for (;;) {
      const to = document.querySelector<HTMLElement>(`[data-morph="${CSS.escape(key)}"]`);
      if (to) {
        to.style.viewTransitionName = "morph";
        // Clear the name after the animation so the next morph can reuse it.
        setTimeout(() => (to.style.viewTransitionName = ""), 600);
        return;
      }
      if (Date.now() > deadline) return;
      await new Promise((r) => setTimeout(r, 16));
    }
  });
}
