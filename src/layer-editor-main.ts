import { createApp } from "vue"
import { initPaths } from "@/services/paths"
import { initConfig } from "@/services/config"
import "./styles/fonts.css"

async function bootstrap(): Promise<void> {
  await initPaths()
  await initConfig()
  const { default: LayerEditor } = await import("./components/LayerEditor.vue")
  createApp(LayerEditor).mount("#app")
}

void bootstrap()
