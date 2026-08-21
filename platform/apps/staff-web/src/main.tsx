import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StaffRouter } from "./app/router.js";
import { FetchStaffApi } from "./lib/api.js";
import "./styles.css";

const api = new FetchStaffApi();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StaffRouter
      api={api}
      productsApi={api}
      assetsApi={api}
      contractsApi={api}
    />
  </StrictMode>,
);
