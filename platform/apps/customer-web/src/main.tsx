import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CustomerRouter } from "./app/router.js";
import { FetchCustomerApi } from "./lib/api.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CustomerRouter api={new FetchCustomerApi()} />
  </StrictMode>,
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const workerUrl = import.meta.env.DEV
      ? "/src/service-worker.ts"
      : "/service-worker.js";
    void navigator.serviceWorker.register(workerUrl, {
      scope: import.meta.env.DEV ? "/src/" : "/",
      type: "module",
    });
  });
}
