import { createApp } from "vue"
import { initPaths } from "@/services/paths"
import { initConfig } from "@/services/config"
import "./styles/fonts.css"

async function bootstrap(): Promise<void> {
  await initPaths()
  await initConfig()
  const { default: SettingsPanel } = await import("./components/SettingsPanel.vue")
  createApp(SettingsPanel).mount("#app")
}

void bootstrap()
