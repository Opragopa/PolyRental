# PolyRental interface changes

- Treat `/site` and `/miniapp` as two entry points to the shared interface. Verify affected screens in both, including role restrictions.
- For changes to shared frontend layout or navigation, ask the project agent `polyrental_layout` for a layout review. Run `tests/ui-layout-audit.cjs` with Chromium and WebKit. Use the commands in [the test strategy](docs/testing-strategy.md).
- Compare Management and Settings in the same session at a compact mobile width and a 16:9 desktop width. Check content width, position of the back control when switching tabs, overflow, focus and available actions.
- Run visual checks in both light and dark themes for each available interface style. Compare spacing, type hierarchy, alignment, native select styling and interactive states. Measure rendered text and control contrast over their actual surfaces.
- Verify that modal windows dim and blur the underlying view. Verify that disclosure arrows stay vertically centered in their own summary or button while the card opens and closes, including multiline headers and reduced motion.
- Identify repeated controls by their target and effect within the current workflow. Keep actions for different records and verify the remaining control still reaches the same workflow before removing a duplicate.
