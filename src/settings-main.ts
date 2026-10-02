import "./styles/fonts.css"
import { bootWindow } from "@/services/boot"

void bootWindow("settings", () => import("./components/settings/SettingsPanel.vue"))
