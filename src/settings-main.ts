import { createApp } from "vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import "./styles/fonts.css";

const app = createApp(SettingsPanel);
app.mount("#app");
