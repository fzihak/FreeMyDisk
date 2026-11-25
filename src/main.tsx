import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { GlobalErrorBoundary } from "./components/shared/GlobalErrorBoundary";
import { invoke } from "@tauri-apps/api/core";
import "./index.css";

// Global uncaught exception and promise rejection listeners
window.addEventListener("error", (event) => {
  invoke("log_frontend_exception", {
    error: event.message || "Unknown window error",
    stack: event.error?.stack || null,
  }).catch(() => {});
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  invoke("log_frontend_exception", {
    error: typeof reason === "string" ? reason : reason?.message || "Unhandled Promise Rejection",
    stack: reason?.stack || null,
  }).catch(() => {});
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <GlobalErrorBoundary>
      <App />
    </GlobalErrorBoundary>
  </React.StrictMode>,
);

