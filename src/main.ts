import { createApp } from "vue"
import { initPaths } from "@/services/paths"
import { initConfig } from "@/services/config"

async function bootstrap(): Promise<void> {
  await initPaths()
  await initConfig()
  const { default: App } = await import("./App.vue")
  createApp(App).mount("#app")
}

void bootstrap()
