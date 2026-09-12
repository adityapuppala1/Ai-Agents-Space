// The furniture catalogue, mirrored for the browser. The server owns it
// (packages/core/src/visual/OfficeLayout.js) and refuses anything outside
// it; `tests/office-layout.test.js` fails if the two ever drift.
export const OFFICE_PROP_KINDS = Object.freeze({
  plant: { label: "Plant", radius: 0.45 },
  tree: { label: "Tree", radius: 0.6 },
  sofa: { label: "Sofa", radius: 0.95 },
  armchair: { label: "Armchair", radius: 0.6 },
  table: { label: "Low table", radius: 0.6 },
  shelf: { label: "Shelf", radius: 0.8 },
  whiteboard: { label: "Whiteboard", radius: 0.8 },
  screen: { label: "Wall screen", radius: 0.9 },
  rug: { label: "Rug", radius: 1.1 },
  lamp: { label: "Floor lamp", radius: 0.35 },
  cabinet: { label: "Cabinet", radius: 0.7 },
  water: { label: "Water cooler", radius: 0.4 },
});

/** A floor holds this many pieces (the server refuses more). */
export const MAX_OFFICE_PROPS = 24;
