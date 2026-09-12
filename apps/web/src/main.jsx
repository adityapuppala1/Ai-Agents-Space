import React from "react";
import { createRoot } from "react-dom/client";
// Stylesheet order is the cascade order, so it is stated here once:
// tokens, shared components, base and legacy page styles, office and dialog
// extras, consolidated pages, then the application shell. office.css loads
// with the office chunk.
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles.css";
import "./styles/experience.css";
import "./styles/pages.css";
import "./styles/shell.css";
import App from "./App.jsx";
createRoot(document.getElementById("root")).render(<App />);
