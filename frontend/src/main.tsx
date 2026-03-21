// frontend/src/main.tsx
// frontend/src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Route, Routes } from "react-router-dom";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/title/:sid" element={<App />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
