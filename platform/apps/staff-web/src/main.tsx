import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StaffRouter } from "./app/router.js";
import { FetchStaffApi } from "./lib/api.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StaffRouter api={new FetchStaffApi()} />
  </StrictMode>,
);
