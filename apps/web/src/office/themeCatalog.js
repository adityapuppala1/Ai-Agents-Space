/**
 * Office environment names and swatch colours, without the Three.js room
 * builders in themes.js, so the shell (workspace switcher, office controls)
 * can name a theme without loading the 3D bundle.
 */
export const OFFICE_THEMES = [
  ["studio", "Daylight studio", "#adc8dc"],
  ["operations", "Mission control", "#324964"],
  ["garden", "Garden atelier", "#7eac8c"],
  ["midnight", "Midnight lab", "#8371bf"],
  ["sandstone", "Desert studio", "#c79a72"],
  ["data-lab", "Data lab", "#4c9eb2"],
  ["research-library", "Research library", "#9b7952"],
  ["creative-studio", "Creative studio", "#b46186"],
];

/** A theme's name and swatch colour. An id the catalogue does not know is
 *  still shown as words ("data-lab" never reaches the screen as an id). */
export function themeLabel(id) {
  const known = OFFICE_THEMES.find(([key]) => key === id);
  if (known) return { id, label: known[1], color: known[2] };
  const words = String(id || "studio").replace(/[-_]+/g, " ");
  return {
    id,
    label: words.charAt(0).toUpperCase() + words.slice(1),
    color: "var(--line)",
  };
}
