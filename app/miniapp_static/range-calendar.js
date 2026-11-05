/* Local, reusable range calendar. Dates are ISO calendar days, never local TZ. */
((root) => {
  "use strict";
  const addDays = (value, count) => {
    const date = new Date(`${value}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + count);
    return date.toISOString().slice(0, 10);
  };
  function selectRange(range, day, minimum) {
    if (day < minimum) return range;
    if (!range.start || range.end || day < range.start) return { start: day, end: "" };
    return { start: range.start, end: day };
  }
  function periodError(start, end, minimum, now = Date.now()) {
    if (!start || !end) return "Выберите начало и конец периода двумя нажатиями.";
    const pattern = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/;
    if (!pattern.test(start) || !pattern.test(end)) return "Выберите время начала и окончания.";
    const a = Date.parse(`${start}:00+03:00`), b = Date.parse(`${end}:00+03:00`);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return "Проверьте дату и время.";
    for (const value of [start, end]) {
      const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) return "Проверьте дату и время.";
    }
    if (start.slice(0, 10) < minimum) return "Выберите текущую или будущую дату";
    if (a < now) return "Начало аренды должно быть в будущем.";
    if (b <= a) return "Конец должен быть строго позже начала.";
    return "";
  }
  class RangeCalendar {
    constructor(element, { minimum, start = "", end = "", onChange = () => {}, onMonthChange = () => {}, isDisabled = () => false, dayNote = () => "", dayState = () => "" }) {
      this.element = element; this.minimum = minimum; this.range = { start, end }; this.onChange = onChange;
      this.isDisabled = isDisabled;
      this.dayNote = dayNote;
      this.dayState = dayState; this.onMonthChange = onMonthChange;
      this.month = `${start || minimum}`.slice(0, 7) + "-01";
      this.render();
    }
    setRange(start, end) { this.range = { start, end }; this.render(); }
    reset() { this.range = { start: "", end: "" }; this.onChange(this.range); this.render(); }
    moveMonth(amount) {
      const navigation = this.element.ownerDocument.activeElement?.getAttribute("aria-label");
      const date = new Date(`${this.month}T12:00:00Z`);
      date.setUTCMonth(date.getUTCMonth() + amount);
      this.month = date.toISOString().slice(0, 10); this.render(); this.onMonthChange();
      if (navigation) [...this.element.querySelectorAll(".calendar-nav")].find(button => button.getAttribute("aria-label") === navigation)?.focus({preventScroll: true});
    }
    refreshDays(motion = {}) {
      const buttons = [...this.element.querySelectorAll(".calendar-day")];
      const range = buttons.filter(button => this.range.start && this.range.end && button.dataset.date >= this.range.start && button.dataset.date <= this.range.end);
      const formatter = new Intl.DateTimeFormat("ru-RU", {timeZone: "UTC", day: "numeric", month: "long", year: "numeric"});
      for (const button of buttons) {
        const day = button.dataset.date, selected = day === this.range.start || day === this.range.end;
        const note = this.dayNote(day), availability = this.dayState(day);
        button.disabled = day < this.minimum || this.isDisabled(day);
        button.classList.toggle("selected", selected);
        button.classList.toggle("in-range", Boolean(this.range.start && this.range.end && day > this.range.start && day < this.range.end));
        for (const state of ["all", "partial", "none"]) button.classList.toggle(`calendar-availability-${state}`, availability === state);
        if (["all", "partial", "none"].includes(availability)) button.dataset.availability = availability;
        else delete button.dataset.availability;
        button.classList.toggle("calendar-day-busy", Boolean(note));
        button.title = note;
        button.setAttribute("aria-pressed", String(selected));
        button.setAttribute("aria-label", formatter.format(new Date(`${day}T12:00:00Z`)) + (day === this.range.start ? ", начало" : day === this.range.end ? ", конец" : "") + (note ? `, ${note}` : ""));
        if (motion.clickedDay) {
          button.classList.remove("calendar-day-pop", "calendar-day-reveal");
          if (day === motion.clickedDay && !this.element.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            button.getAnimations().forEach(animation => animation.cancel());
            button.animate([{transform: "scale(1)"}, {transform: "scale(1.08)", offset: .45}, {transform: "scale(1)"}], {duration: 180, easing: "cubic-bezier(.22, 1, .36, 1)"});
          }
          if (motion.revealRange && range.includes(button)) {
            button.style.setProperty("--range-reveal-delay", `${range.indexOf(button) * Math.min(20, 100 / Math.max(1, range.length - 1))}ms`);
            button.classList.add("calendar-day-reveal");
          }
        }
      }
    }
    render(focusDay = "", motion = {}) {
      const doc = this.element.ownerDocument;
      const key = `${this.month}|${this.minimum}`;
      if (this.renderKey === key && this.element.querySelector(".calendar-days")) {
        this.refreshDays(motion);
        if (focusDay) this.element.querySelector(`[data-date="${focusDay}"]`)?.focus({preventScroll: true});
        return;
      }
      const changingMonth = Boolean(this.renderKey);
      this.renderKey = key;
      this.element.replaceChildren();
      const header = doc.createElement("div"); header.className = "calendar-head";
      const title = doc.createElement("strong"); title.setAttribute("aria-live", "polite");
      title.textContent = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${this.month}T12:00:00Z`));
      const nav = (label, text, direction) => {
        const button = doc.createElement("button"); button.type = "button"; button.className = "calendar-nav";
        button.textContent = text; button.setAttribute("aria-label", label);
        button.disabled = direction < 0 && this.month <= this.minimum.slice(0, 7) + "-01";
        button.addEventListener("click", () => this.moveMonth(direction)); return button;
      };
      header.append(nav("Предыдущий месяц", "‹", -1), title, nav("Следующий месяц", "›", 1));
      const weekdays = doc.createElement("div"); weekdays.className = "calendar-weekdays"; weekdays.setAttribute("aria-hidden", "true");
      for (const name of ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]) { const cell = doc.createElement("span"); cell.textContent = name; weekdays.append(cell); }
      const grid = doc.createElement("div"); grid.className = "calendar-days"; grid.setAttribute("role", "group"); grid.setAttribute("aria-label", "Выбор диапазона дат");
      const first = addDays(this.month, -((new Date(`${this.month}T12:00:00Z`).getUTCDay() + 6) % 7));
      const revealDays = [];
      if (motion.revealRange && this.range.start && this.range.end) {
        for (let index = 0; index < 42; index += 1) {
          const day = addDays(first, index);
          if (day >= this.range.start && day <= this.range.end) revealDays.push(day);
        }
      }
      const revealStep = revealDays.length > 1 ? Math.min(20, 100 / (revealDays.length - 1)) : 0;
      const revealPositions = new Map(revealDays.map((day, index) => [day, index]));
      const dayFormatter = new Intl.DateTimeFormat("ru-RU", {timeZone: "UTC", day: "numeric", month: "long", year: "numeric"});
      for (let index = 0; index < 42; index += 1) {
        const day = addDays(first, index);
        const button = doc.createElement("button"); button.type = "button"; button.className = "calendar-day"; button.dataset.date = day;
        button.textContent = String(Number(day.slice(8))); button.disabled = day < this.minimum || this.isDisabled(day);
        button.classList.toggle("outside-month", day.slice(0, 7) !== this.month.slice(0, 7));
        const selected = day === this.range.start || day === this.range.end;
        button.classList.toggle("selected", selected);
        button.classList.toggle("in-range", Boolean(this.range.start && this.range.end && day > this.range.start && day < this.range.end));
        const note = this.dayNote(day);
        const availability = this.dayState(day);
        if (["all", "partial", "none"].includes(availability)) {
          button.classList.add(`calendar-availability-${availability}`);
          button.dataset.availability = availability;
        }
        button.classList.toggle("calendar-day-busy", Boolean(note));
        if (note) button.title = note;
        button.classList.toggle("calendar-day-pop", day === motion.clickedDay);
        if (revealPositions.has(day)) {
          button.classList.add("calendar-day-reveal");
          button.style.setProperty("--range-reveal-delay", `${Math.round(revealPositions.get(day) * revealStep)}ms`);
        }
        button.setAttribute("aria-pressed", String(selected));
        button.setAttribute("aria-label", dayFormatter.format(new Date(`${day}T12:00:00Z`)) + (day === this.range.start ? ", начало" : day === this.range.end ? ", конец" : "") + (note ? `, ${note}` : ""));
        button.addEventListener("click", () => {
          this.range = selectRange(this.range, day, this.minimum);
          this.onChange(this.range);
          this.render(day, { clickedDay: day, revealRange: Boolean(this.range.start && this.range.end) });
        });
        button.addEventListener("keydown", (event) => {
          const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -((index % 7)), End: 6 - (index % 7) };
          if (!(event.key in offsets)) return;
          event.preventDefault(); const next = addDays(day, offsets[event.key]);
          if (next < this.minimum) return;
          if (!grid.querySelector(`[data-date="${next}"]`)) { this.month = next.slice(0, 7) + "-01"; this.render(next); this.onMonthChange(); }
          else grid.querySelector(`[data-date="${next}"]`).focus();
        });
        button.addEventListener("animationend", () => button.classList.remove("calendar-day-pop", "calendar-day-reveal"));
        grid.append(button);
      }
      this.element.append(header, weekdays, grid);
      if (changingMonth && !doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches && typeof grid.animate === "function") {
        grid.animate([{opacity: .35, transform: "translateY(4px)"}, {opacity: 1, transform: "none"}], {duration: 180, easing: "cubic-bezier(.22, 1, .36, 1)"});
      }
      if (focusDay) grid.querySelector(`[data-date="${focusDay}"]`)?.focus({ preventScroll: true });
    }
  }
  const api = { RangeCalendar, selectRange, periodError, addDays };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PolyRentalCalendar = api;
})(typeof window === "undefined" ? globalThis : window);
