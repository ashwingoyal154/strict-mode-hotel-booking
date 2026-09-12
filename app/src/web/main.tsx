import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";

import "./design/base.css";
import "./design/components.css";
import "./design/screens.css";

const host = document.getElementById("root");
if (host === null) throw new Error("#root is missing from index.html");

createRoot(host).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
