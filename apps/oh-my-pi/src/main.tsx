// Placeholder renderer entry. In Slice 3b+ this gets replaced by a copy of
// apps/desktop/src/main.tsx with the window.piApp bridge swapped for the
// Tauri adapter from src/tauri-api.ts.
import { bootstrapTauriApi } from "./tauri-api.js";

bootstrapTauriApi();

const root = document.getElementById("root");
if (root) {
	root.textContent = "oh-my-pi renderer boot stub — see plan Slice 3 follow-up.";
}
