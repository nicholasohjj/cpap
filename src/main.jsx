import React from "react";
import { createRoot } from "react-dom/client";
import CpapDashboard from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <CpapDashboard />
  </React.StrictMode>
);
