(() => {
  "use strict";

  const decoration = document.querySelector(".new-year-garland");
  if (!decoration) return;

  // 1 December and 9 January at midnight in Moscow (UTC+03:00).
  const start = Date.parse("2026-12-01T00:00:00+03:00");
  const end = Date.parse("2027-01-09T00:00:00+03:00");
  const lamps = [
    [9, 10, -14], [21, 14, -11], [33, 17, -7], [45, 19, -2],
    [57, 19, 2], [69, 17, 7], [81, 14, 11], [93, 9, 14],
  ];
  let timer;

  function fill() {
    for (let index = 0; index < 2; index++) {
      const strand = document.createElement("span");
      strand.className = "new-year-strand";
      for (const [x, y, angle] of lamps) {
        const lamp = document.createElement("span");
        lamp.className = "new-year-lamp";
        lamp.style.cssText = `--x:${x}%;--y:${y}px;--angle:${angle}deg`;
        strand.append(lamp);
      }
      decoration.append(strand);
    }
  }

  function update() {
    clearTimeout(timer);
    const now = Date.now();
    const active = now >= start && now < end;
    if (active && !decoration.childElementCount) fill();
    decoration.hidden = !active;
    const boundary = active ? end : start;
    if (now < boundary) timer = setTimeout(update, Math.min(boundary - now, 3_600_000));
  }

  document.addEventListener("visibilitychange", () => { if (!document.hidden) update(); });
  window.addEventListener("pageshow", update);
  update();
})();
