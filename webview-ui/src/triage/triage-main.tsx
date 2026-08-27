import React from "react";
import { createRoot } from "react-dom/client";
import { TriageApp } from "./TriageApp";
import "./triage.css";

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <TriageApp />
  </React.StrictMode>,
);
